import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const built = await build({entryPoints:["src/worker/breakfast-imports.ts"],bundle:true,write:false,format:"esm",platform:"neutral"});
const { BreakfastImports } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const snapshot="a".repeat(64), jobId="11111111-1111-4111-8111-111111111111";
const oldSizeError="The processed result is too large. Split the source into smaller uploads.";

function queue(t) {
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const storage={sql:{exec(sql,...args){
    if(!args.length && sql.includes("CREATE TABLE")){db.exec(sql);return {toArray:()=>[]};}
    const rows=db.prepare(sql).all(...args);return {toArray:()=>rows};
  }},async setAlarm(){},async deleteAlarm(){},transactionSync(fn){
    db.exec("BEGIN");try{const result=fn();db.exec("COMMIT");return result;}catch(e){db.exec("ROLLBACK");throw e;}
  }};
  const imports=new BreakfastImports({storage},{BREAKFAST_KEY:"test-secret"},{});
  db.prepare(`INSERT INTO breakfast_jobs (id,team_id,user_id,user_name,name,timezone,upstream_id,state,phase,message,created_at,updated_at,next_poll)
    VALUES (?,'team','user','Uploader','combined.csv','America/New_York','job-existing','failed','failed',?,'2026-09-06','2026-09-06',0)`).run(jobId,oldSizeError);
  return {imports,db,async tick(){db.exec("UPDATE breakfast_jobs SET next_poll=0");await imports.alarm();}};
}

test("a pre-pagination size failure resumes the existing completed job",async t=>{
  const q=queue(t),requests=[];
  t.mock.method(globalThis,"fetch",async(url,init)=>{
    requests.push({url,method:init.method ?? "GET"});
    return Response.json({schemaVersion:1,jobId:"job-existing",snapshot,start:0,totalItems:1,totalRecords:1,nextCursor:null,
      items:[{kind:"rejected",payload:{record:"manual-1",error:"No site"}}]});
  });
  assert.equal(q.imports.get(jobId).resumable,true);
  assert.equal((await q.imports.resume(jobId)).phase,"transfer");
  await q.tick();await q.tick();
  assert.equal(q.imports.get(jobId).state,"complete");
  assert.equal(q.imports.get(jobId).rejected,1);
  assert.equal(requests.length,1);assert.equal(requests[0].method,"GET");
  assert.ok(requests[0].url.endsWith("/v1/pipeline/jobs/job-existing/database"));
});

test("a truncated manifest rolls back the final page and cannot start filing",async t=>{
  const q=queue(t);let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{
    const start=calls++;
    return Response.json({schemaVersion:1,jobId:"job-existing",snapshot,start,totalItems:2,totalRecords:1,
      nextCursor:start===0 ? `${snapshot}:1` : null,items:[{kind:"rejected",payload:{record:`manual-${start}`,error:"No site"}}]});
  });
  await q.imports.resume(jobId);await q.tick();await q.tick();
  const job=q.imports.get(jobId);
  assert.equal(job.state,"failed");assert.equal(job.resumable,true);assert.match(job.message,/record count/);
  const transfer=q.db.prepare("SELECT * FROM breakfast_transfers WHERE job_id=?").get(jobId);
  assert.equal(transfer.next_seq,1);assert.equal(transfer.cursor,`${snapshot}:1`);assert.equal(transfer.complete,0);
  assert.equal(q.db.prepare("SELECT COUNT(*) AS n FROM breakfast_items").get().n,1);
});

test("oversized chunked pages cancel their reader without accepting partial JSON",async t=>{
  const api=await build({entryPoints:["src/worker/breakfast-api.ts"],bundle:true,write:false,format:"esm",platform:"neutral"});
  const {breakfast}=await import(`data:text/javascript;base64,${Buffer.from(api.outputFiles[0].text).toString("base64")}`);
  let cancelled=false;
  t.mock.method(globalThis,"fetch",async()=>new Response(new ReadableStream({
    start(c){for(let i=0;i<5;i++)c.enqueue(new Uint8Array(256*1024));},cancel(){cancelled=true;}
  })));
  await assert.rejects(()=>breakfast({BREAKFAST_KEY:"test-secret"},"/v1/pipeline/jobs/job-existing/database"),e=>e.status===422);
  assert.equal(cancelled,true);
});

test("a native row that grows past the filing limit pauses transfer instead of discarding its values",async()=>{
  const plan=await build({entryPoints:["src/worker/import-plan.ts"],bundle:true,write:false,format:"esm",platform:"neutral"});
  const {mapRecord}=await import(`data:text/javascript;base64,${Buffer.from(plan.outputFiles[0].text).toString("base64")}`);
  const values=Object.fromEntries(Array.from({length:32},(_,i)=>[`f${i}`,"x".repeat(3840)]));
  const source={id:"record:large",templateId:"format-1",siteId:"site-1",date:"2026-01-01",values,origin:{file:"large.csv",externalId:"large"},siteBinding:{status:"bound"}};
  const template={id:"template",blocks:Object.fromEntries(Object.keys(values).map((key,i)=>[key,{id:`11111111-1111-4111-8111-${String(i).padStart(12,"0")}`,kind:"text"}]))};
  assert.ok(Buffer.byteLength(JSON.stringify(source))<128*1024);
  assert.throws(()=>mapRecord(source,template,"site","UTC"),/database record exceeds 120 KiB/);
  assert.equal(Object.values(source.values).join("").length,32*3840);
});
