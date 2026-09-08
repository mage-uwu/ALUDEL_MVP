import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const teamA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const teamB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const secret = "test-breakfast-secret";
const hash = s => createHash("sha256").update(s).digest("base64url");
const original = content => ({schemaVersion:1,mediaType:"application/json",content,sha256:createHash("sha256").update(content).digest("hex")});

function fixture({ extra = false, badDate = false } = {}) {
  const nodes = [
    { id: "template:template_01", kind: "template", properties: { displayName: "Service visit" } },
    { id: "site:1", kind: "site", properties: { address: "10 Main Street, Albany, NY" } },
    { id: "employee:1", kind: "employee", properties: { name: "Sam@example.com" } },
  ], edges = [];
  const fields = [
    ["date_of_service", "Date", "date", badDate ? "not a date" : "7/1/2024"],
    ["time_of_service", "Time", "time", "14:00"],
    ["account_id", "Account ID", "identifier", "00123"],
    ["temperature", "Temperature", "number", 38.5],
    ["outcome", "Outcome", "choice", "PASS"],
  ];
  if (extra) fields.push(["notes", "Notes", "text", "Replaced valve"]);
  const edge = (source, target, kind) => edges.push({ source, target, kind });
  for (const [labelId, displayName, valueKind] of fields) {
    nodes.push({ id: `block:${labelId}`, kind: "block", properties: { labelId, displayName, conceptDisplayName: displayName, valueKind, ...(valueKind === "choice" ? { choiceOptions: ["PASS", "FAIL"] } : {}) } });
    edge("template:template_01", `block:${labelId}`, "defines_block");
  }
  for (let i = 1; i <= 2; i++) {
    const id = `record:${i}`;
    nodes.push({ id, kind: "record", properties: { reportId: `visit-${i}`, externalId: `visit-${i}`, sourcePath: "visits.csv", sha256: "a".repeat(64) } });
    edge(id, "template:template_01", "instance_of"); edge(id, "site:1", "at_site"); edge(id, "employee:1", "performed_by");
    for (const [labelId, , , value] of fields) {
      const f = `${id}:fact:${labelId}`;
      nodes.push({ id: f, kind: "fact", properties: { labelId, value } });
      edge(id, f, "has_fact"); edge(f, `block:${labelId}`, "uses_block");
    }
  }
  return { nodes, edges };
}

const graphBuild = await build({ entryPoints: ["src/worker/graph-import.ts"], bundle: true, write: false, format: "esm", platform: "neutral" });
const { planGraph, paperTime } = await import(`data:text/javascript;base64,${Buffer.from(graphBuild.outputFiles[0].text).toString("base64")}`);
const transferBuild = await build({ entryPoints: ["src/worker/import-transfer.ts"], bundle: true, write: false, format: "esm", platform: "neutral" });
const { readTransferPage, planTransferPage } = await import(`data:text/javascript;base64,${Buffer.from(transferBuild.outputFiles[0].text).toString("base64")}`);

// Small producer fixture: catalogs precede records, including across page boundaries.
function transferFixture(graph) {
  const blocks = graph.nodes.filter(n=>n.kind==="block");
  return [
    {kind:"template",payload:{id:"template:template_01",name:"Service visit",blocks:blocks.map(b=>({id:b.id,label:b.properties.displayName,valueKind:b.properties.valueKind,options:b.properties.choiceOptions ?? []}))}},
    {kind:"site",payload:{id:"site:1",address:"10 Main Street, Albany, NY",clientName:graph.nodes.find(n=>n.kind==="record").properties.semantics?.client.name ?? "",place:null}},
    ...graph.nodes.filter(n=>n.kind==="record").map(r=>{
      const facts=graph.nodes.filter(n=>n.kind==="fact"&&n.id.startsWith(`${r.id}:fact:`));
      return {kind:"record",payload:{id:r.id,templateId:"template:template_01",siteId:"site:1",
        origin:{file:"visits.csv",externalId:r.properties.externalId,sha256:r.properties.sha256,page:1},
        semantics:r.properties.semantics,date:facts.find(n=>n.properties.labelId==="date_of_service").properties.value,clock:"14:00",byName:"Sam@example.com",
        values:Object.fromEntries(facts.map(f=>[`block:${f.properties.labelId}`,f.properties.value]))}};
    }),
  ];
}
function transferPage(items,jobId,start=0,size=2) {
  const snapshot=createHash("sha256").update(JSON.stringify(items)).digest("hex");
  let end=start,bytes=4096;
  while(end<items.length && end-start<size && bytes+Buffer.byteLength(JSON.stringify(items[end]))+1<=1024*1024) bytes+=Buffer.byteLength(JSON.stringify(items[end++]))+1;
  return {schemaVersion:1,jobId,snapshot,start,totalItems:items.length,totalRecords:items.filter(i=>["record","rejected"].includes(i.kind)).length,
    nextCursor:end<items.length ? `${snapshot}:${end}` : null,items:items.slice(start,end)};
}

