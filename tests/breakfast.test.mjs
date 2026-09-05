import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const teamA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const teamB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const secret = "test-breakfast-secret";
const hash = s => createHash("sha256").update(s).digest("base64url");

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
  assert.equal(rec.values[blocks.find(b => b.label === "Account ID").id], "00123");
  assert.equal(rec.values[blocks.find(b => b.label === "Temperature").id], 38.5);
  assert.deepEqual(blocks.find(b => b.label === "Outcome").options, ["PASS", "FAIL"]);
  assert.equal(rec.origin.externalId, "visit-1");
  assert.equal((await planGraph(fixture({ badDate: true }), teamA, "job-e", "America/New_York")).filter(i => i.kind === "rejected").length, 2);
  assert.equal(paperTime("1/17/2024", "2:30 PM", "America/New_York"), "2024-01-17T19:30:00.000Z");
  assert.equal(paperTime("2024-07-01", "00:30", "America/New_York"), "2024-07-01T04:30:00.000Z");
  assert.equal(paperTime("2/30/2024", "12:00", "America/New_York"), null);
  assert.equal(paperTime("3/10/2024", "02:30", "America/New_York"), null);
});

test("real Worker + D1 + SQLite Durable Object import handshake", { timeout: 120_000 }, async t => {
  let uploads = 0, mode = "ok", graph = fixture(), pollFailures = 0;
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
    } else if (url.pathname.endsWith("/graph")) res.end(JSON.stringify(graph));
    else if (pollFailures-- > 0) { res.writeHead(503); res.end('{}'); }
    else res.end(JSON.stringify({ state: "complete", percent: 100, phase: "complete" }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const worker = await build({ entryPoints: ["src/worker/index.ts"], bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:workers"] });
  const persist = await mkdtemp(join(tmpdir(), "aludel-import-test-"));
  const runtimeOptions = convertV4MiniflareOptions({ resourcePersistencePath: persist, name: "aludel-test", modules: true, script: worker.outputFiles[0].text, compatibilityDate: "2025-08-01",
    bindings: { BFAST_API_KEY: secret, BFAST_ENDPOINT: `http://127.0.0.1:${upstream.address().port}` },
    d1Databases: { DB: "test-db" }, durableObjects: { VAULT: { className: "Vault", useSQLite: true }, CHATS: { className: "ChatStore", useSQLite: true } },
  });
  let mf = new Miniflare(runtimeOptions);
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  await mf.ready;
  // A harmless request initializes the exact application schema.
  await mf.dispatchFetch("http://localhost/api/me");
  const db = await mf.getD1Database("DB");
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
  const waitFor = async (id, states = ["complete"]) => {
    assert.ok(id, "Missing local job ID");
    const until = Date.now() + 35_000;
    while (Date.now() < until) {
      const res = await call(teamA, `/${id}`), job = await res.json();
      if (states.includes(job.state)) return job;
      if (job.state === "failed") assert.fail(JSON.stringify(job));
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.fail(`Import ${id} did not reach ${states}`);
  };
  await t.test("auth, CSRF, and team ownership block access before the job namespace", async () => {
    assert.equal((await mf.dispatchFetch(`http://localhost/api/teams/${teamA}/breakfast/jobs`)).status, 401);
    assert.equal((await mf.dispatchFetch(`http://localhost/api/teams/${teamA}/breakfast/jobs`, { method: "POST", headers: { origin: "https://attacker.example" } })).status, 403);
    assert.equal((await call(teamB)).status, 404);
    const res = await call(teamB, "", {}, tokenB); assert.equal(res.status, 200); assert.deepEqual((await res.json()).jobs, []);
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
    const query = await mf.dispatchFetch(`http://localhost/api/teams/${teamA}/vault/query`, { method: "POST", headers: { authorization: `Bearer aludel_${tokenA}`, "content-type": "application/json" }, body: JSON.stringify({ select: { agg: "sum", label: "Temperature" } }) });
    assert.equal((await query.json()).groups[0].value, 77);
  });
  await t.test("a second upload reuses templates/sites and recognizes filed records", async () => {
    const res = await send(); const job = await res.json();
    const done = await waitFor(job.id); assert.equal(done.duplicates, 2); assert.equal(done.filed, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM templates WHERE team_id = ?").bind(teamA).first()).n, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sites WHERE team_id = ?").bind(teamA).first()).n, 1);
  });
  await t.test("explicit busy rejection and uncertain uploads are never automatically resubmitted", async () => {
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
    const done = await waitFor(job.id); assert.equal(done.rejected, 2); assert.equal(done.errors.length, 2);
  });
  await t.test("jobs, records, and pending alarms survive a runtime restart", async () => {
    graph = fixture();
    const pending = await (await send()).json();
    await mf.dispose();
    mf = new Miniflare(runtimeOptions);
    await mf.ready;
    const response = await call(teamA, `/${imported.id}`); const job = await response.json();
    assert.equal(response.status, 200, JSON.stringify(job));
    assert.equal(job.state, "complete", JSON.stringify(job)); assert.equal(job.filed, 2);
    const completed = await waitFor(pending.id); assert.equal(completed.duplicates, 2);
  });
});
