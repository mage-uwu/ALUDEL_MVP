import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const digest=b=>createHash('sha256').update(b).digest('hex'),chunkSize=384*1024;
const bytes=Buffer.concat([Buffer.from('%PDF-1.4\n'),Buffer.alloc(1300*1024,32),Buffer.from('\n%%EOF\n')]);
function fixture(suffix,{missing=false,corrupt=false,wrongHash=false,review=false}={}) {
  const hash=wrongHash?'a'.repeat(64):digest(bytes),items=[];
  for(let offset=0;offset<bytes.length;offset+=chunkSize){const chunk=bytes.subarray(offset,offset+chunkSize);items.push({kind:'source_chunk',payload:{id:hash,part:offset/chunkSize,totalBytes:bytes.length,sha256:corrupt?'b'.repeat(64):digest(chunk),data:chunk.toString('base64')}});}
  if(missing)items.pop();
  return [
    {kind:'template',payload:{id:'pdf-form',name:'Historical PDF',blocks:[{id:'date',identity:'date',label:'Date',valueKind:'date',options:[]}]}},
    {kind:'site',payload:{id:'pdf-site',address:'10 Main Street, Albany NY',clientName:'Ada Lovelace',place:null}},...items,
    {kind:'record',payload:{id:`pdf-${suffix}`,templateId:'pdf-form',siteId:'pdf-site',performedAt:'2024-01-01',values:{},origin:{file:'document.pdf',externalId:`pdf-${suffix}`,sha256:hash},
      sourceDocument:{schemaVersion:1,mediaType:'application/pdf',sha256:hash,content:'',pdf:{fileName:'document.pdf',byteLength:bytes.length,pages:2,ocrPages:[2],...(review?{reviewReason:'Page 2 needs review'}:{})}}}},
  ];
}