test("paged projection preserves graph mapping, rejects missing catalogs and inconsistent cursors",async()=>{
  for(const graph of [fixture(),fixture({badDate:true}),fixture({extra:true}),resolvedFixture(),resolvedFixture(null)]) {
    const source=transferFixture(graph),catalog=new Map(),plan=[];let previous;
    do {
      const page=readTransferPage(transferPage(source,"job-paged",previous?.next_seq),"job-paged",previous);
      const mapped=await planTransferPage(page,teamA,"job-paged","America/New_York",(kind,id)=>catalog.get(`${kind}:${id}`));
      for(const c of mapped.catalog)catalog.set(`${c.kind}:${c.source}`,c.mapping);
      plan.push(...mapped.items);
      previous={snapshot:page.snapshot,next_seq:page.start+page.items.length,total_items:page.totalItems,total_records:page.totalRecords,cursor:page.nextCursor};
    } while(previous.cursor);
    assert.deepEqual(plan,await planGraph(graph,teamA,"job-paged","America/New_York"));
  }
  const source=transferFixture(fixture()),first=transferPage(source,"job-paged");
  assert.throws(()=>readTransferPage({...first,nextCursor:null},"job-paged"),/sequence/);
  assert.throws(()=>readTransferPage({...first,jobId:"job-other"},"job-paged"),/Invalid/);
  const previous={snapshot:first.snapshot,next_seq:2,total_items:4,total_records:2};
  assert.throws(()=>readTransferPage(first,"job-paged",previous),/sequence/);
  assert.throws(()=>readTransferPage({...transferPage(source,"job-paged",2),snapshot:"b".repeat(64)},"job-paged",previous),/sequence/);
  await assert.rejects(()=>planTransferPage(transferPage(source,"job-paged",2),teamA,"job-paged","America/New_York",()=>undefined),/missing template or site/);
});

test("graph mapping preserves typed values, dates, and identity without mixing unrelated schemas", async () => {
  const a = await planGraph(fixture(), teamA, "job-a", "America/New_York");
  const again = await planGraph(fixture(), teamA, "job-b", "America/New_York");
  assert.deepEqual(a, again);
  const other = await planGraph(fixture(), teamB, "job-c", "America/New_York");
  assert.notEqual(a[0].payload.id, other[0].payload.id);
  const changed = await planGraph(fixture({ extra: true }), teamA, "job-d", "America/New_York");
  assert.notEqual(a[0].payload.id, changed[0].payload.id);
  const blocks = a[0].payload.tasks.flatMap(t => t.blocks);
  const rec = a.find(i => i.kind === "record").payload;
  assert.equal(rec.performedAt, "2024-07-01T18:00:00.000Z");
  assert.equal(rec.history.receivedValues["block:account_id"], "00123");
  assert.equal(rec.history.receivedValues["block:temperature"], 38.5);
  assert.deepEqual(blocks.find(b => b.label === "Outcome").options, ["PASS", "FAIL"]);
  assert.equal(rec.origin.externalId, "visit-1");
  assert.equal((await planGraph(fixture({ badDate: true }), teamA, "job-e", "America/New_York")).filter(i => i.kind === "pending").length, 2);
  assert.equal(paperTime("1/17/2024", "2:30 PM", "America/New_York"), "2024-01-17T19:30:00.000Z");
  assert.equal(paperTime("2024-07-01", "00:30", "America/New_York"), "2024-07-01T04:30:00.000Z");
  assert.equal(paperTime("2/30/2024", "12:00", "America/New_York"), null);
  assert.equal(paperTime("3/10/2024", "02:30", "America/New_York"), null);
});

test("real Worker + D1 + SQLite Durable Object import handshake", { timeout: 240_000 }, async t => {
  let uploads = 0, mode = "ok", graph = fixture(), pollFailures = 0, pageSize=2, largeItems=null;
  const pageCalls=[];
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      uploads++;
      if (mode === "busy") { res.writeHead(429, { "retry-after": "5" }); res.end('{"error":"busy"}'); return; }
      if (mode === "disconnect") { req.socket.destroy(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      assert.match(req.headers["content-type"], /multipart\/form-data; boundary=/);
      assert.match(Buffer.concat(chunks).toString(), /visits\.csv/);
      assert.equal(url.searchParams.get("timezone"), "America/New_York");
      assert.equal(url.searchParams.get("transmute"), "false");
      res.writeHead(202); res.end(JSON.stringify({ jobId: `job-test-${uploads}`, reviewSessionToken: "must-not-reach-client" }));
    } else if (url.pathname.endsWith("/graph")) { assert.fail("The import queue must not download the full graph"); }
    else if ((url.pathname.endsWith("/import") || url.pathname.endsWith("/database"))) {
      const cursor=url.searchParams.get("cursor"),start=Number(cursor?.split(":")[1] ?? 0),jobId=url.pathname.split("/").at(-2);
      pageCalls.push({jobId,cursor,start});
      if(start && mode==="page-fail") {res.writeHead(422);res.end('{}');return;}
      if(start && mode==="page-busy") {res.writeHead(503);res.end('{}');return;}
      const page=transferPage(largeItems ?? transferFixture(graph),jobId,start,pageSize);
      if(cursor && cursor!==`${page.snapshot}:${start}`) {res.writeHead(409);res.end('{}');return;}
      res.end(JSON.stringify(page));
    }
    else if (pollFailures-- > 0) { res.writeHead(503); res.end('{}'); }
    else res.end(JSON.stringify({ state: "complete", percent: 100, phase: "complete" }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const worker = await build({ entryPoints: ["src/worker/index.ts"], bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:workers"] });
  const persist = await mkdtemp(join(tmpdir(), "aludel-import-test-"));
  const runtimeOptions = convertV4MiniflareOptions({ resourcePersistencePath: persist, name: "aludel-test", modules: true, script: worker.outputFiles[0].text, compatibilityDate: "2025-08-01",
    bindings: { BREAKFAST_KEY: secret, BFAST_ENDPOINT: `http://127.0.0.1:${upstream.address().port}` },
    d1Databases: { DB: "test-db" }, durableObjects: { VAULT: { className: "Vault", useSQLite: true }, CHATS: { className: "ChatStore", useSQLite: true } },
  });
  let mf = new Miniflare(runtimeOptions);
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  await mf.ready;
  // A harmless request initializes the exact application schema.
  await mf.dispatchFetch("http://localhost/api/me");
  let db = await mf.getD1Database("DB");
  const tokenA = "a".repeat(43), tokenB = "b".repeat(43);
  for (const [team, token] of [[teamA, tokenA], [teamB, tokenB]]) {
    await db.prepare("INSERT INTO teams (id,name,created_at) VALUES (?,?,?)").bind(team, team, new Date().toISOString()).run();
    await db.prepare("INSERT INTO tokens (id,team_id,name,created_by,created_at) VALUES (?,?,?,?,?)").bind(hash(token), team, "Import test", "test", new Date().toISOString()).run();
  }
  const call = async (team, path = "", init = {}, token = tokenA) => {
    const response = await mf.dispatchFetch(`http://localhost/api/teams/${team}/breakfast/jobs${path}`, { ...init, headers: { authorization: `Bearer aludel_${token}`, ...init.headers } });
    // Fully drain the runtime's response, even when a test only checks status.
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
  };
  const send = async (id = randomUUID()) => {
    const form = new FormData(); form.append("files", new File(["id,value\n1,38.5"], "visits.csv", { type: "text/csv" }));
    const body = new Response(form);
    return call(teamA, "?timezone=America%2FNew_York&name=visits.csv", { method: "POST", headers: { "content-type": body.headers.get("content-type"), "x-import-id": id }, body: await body.arrayBuffer() });
  };
  const waitFor = async (id, states = ["complete"], predicate=()=>true, timeout=35_000) => {
    assert.ok(id, "Missing local job ID");
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const res = await call(teamA, `/${id}`), job = await res.json();
      if (states.includes(job.state) && predicate(job)) return job;
      if (job.state === "failed") assert.fail(JSON.stringify(job));
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.fail(`Import ${id} did not reach ${states}`);
  };
  await t.test("auth, CSRF, and team ownership block access before the job namespace", async () => {
    assert.equal((await mf.dispatchFetch(`http://localhost/api/teams/${teamA}/breakfast/jobs`)).status, 401);
    assert.equal((await mf.dispatchFetch(`http://localhost/api/teams/${teamA}/breakfast/jobs`, { method: "POST", headers: { origin: "https://attacker.example" } })).status, 403);
    assert.equal((await call(teamB)).status, 404);
    const res = await call(teamB, "", {}, tokenB); assert.equal(res.status, 200);
    const config = await res.json(); assert.equal(config.configured, true); assert.deepEqual(config.jobs, []);
  });
  let imported;
  await t.test("upload, replay suppression, transient polling recovery, and automatic filing", async () => {
    const id = randomUUID(); pollFailures = 1;
    const res = await send(id); const accepted = await res.json(); assert.equal(res.status, 202, JSON.stringify(accepted));
    assert.equal(accepted.state, "processing", JSON.stringify(accepted));
    assert.ok(!JSON.stringify(accepted).includes(secret)); assert.ok(!JSON.stringify(accepted).includes("must-not-reach-client"));
    assert.equal((await send(id)).status, 202); assert.equal(uploads, 1);
    assert.equal((await call(teamB, `/${id}`, {}, tokenB)).status, 404);
    imported = await waitFor(id); assert.equal(imported.filed, 2); assert.equal(imported.rejected, 0);
    const reports = await mf.dispatchFetch(`http://localhost/api/teams/${teamA}/reports`, { headers: { authorization: `Bearer aludel_${tokenA}` } });
    assert.equal((await reports.json()).length, 2);
    const query = await mf.dispatchFetch(`http://localhost/api/teams/${teamA}/vault/query`, { method: "POST", headers: { authorization: `Bearer aludel_${tokenA}`, "content-type": "application/json" }, body: JSON.stringify({ select: { agg: "count" } }) });
    assert.equal((await query.json()).groups[0].value, 2);
  });
  await t.test("a second upload reuses templates/sites and recognizes filed records", async () => {
    const res = await send(); const job = await res.json();
    const done = await waitFor(job.id); assert.equal(done.duplicates, 2); assert.equal(done.filed, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM templates WHERE team_id = ?").bind(teamA).first()).n, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sites WHERE team_id = ?").bind(teamA).first()).n, 1);
  });
  await t.test("a failed result page resumes at its saved cursor without reuploading",async()=>{
    mode="page-fail";
    const pending=await (await send()).json(),count=uploads;
    const paused=await waitFor(pending.id,["failed"]);
    assert.equal(paused.resumable,true);assert.equal(paused.total,2);assert.equal(paused.filed,0);assert.equal(paused.phase,"transfer");
    mode="ok";
    assert.equal((await call(teamA,`/${pending.id}/resume`,{method:"POST"})).status,200);
    assert.equal((await waitFor(pending.id)).duplicates,2);assert.equal(uploads,count);
    assert.deepEqual(pageCalls.filter(c=>c.jobId===`job-test-${count}`).map(c=>c.start),[0,2,2]);
  });
  await t.test("a changed snapshot restarts staging before any records file",async()=>{
    mode="page-fail";
    const pending=await (await send()).json(),count=uploads;
    await waitFor(pending.id,["failed"]);
    graph=fixture({extra:true});mode="ok";
    // These are new records. Reusing an archived ID with changed content is a
    // separate manual-review case, not a successful duplicate import.
    graph.nodes.filter(n=>n.kind==="record").forEach(n=>{n.properties.externalId += "-snapshot";});
    await call(teamA,`/${pending.id}/resume`,{method:"POST"});
    const completed=await waitFor(pending.id);assert.equal(completed.filed+completed.duplicates,2);assert.equal(completed.rejected,0);
    assert.deepEqual(pageCalls.filter(c=>c.jobId===`job-test-${count}`).map(c=>c.start),[0,2,2,0,2]);
    graph=fixture();
  });
  await t.test("explicit busy rejection and uncertain uploads are never automatically resubmitted", async () => {
    const before = uploads;
    const invalid = await call(teamA, "?timezone=America%2FNew_York", {method:"POST",headers:{"content-type":`multipart/form-data; boundary=${"b".repeat(201)}`,"x-import-id":randomUUID()},body:"invalid multipart"});
    assert.equal(invalid.status,500);assert.equal((await invalid.json()).job.state,"failed");assert.equal(uploads,before);
    mode = "busy";
    const busy = await send(); assert.equal(busy.status, 429); assert.equal(busy.headers.get("retry-after"), "5");
    mode = "disconnect";
    const lost = await send(); assert.equal(lost.status, 202); assert.equal((await lost.json()).state, "uncertain");
    const count = uploads; await new Promise(resolve => setTimeout(resolve, 2500)); assert.equal(uploads, count);
    mode = "ok";
  });
  await t.test("bad records are reported, not silently filed with invented dates", async () => {
    graph = fixture({ badDate: true });
    const job = await (await send()).json();
    const done = await waitFor(job.id); assert.equal(done.pending, 2); assert.equal(done.rejected, 0); assert.equal(done.errors.length, 2);
  });
  await t.test("jobs, records, and pending alarms survive a runtime restart", async () => {
    graph = fixture();mode="page-busy";
    const pending = await (await send()).json();
    const upstreamId=`job-test-${uploads}`;
    await waitFor(pending.id,["processing"],j=>j.phase==="transfer"&&j.percent===50);
    await mf.dispose();
    mode="ok";
    mf = new Miniflare(runtimeOptions);
    await mf.ready; db = await mf.getD1Database("DB");
    const response = await call(teamA, `/${imported.id}`); const job = await response.json();
    assert.equal(response.status, 200, JSON.stringify(job));
    assert.equal(job.state, "complete", JSON.stringify(job)); assert.equal(job.filed, 2);
    const completed = await waitFor(pending.id); assert.equal(completed.duplicates, 2);
    assert.equal(pageCalls.filter(c=>c.jobId===upstreamId&&c.start===0).length,1,"catalog page must not be fetched again after restart");
  });
  await t.test("aggregate results above the old 16 MiB ceiling transfer and file in bounded pages",async()=>{
    const source=transferFixture(resolvedFixture()),record=source[2];
    const notes=Object.fromEntries(Array.from({length:20},(_,i)=>[`block:notes-${i}`,"x".repeat(3500)]));
    source[0].payload.blocks.push(...Object.keys(notes).map((id,i)=>({id,label:`Notes ${i}`,valueKind:"text",options:[]})));
    largeItems=[...source.slice(0,2),...Array.from({length:256},(_,i)=>({kind:"record",payload:{...structuredClone(record.payload),id:`record:large-${i}`,
      origin:{...record.payload.origin,externalId:`large-${i}`},values:{...record.payload.values,...notes}}}))];
    assert.ok(Buffer.byteLength(JSON.stringify(largeItems))>16*1024*1024);
    pageSize=256;
    const pending=await (await send()).json(),upstreamId=`job-test-${uploads}`;
    const complete=await waitFor(pending.id,["complete"],()=>true,90_000);
    assert.equal(complete.total,256);assert.equal(complete.filed,256);assert.equal(complete.rejected,0);
    assert.ok(pageCalls.filter(c=>c.jobId===upstreamId).length>16);
    largeItems=null;pageSize=2;
  });
  await t.test("native database: 60 repairs create one template and four stacks; retries preserve customized objects",async()=>{
    const person={name:null,firstName:null,lastName:null,emails:[],phones:[]};
    const sourceTemplate={kind:"template",payload:{id:"format-1",name:"Native repair report",sortStatus:"learned",blocks:[
      {id:"notes",identity:"repair_notes",label:"Repair notes",valueKind:"text",options:[],unit:""},
      {id:"pressure",identity:"pressure",label:"Pressure",valueKind:"number",options:[],unit:"psi"},
      {id:"outcome",identity:"outcome",label:"Outcome",valueKind:"choice",options:["PASS","FAIL"],unit:""}
    ]}};
    const sourceSites=Array.from({length:4},(_,i)=>({kind:"site",payload:{id:`native-site-${i}`,sourceAddress:`${5100+i} Native Lane`,address:`${5100+i} Native Lane`,clientName:`Native Client ${i}`,place:null}}));
    const record=(i,siteId=sourceSites[i%4].payload.id)=>({kind:"record",payload:{id:`record:native-${i}`,templateId:"format-1",siteId,
      values:{notes:`Repaired valve ${i}`,pressure:42+i,outcome:"PASS"},
      sourceDocument:original(JSON.stringify({report_id:`native-${i}`,notes:`  Repaired valve ${i}  `,pressure:42+i,outcome:"PASS",extra:null})),
      semantics:{schemaVersion:1,client:{...person,name:`Native Client ${i%4}`,emails:[`client${i%4}@example.com`],phones:[`(570) 555-010${i%4}`]},employee:{...person,name:"Repair Worker",emails:["crew@example.com"],phones:["5705550998"]},user:{...person,emails:["uploader@example.com"],phones:["5705550999"]},date:{value:"2026-01-01",precision:"date"},serviceAddresses:[`${5100+i%4} Native Lane`]},
      origin:{file:"repairs.csv",externalId:`native-${i}`},siteBinding:{status:siteId?"bound":"manual_sort",reason:siteId?"corroborated_identity":"insufficient_corroboration"},sortDecision:{status:"learned"}
    }});
    largeItems=[sourceTemplate,...sourceSites,...Array.from({length:60},(_,i)=>record(i))];pageSize=32;
    const first=await (await send()).json(),completed=await waitFor(first.id);
    assert.equal(completed.filed,60);assert.equal(completed.pending,0);
    const templates=(await db.prepare("SELECT * FROM templates WHERE team_id=? AND name=?").bind(teamA,"Native repair report").all()).results;
    assert.equal(templates.length,1);const template=templates[0],doc=JSON.parse(template.doc);
    const sites=(await db.prepare("SELECT * FROM sites WHERE team_id=? AND client_name LIKE 'Native Client %' ORDER BY client_name").bind(teamA).all()).results;
    assert.equal(sites.length,4);
    for (const [i, site] of sites.entries()) {
      assert.equal(site.address, `${5100+i} Native Lane`);
      assert.deepEqual(JSON.parse(site.emails), [`client${i}@example.com`]);
      assert.deepEqual(JSON.parse(site.phones), [`(570) 555-010${i}`]);
    }
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE template_id=?").bind(template.id).first()).n,4);
    for(const site of sites) assert.equal((await mf.dispatchFetch(`http://localhost/api/teams/${teamA}/reports?site=${site.id}&template=${template.id}&limit=100`,{headers:{authorization:`Bearer aludel_${tokenA}`}}).then(r=>r.json())).length,15);
    const custom={tasks:[{...doc.tasks[0],name:"Our repair checklist",blocks:doc.tasks[0].blocks.map(b=>b.kind==="buttons"?{...b,options:[...b.options,"RECHECK"]}:b)}]};
    await db.prepare("UPDATE templates SET name=?,doc=?,version=2 WHERE id=?").bind("Our customized repair report",JSON.stringify(custom),template.id).run();
    await db.prepare("UPDATE sites SET client_name=?,emails=?,position=9 WHERE id=?").bind("Our existing client",'["verified@example.com"]',sites[0].id).run();
    // Batch-local format/field IDs and LLM display wording may change. Stable
    // field identities still reuse the existing template and its custom tasks.
    largeItems=structuredClone(largeItems);largeItems[0].payload.id="format-9";
    largeItems[0].payload.name="Different LLM wording";
    largeItems[0].payload.blocks.forEach(b=>{b.label=`Renamed ${b.label}`;});
    for(let i=0;i<4;i++)largeItems[i+1].payload.id=sites[i].id;
    largeItems.filter(i=>i.kind==="record").forEach((r,i)=>{r.payload.templateId="format-9";r.payload.siteId=sites[i%4].id;});
    const repeated=await waitFor((await (await send()).json()).id);assert.equal(repeated.duplicates,60);assert.equal(repeated.filed,0);
    assert.deepEqual(JSON.parse((await db.prepare("SELECT doc FROM templates WHERE id=?").bind(template.id).first()).doc),custom);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE template_id=?").bind(template.id).first()).n,4);
    assert.equal((await db.prepare("SELECT client_name FROM sites WHERE id=?").bind(sites[0].id).first()).client_name,"Our existing client");
    assert.equal((await db.prepare("SELECT emails FROM sites WHERE id=?").bind(sites[0].id).first()).emails,'["verified@example.com"]');
    // An unresolved record survives independently of Breakfast, with a true
    // unknown date, and can later be filed into an existing site/template.
    const manual=record(100,null);manual.payload.semantics.date=null;
    largeItems=[sourceTemplate,manual];
    const pending=await waitFor((await (await send()).json()).id);assert.equal(pending.pending,1);assert.equal(pending.rejected,0);
    const list=await call(teamA,`/${pending.id}/pending`).then(r=>r.json());assert.equal(list.length,1);
    let detail=await call(teamA,`/${pending.id}/pending/${list[0].seq}`).then(r=>r.json());
    assert.equal(JSON.parse(detail.history.sourceDocument.content).notes,"  Repaired valve 100  ");assert.equal(detail.semantics.date,null);
    await mf.dispose();mf=new Miniflare(runtimeOptions);await mf.ready;db=await mf.getD1Database("DB");
    detail=await call(teamA,`/${pending.id}/pending/${list[0].seq}`).then(r=>r.json());assert.equal(JSON.parse(detail.history.sourceDocument.content).notes,"  Repaired valve 100  ");
    assert.equal((await call(teamB,`/${pending.id}/pending/${list[0].seq}`,{},tokenB)).status,404);
    const filed=await call(teamA,`/${pending.id}/pending/${list[0].seq}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({siteId:sites[0].id,date:"2026-01-02"})});
    assert.equal(filed.status,200,await filed.clone().text());const result=await filed.json();
    const report=await mf.dispatchFetch(`http://localhost/api/teams/${teamA}/reports/${result.id}`,{headers:{authorization:`Bearer aludel_${tokenA}`}}).then(r=>r.json());
    assert.equal(report.semantics.client.emails[0],"client0@example.com");assert.equal(report.semantics.date.value,"2026-01-02");
    assert.equal(report.templateId,template.id);assert.equal(report.siteId,sites[0].id);
    assert.deepEqual(report.history.sourceDocument,manual.payload.sourceDocument);
    const invoiceTemplate={kind:"template",payload:{id:"invoice-format",formatIdentity:["record_type:invoice"],name:"Native service invoice",sortStatus:"learned",blocks:[{id:"amount",identity:"amount",label:"Total",valueKind:"number",options:[],unit:""}]}};
    largeItems=[invoiceTemplate,...sourceSites.map((s,i)=>({kind:"site",payload:{...s.payload,id:sites[i].id}})),...sites.map((s,i)=>{
      const invoice=record(200+i,s.id);invoice.payload.templateId="invoice-format";invoice.payload.values={amount:"$1,234.50"};invoice.payload.sourceDocument=original(JSON.stringify({invoice_id:`native-${200+i}`,amount:"$1,234.50"}));return invoice;
    })];
    const invoices=await waitFor((await (await send()).json()).id);assert.equal(invoices.filed,4);assert.equal(invoices.pending,0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE team_id=? AND site_id IN (?,?,?,?)").bind(teamA,...sites.map(s=>s.id)).first()).n,8);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sites WHERE id IN (?,?,?,?)").bind(...sites.map(s=>s.id)).first()).n,4);

    largeItems=null;pageSize=2;
  });

  // Generate this fixture with Breakfast's same-named 500-visit Rust test.
  // An opt-in bridge keeps the ordinary suite independent of a second checkout.
  await t.test("500 visits from the Rust producer reach populated Aludel sites", { skip: !process.env.BFAST_SITE_CONTACT_TEST_EXPORT }, async () => {
    const produced = JSON.parse(await readFile(process.env.BFAST_SITE_CONTACT_TEST_EXPORT, "utf8"));
    const team = randomUUID(), token = "d".repeat(43), now = new Date().toISOString();
    await db.prepare("INSERT INTO teams(id,name,created_at) VALUES(?,?,?)").bind(team, "Rust bridge", now).run();
    await db.prepare("INSERT INTO tokens(id,team_id,name,created_by,created_at) VALUES(?,?,?,?,?)").bind(hash(token), team, "Bridge", "test", now).run();
    largeItems = produced.items; pageSize = 128;
    const form = new FormData(); form.append("files", new File(["producer fixture"], "visits.csv", { type: "text/csv" }));
    const request = new Response(form);
    const started = await call(team, "?timezone=America%2FNew_York&name=visits.csv", { method: "POST", headers: { "content-type": request.headers.get("content-type"), "x-import-id": randomUUID() }, body: await request.arrayBuffer() }, token);
    assert.equal(started.status, 202, await started.clone().text());
    const { id } = await started.json(); let job;
    const deadline = Date.now() + 90_000;
    do {
      job = await (await call(team, `/${id}`, {}, token)).json();
      assert.notEqual(job.state, "failed", JSON.stringify(job));
      if (job.state === "complete") break;
      await new Promise(resolve => setTimeout(resolve, 300));
    } while (Date.now() < deadline);
    assert.equal(job.state, "complete"); assert.equal(job.filed, 500); assert.equal(job.pending, 0); assert.equal(job.rejected, 0);
    const sites = (await db.prepare("SELECT * FROM sites WHERE team_id=?").bind(team).all()).results;
    assert.equal(sites.length, 4);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM templates WHERE team_id=?").bind(team).first()).n, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE team_id=?").bind(team).first()).n, 4);
    for (const expected of produced.sites) {
      const site = sites.find(s => s.address === expected.address); assert.ok(site, expected.address);
      assert.equal(site.client_name, expected.client.name);
      assert.deepEqual(JSON.parse(site.emails), expected.client.emails);
      assert.deepEqual(JSON.parse(site.phones), expected.client.phones);
      const response = await mf.dispatchFetch(`http://localhost/api/teams/${team}/vault/reports?site=${site.id}&limit=1`, { headers: { authorization: `Bearer aludel_${token}` } });
      const vault = await response.json(); assert.equal(vault.total, 125);
    }
    largeItems = null; pageSize = 2;
  });
});