test('PDF originals transfer in bounded chunks, survive restarts and remain viewable in the tenant Vault', {timeout:150_000},async t=>{
  let items=fixture('first'),calls=0,blocked=false;
  const upstream=createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer pdf-secret'){res.writeHead(401);res.end();return;}
    const url=new URL(req.url,'http://local');res.setHeader('content-type','application/json');
    if(req.method==='POST'){for await(const _ of req){}res.end(JSON.stringify({jobId:`job-pdf-${++calls}`}));return;}
    if(url.pathname.endsWith('/database')){
      const start=Number(url.searchParams.get('cursor')?.split(':')[1]??0),snapshot=digest(JSON.stringify(items));
      if(blocked&&start>=3){res.writeHead(503);res.end('{}');return;}
      const end=Math.min(start+1,items.length);
      res.end(JSON.stringify({schemaVersion:1,format:'breakfast-database',jobId:url.pathname.split('/').at(-2),snapshot,start,totalItems:items.length,totalRecords:items.filter(i=>i.kind==='record').length,nextCursor:end<items.length?`${snapshot}:${end}`:null,items:items.slice(start,end)}));return;
    }
    res.end(JSON.stringify({state:'complete'}));
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>{upstream.closeAllConnections();upstream.close();});
  const worker=await build({entryPoints:['src/worker/index.ts'],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:workers']});
  const persist=await mkdtemp(join(tmpdir(),'aludel-pdf-test-'));
  const opts=convertV4MiniflareOptions({resourcePersistencePath:persist,name:'pdf-test',modules:true,script:worker.outputFiles[0].text,compatibilityDate:'2025-08-01',bindings:{BREAKFAST_KEY:'pdf-secret',BFAST_ENDPOINT:`http://127.0.0.1:${upstream.address().port}`},d1Databases:{DB:'pdf-db'},durableObjects:{VAULT:{className:'Vault',useSQLite:true},CHATS:{className:'ChatStore',useSQLite:true}}});
  let mf=new Miniflare(opts);t.after(async()=>{await mf.dispose();await rm(persist,{recursive:true,force:true});});await mf.ready;await(await mf.dispatchFetch('http://localhost/api/me')).arrayBuffer();
  const team=randomUUID(),other=randomUUID(),key='p'.repeat(43),otherKey='q'.repeat(43),db=await mf.getD1Database('DB'),now=new Date().toISOString();
  for(const [id,token]of[[team,key],[other,otherKey]]){
    const user=randomUUID();
    await db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').bind(id,'PDF tests',now).run();
    await db.prepare('INSERT INTO users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?)').bind(user,user,`${user}@example.com`,'PDF test',now).run();
    await db.prepare('INSERT INTO memberships(team_id,user_id,role,created_at) VALUES(?,?,?,?)').bind(id,user,'owner',now).run();
    await db.prepare('INSERT INTO sessions(id,user_id,created_at,last_seen,expires_at) VALUES(?,?,?,?,?)').bind(createHash('sha256').update(token).digest('base64url'),user,now,now,new Date(Date.now()+86_400_000).toISOString()).run();
  }
  const call=async(path,init={},target=team,token=key)=>{
    const res=await mf.dispatchFetch(`http://localhost/api/teams/${target}${path}`,{...init,headers:{cookie:`aludel_session=${token}`,origin:'http://localhost',...init.headers}});
    return new Response(await res.arrayBuffer(),{status:res.status,headers:res.headers});
  };
  const send=async()=>{
    const data=new FormData();data.append('files',new File([bytes],'document.pdf',{type:'application/pdf'}));const body=new Response(data);
    const res=await call('/breakfast/jobs?timezone=UTC',{method:'POST',headers:{'content-type':body.headers.get('content-type'),'x-import-id':randomUUID()},body:await body.arrayBuffer()});
    assert.equal(res.status,202);return(await res.json()).id;
  };
  const wait=async(id,predicate=j=>j.state==='complete')=>{
    const deadline=Date.now()+40_000;while(Date.now()<deadline){const job=await(await call(`/breakfast/jobs/${id}`)).json();if(predicate(job))return job;if(job.state==='failed')assert.fail(JSON.stringify(job));await new Promise(r=>setTimeout(r,200));}assert.fail('PDF import did not finish');
  };
  let reportId;
  await t.test('a >1 MiB PDF resumes its transfer and downloads byte-for-byte after restart',async()=>{
    blocked=true;const jobId=await send();await wait(jobId,j=>j.phase==='transfer'&&j.percent>=Math.floor(300/items.length));
    await mf.dispose();blocked=false;mf=new Miniflare(opts);await mf.ready;
    const job=await wait(jobId);assert.equal(job.filed,1);assert.equal(job.total,1);
    const reports=await(await call('/reports')).json();reportId=reports[0].id;
    const report=await(await call(`/reports/${reportId}`)).json();assert.equal(report.history.sourceDocument.sha256,digest(bytes));assert.equal(report.history.sourceDocument.binary,undefined);assert.deepEqual(report.doc.tasks,[]);
    const download=await call(`/reports/${reportId}/source`);assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
    const inline=await call(`/reports/${reportId}/source?inline=1`,{headers:{range:'bytes=393210-393230'}});assert.equal(inline.status,206);assert.match(inline.headers.get('content-disposition'),/^inline/);assert.equal(inline.headers.get('content-type'),'application/pdf');assert.deepEqual(Buffer.from(await inline.arrayBuffer()),bytes.subarray(393210,393231));
    assert.equal((await call(`/reports/${reportId}/source`,{headers:{range:'bytes=99999999-'}})).status,416);
    const suffix=await call(`/reports/${reportId}/source`,{headers:{range:'bytes=-7'}});assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),bytes.subarray(-7));
    assert.equal((await call(`/reports/${reportId}/source`,{},other,otherKey)).status,404);
    await mf.dispose();mf=new Miniflare(opts);await mf.ready;
    assert.deepEqual(Buffer.from(await(await call(`/reports/${reportId}/source`)).arrayBuffer()),bytes);
  });
  await t.test('PDFs held for manual review open before filing and keep their original after correction',async()=>{
    items=fixture('review',{review:true});const id=await send();assert.equal((await wait(id)).pending,1);
    const pending=await(await call(`/breakfast/jobs/${id}/pending`)).json(),seq=pending[0].seq;
    assert.deepEqual(Buffer.from(await(await call(`/breakfast/jobs/${id}/pending/${seq}/source`)).arrayBuffer()),bytes);
    assert.equal((await call(`/breakfast/jobs/${id}/pending/${seq}/source`,{},other,otherKey)).status,404);
    const sites=await(await call('/sites')).json();
    const resolved=await call(`/breakfast/jobs/${id}/pending/${seq}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({siteId:sites[0].id,date:'2024-02-02'})});assert.equal(resolved.status,200,await resolved.clone().text());
    const record=(await resolved.json()).id;assert.deepEqual(Buffer.from(await(await call(`/reports/${record}/source`)).arrayBuffer()),bytes);
  });
  await t.test('missing chunks and incorrect whole-file checksums never file a PDF',async()=>{
    // A new content hash has no previously verified copy to deduplicate against.
    for(const config of [{missing:true,wrongHash:true},{wrongHash:true}]){
      items=fixture(`invalid-${randomUUID()}`,config);const id=await send(),job=await wait(id);assert.equal(job.filed,0);assert.equal(job.pending,1);
      const pending=await(await call(`/breakfast/jobs/${id}/pending`)).json();assert.match(pending[0].reason,/missing source chunks|checksum mismatch/);
    }
  });
  await t.test('a corrupt chunk fails transfer without overwriting the existing archive',async()=>{
    items=fixture('corrupt',{corrupt:true});const job=await wait(await send(),j=>j.state==='failed');assert.equal(job.filed,0);
    assert.deepEqual(Buffer.from(await(await call(`/reports/${reportId}/source`)).arrayBuffer()),bytes);
  });
  if(process.env.BFAST_PDF_TEST_EXPORT)await t.test('real Rust-produced PDF database imports through the Worker',async()=>{
    const fixture=JSON.parse(await readFile(process.env.BFAST_PDF_TEST_EXPORT,'utf8'));items=fixture.items;
    const job=await wait(await send());assert.equal(job.total,fixture.originals.length);assert.equal(job.rejected,0);
    const reports=await(await call('/reports')).json();
    for(const original of fixture.originals){const found=reports.find(r=>r.origin?.externalId===original.id);assert.ok(found,JSON.stringify(job));assert.deepEqual(Buffer.from(await(await call(`/reports/${found.id}/source`)).arrayBuffer()),Buffer.from(original.data,'base64'));}
  });
});