test("Breakfast runtime key names authenticate consistently and missing keys make no upstream request", async t => {
  const built = await build({ entryPoints: ["src/worker/breakfast-api.ts"], bundle: true, write: false, format: "esm", platform: "neutral" });
  const { breakfast } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, authorization: init.headers.get("authorization") });
    return Response.json({ ready: true });
  });
  for (const [env, expected] of [
    [{ BREAKFAST_KEY: "new-secret" }, "new-secret"],
    [{ BFAST_API_KEY: "legacy-secret" }, "legacy-secret"],
    [{ BREAKFAST_KEY: "preferred-secret", BFAST_API_KEY: "old-secret" }, "preferred-secret"],
    [{ BREAKFAST_KEY: "  ", BFAST_API_KEY: " legacy-secret\n" }, "legacy-secret"],
  ]) {
    assert.deepEqual(await breakfast(env, "/v1/pipeline/jobs/job-test"), { ready: true });
    assert.equal(requests.at(-1).authorization, `Bearer ${expected}`);
    assert.equal(new URL(requests.at(-1).url).origin, "https://breakfast-tm-container.lafayettejcompton.workers.dev");
  }
  const count = requests.length;
  for (const env of [{}, { BREAKFAST_KEY: " ", BFAST_API_KEY: "\n" }]) {
    await assert.rejects(() => breakfast(env, "/v1/pipeline/jobs/job-test"), error => error.status === 503);
  }
  assert.equal(requests.length, count);
});

function resolvedFixture(date = {value:"2024-07-01",precision:"date"}) {
  const g = fixture();
  const person = name => ({name,firstName:null,lastName:null,emails:[],phones:[]});
  for (const r of g.nodes.filter(n => n.kind === "record")) r.properties.semantics = {
    schemaVersion:1, client:person("Wanda Namesake"), employee:person(null), user:person("Account Owner"), date, serviceAddresses:["10 Main Street, Albany, NY"],
  };
  return g;
}

test("resolved contract governs names and dates; display renaming cannot change imported field identity", async () => {
  const graph = resolvedFixture();
  const a = await planGraph(graph, teamA, "contract", "America/New_York");
  const renamed = structuredClone(graph);
  for (const n of renamed.nodes.filter(n => ["template","block"].includes(n.kind))) {n.properties.displayName="Same new wording";n.properties.conceptDisplayName="Same new wording";}
  const b = await planGraph(renamed, teamA, "contract", "America/New_York");
  const records = p => p.filter(i=>i.kind==="record").map(i=>i.payload);
  assert.deepEqual(records(a), records(b));
  assert.equal(a[0].payload.id,b[0].payload.id);
  assert.equal(a.find(i=>i.kind==="site").payload.clientName,"Wanda Namesake");
  assert.equal(records(a)[0].performedAt,"2024-07-01");
  assert.equal(records(a)[0].byName,"");
  const unknown = await planGraph(resolvedFixture(null),teamA,"contract","America/New_York");
  assert.equal(unknown.filter(i=>i.kind==="pending").length,2);
  const badVersion=resolvedFixture();badVersion.nodes.find(n=>n.kind==="record").properties.semantics.schemaVersion=2;
  await assert.rejects(()=>planGraph(badVersion,teamA,"contract","America/New_York"),/semantics contract/);
});

test("filing retains date-only precision and never substitutes the uploader for an unknown worker", async () => {
  const buildResult=await build({entryPoints:["src/worker/import-records.ts"],bundle:true,write:false,format:"esm",platform:"neutral"});
  const {fileImportRecords}=await import(`data:text/javascript;base64,${Buffer.from(buildResult.outputFiles[0].text).toString("base64")}`);
  const plan=await planGraph(resolvedFixture(),teamA,"contract","America/New_York");
  const template=plan.find(i=>i.kind==="template").payload, site=plan.find(i=>i.kind==="site").payload;
  const env={DB:{prepare(sql){return {bind(){return this;},async first(){
    if(sql.includes("imported_contacts"))return null; // This date/ownership unit test does not model site storage.
    if(sql.includes("FROM sites"))return {id:site.id,name:site.clientName};
    if(sql.includes("FROM templates"))return {id:template.id,name:template.name,version:1,doc:JSON.stringify({tasks:template.tasks})};
    if(sql.includes("FROM dispatches"))return {id:randomUUID()};
    throw new Error(sql);
  }};}}};
  const saved=[];const vault={byOrigin:()=>null,addImported(meta){saved.push(meta);return {id:meta.id};}};
  const raw=plan.find(i=>i.kind==="record").payload;
  const result=await fileImportRecords(env,teamA,{id:randomUUID(),name:"Uploader"},[raw],vault);
  assert.equal(result.filed,1);assert.equal(saved[0].performedAt,"2024-07-01");assert.equal(saved[0].byName,"");
  const unknown=structuredClone(raw);unknown.semantics.date=null;unknown.performedAt="2024-01-01T00:00:00Z";
  assert.equal((await fileImportRecords(env,teamA,{id:randomUUID(),name:"Uploader"},[unknown],vault)).filed,0);
});
