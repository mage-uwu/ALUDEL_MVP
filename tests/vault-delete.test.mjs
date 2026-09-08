import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const hash = (data, encoding = "hex") => createHash("sha256").update(data).digest(encoding);

test("temporary Vault reset authorizes the team, removes archived data and prevents import races", { timeout: 90_000 }, async t => {
  // Only the test bundle exposes fixture storage and a controllable D1 delay.
  // All application requests still run the actual Worker and Vault methods.
  const worker = await build({ stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
    import app, { Vault, ChatStore } from './src/worker/index';
    export { ChatStore };
    export class TestVault extends Vault {
      control;
      constructor(ctx, env) {
        const control = { pause: false, release: null };
        super(ctx, { ...env, DB: { prepare(sql) {
          const statement = env.DB.prepare(sql);
          if (!sql.startsWith('SELECT id, client_name AS name FROM sites')) return statement;
          return { bind(...args) { const bound = statement.bind(...args); return { async first() {
            if (control.pause) { control.pause = false; await new Promise(resolve => { control.release = resolve; }); control.release = null; }
            return bound.first();
          } }; } };
        } } });
        this.control = control;
      }
      pause() { this.control.pause = true; }
      held() { return Boolean(this.control.release); }
      release() { this.control.release?.(); }
      inspect() {
        const tables = ['reports','facts','report_history','pdf_sources','pdf_chunks','breakfast_jobs','breakfast_items','breakfast_catalog','breakfast_transfers'];
        return Object.fromEntries(tables.map(table => [table, this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM ' + table).toArray()[0].n]));
      }
      seedPdf({ sha, bytes }) {
        const data = Uint8Array.from(atob(bytes), c => c.charCodeAt(0));
        this.ctx.storage.sql.exec('INSERT INTO pdf_sources(id,bytes) VALUES(?,?)', sha, data.byteLength);
        this.ctx.storage.sql.exec('INSERT INTO pdf_chunks(id,part,sha256,data) VALUES(?,0,?,?)', sha, sha, data.buffer);
      }
      seedJob({ id, team, state, payload = {}, created }) {
        const sql = this.ctx.storage.sql, now = new Date().toISOString();
        sql.exec("INSERT INTO breakfast_jobs(id,team_id,user_id,user_name,name,timezone,upstream_id,state,phase,message,created_at,updated_at,next_poll) VALUES(?,?,?,'Owner','Old import','UTC','job-reset-test',?,'transfer','Test',?,?,?)", id, team, 'owner', state, created ?? now, now, Date.now()+3600000);
        sql.exec("INSERT INTO breakfast_items(job_id,seq,kind,payload,outcome,error) VALUES(?,0,'pending',?,'pending','Needs review')", id, JSON.stringify(payload));
        sql.exec("INSERT INTO breakfast_transfers(job_id,snapshot,next_seq,total_items,total_records,complete) VALUES(?,'snapshot',1,1,1,1)", id);
        sql.exec("INSERT INTO breakfast_catalog(job_id,kind,source_id,mapping) VALUES(?,'template','legacy','{}')", id);
      }
      finish({ id }) { this.ctx.storage.sql.exec("UPDATE breakfast_jobs SET state='failed' WHERE id=?", id); }
      tick() { return this.alarm(); }
    }
    export default { async fetch(req, env) {
      const match = new URL(req.url).pathname.match(new RegExp('^/__test/([^/]+)/(inspect|seedPdf|seedJob|finish|pause|held|release|tick)$'));
      if (match) {
        const stub = env.VAULT.get(env.VAULT.idFromName(match[1]));
        const body = await req.json();
        return Response.json(await stub[match[2]](body) ?? null);
      }
      return app.fetch(req, env);
    } };
  ` }, bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:workers"] });
  const persist = await mkdtemp(join(tmpdir(), "aludel-vault-delete-"));
  const options = convertV4MiniflareOptions({ resourcePersistencePath: persist, name: "vault-delete-test", modules: true,
    script: worker.outputFiles[0].text, compatibilityDate: "2025-08-01", d1Databases: { DB: "test-db" },
    durableObjects: { VAULT: { className: "TestVault", useSQLite: true }, CHATS: { className: "ChatStore", useSQLite: true } } });
  let mf = new Miniflare(options);
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  await mf.ready; await (await mf.dispatchFetch("http://localhost/api/me")).arrayBuffer();
  let db = await mf.getD1Database("DB");
  const team = randomUUID(), other = randomUUID(), token = "t".repeat(43), now = new Date().toISOString();
  for (const id of [team, other]) await db.prepare("INSERT INTO teams(id,name,created_at) VALUES(?,?,?)").bind(id, "Test team", now).run();
  const sessions = {};
  for (const [role, target] of [["owner", team], ["admin", team], ["member", team], ["outsider", other]]) {
    const id = randomUUID(), session = randomUUID(); sessions[role] = session;
    await db.prepare("INSERT INTO users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?)").bind(id, id, `${role}@example.test`, role, now).run();
    await db.prepare("INSERT INTO memberships(team_id,user_id,role,created_at) VALUES(?,?,?,?)").bind(target, id, role === "outsider" ? "owner" : role, now).run();
    await db.prepare("INSERT INTO sessions(id,user_id,created_at,last_seen,expires_at) VALUES(?,?,?,?,?)")
      .bind(hash(session, "base64url"), id, now, now, new Date(Date.now() + 3600000).toISOString()).run();
  }
  await db.prepare("INSERT INTO tokens(id,team_id,name,created_by,created_at) VALUES(?,?,?,?,?)").bind(hash(token, "base64url"), team, "Integration", "test", now).run();
  const call = async (path, { target = team, role = "owner", method = "GET", body, headers = {} } = {}) => {
    const res = await mf.dispatchFetch(`http://localhost/api/teams/${target}${path}`, { method,
      headers: { cookie: sessions[role] ? `aludel_session=${sessions[role]}` : "", origin: "http://localhost", "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers });
  };
  const ok = async (path, options) => { const res = await call(path, options); assert.equal(res.status, 200, await res.clone().text()); return res.json(); };
  const helper = async (method, body = {}, target = team) => {
    const res = await mf.dispatchFetch(`http://localhost/__test/${target}/${method}`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(res.status, 200); return res.json();
  };
  const remove = (options = {}) => call("/vault/reports", { method: "DELETE", body: { teamId: team, confirmation: "DELETE ALL" }, ...options });
  const setup = async (target, role) => {
    const site = randomUUID(), template = randomUUID(), block = randomUUID();
    await db.prepare("INSERT INTO sites(id,team_id,client_name,address,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(site, target, "Ada", "10 Main Street", now, now).run();
    await db.prepare("INSERT INTO templates(id,team_id,name,doc,updated_at) VALUES(?,?,?,?,?)").bind(template, target, "Service report", JSON.stringify({ tasks: [{ id: randomUUID(), name: "Service", blocks: [{ id: block, kind: "text", label: "Notes", unit: "", options: [] }] }] }), now).run();
    const content = "Client,Notes\r\nAda,Keep the original\r\n";
    const record = { siteId: site, templateId: template, performedAt: now, origin: { file: "history.csv", externalId: "old-record" },
      history: { schemaVersion: 1, sourceDocument: { schemaVersion: 1, mediaType: "text/csv", content, delimiter: ",", sha256: hash(content) } } };
    const result = await ok("/import", { target, role, method: "POST", body: { records: [record] } });
    assert.equal(result.filed, 1, JSON.stringify(result));
    return { site, template, block, record, report: result.results[0].id };
  };
  const a = await setup(team, "owner"), b = await setup(other, "outsider");
  const dispatch = (await ok("/dispatches"))[0];
  const field = await call("/reports", { method: "POST", body: { dispatchId: dispatch.id, performedAt: now, values: { [a.block]: "Field submission" } } });
  assert.equal(field.status, 201, await field.clone().text());
  const original = Buffer.from("%PDF-1.4\nOriginal historical PDF\n%%EOF\n"), sha = hash(original);
  await helper("seedPdf", { sha, bytes: original.toString("base64") });
  const history = { schemaVersion: 1, sourceDocument: { schemaVersion: 1, mediaType: "application/pdf", content: "", sha256: sha, pdf: { fileName: "original.pdf", byteLength: original.length, pages: 1, ocrPages: [] } } };
  const pdf = await ok("/import", { method: "POST", body: { records: [{ ...a.record, origin: { file: "original.pdf", externalId: "pdf" }, history }] } });
  assert.equal(pdf.filed, 1, JSON.stringify(pdf));
  const pdfId = pdf.results[0].id, job = randomUUID();
  await helper("seedJob", { id: job, team, state: "complete", payload: { history } });
  assert.deepEqual(Buffer.from(await (await call(`/reports/${pdfId}/source`)).arrayBuffer()), original);
  assert.deepEqual(Buffer.from(await (await call(`/breakfast/jobs/${job}/pending/0/source`)).arrayBuffer()), original);

  await t.test("owners/admins must explicitly confirm their own team; members, tokens and cross-origin requests cannot delete", async () => {
    for (const [options, status] of [
      [{ role: "member" }, 403], [{ role: "outsider" }, 404], [{ role: "none" }, 401],
      [{ headers: { authorization: `Bearer aludel_${token}` } }, 403],
      [{ headers: { origin: "https://attacker.example" } }, 403],
      [{ body: {} }, 422], [{ body: { teamId: team, confirmation: "delete all" } }, 422],
      [{ body: { teamId: other, confirmation: "DELETE ALL" } }, 422],
    ]) assert.equal((await remove(options)).status, status, JSON.stringify(options));
    assert.equal((await ok("/vault/reports")).total, 3);
  });

  await t.test("an active job outside the thirty most recent jobs still prevents deletion", async () => {
    const active = randomUUID();
    await helper("seedJob", { id: active, team, state: "processing", created: "2000-01-01T00:00:00Z" });
    for (let i = 0; i < 30; i++) await helper("seedJob", { id: randomUUID(), team, state: "complete" });
    assert.ok(!(await ok("/breakfast/jobs")).jobs.some(j => j.id === active));
    const result = await remove(); assert.equal(result.status, 409); assert.match((await result.json()).error, /import is still running/);
    assert.equal((await ok("/vault/reports")).total, 3);
    await helper("finish", { id: active });
  });

  await t.test("an in-flight direct import cannot file a record after a successful reset", async () => {
    await helper("pause");
    const writing = call("/import", { method: "POST", body: { records: [{ ...a.record, origin: { file: "history.csv", externalId: "concurrent" } }] } });
    try {
      const deadline = Date.now() + 5000;
      while (!await helper("held")) { assert.ok(Date.now() < deadline, "D1 lookup should be held"); await new Promise(r => setTimeout(r, 20)); }
      assert.equal((await remove()).status, 409);
    } finally { await helper("release"); }
    const finished = await writing; assert.equal(finished.status, 200); assert.equal((await finished.json()).filed, 1);
  });

  const fieldBefore = await ok("/dispatches"), sitesBefore = await ok("/sites"), templatesBefore = await ok("/templates");
  await t.test("admin reset clears all filters, facts, original bytes, pending documents and import recovery state", async () => {
    const before = await helper("inspect"); assert.ok(Object.values(before).every(n => n > 0), JSON.stringify(before));
    const result = await call(`/vault/reports?site=${randomUUID()}&from=2099-01-01`, { role: "admin", method: "DELETE", body: { teamId: team, confirmation: "DELETE ALL" } });
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), { deletedReports: 4, deletedImports: 32 });
    assert.ok(Object.values(await helper("inspect")).every(n => n === 0));
    assert.deepEqual(await ok("/vault/reports"), { reports: [], total: 0, nextCursor: null });
    assert.deepEqual(await ok("/vault/catalog"), { templates: [], sites: [] });
    for (const path of [`/reports/${a.report}`, `/reports/${a.report}/source`, `/reports/${pdfId}/source`, `/breakfast/jobs/${job}`, `/breakfast/jobs/${job}/pending/0/source`]) assert.equal((await call(path)).status, 404, path);
    assert.equal((await call(`/breakfast/jobs/${job}/resume`, { method: "POST" })).status, 404);
    assert.deepEqual(await ok("/dispatches"), fieldBefore);
    assert.deepEqual(await ok("/sites"), sitesBefore);
    assert.deepEqual(await ok("/templates"), templatesBefore);
    assert.equal((await ok("/vault/reports", { target: other, role: "outsider" })).total, 1);
    assert.equal((await call(`/reports/${b.report}/source`, { target: other, role: "outsider" })).status, 200);
  });

  await t.test("deletion survives restart and stale alarms; owner retries and deliberate reimport still work", async () => {
    await mf.dispose(); mf = new Miniflare(options); await mf.ready; db = await mf.getD1Database("DB");
    await helper("tick");
    assert.ok(Object.values(await helper("inspect")).every(n => n === 0));
    const repeated = await remove(); assert.equal(repeated.status, 200); assert.deepEqual(await repeated.json(), { deletedReports: 0, deletedImports: 0 });
    const again = await ok("/import", { method: "POST", body: { records: [a.record] } });
    assert.equal(again.filed, 1); assert.equal(again.results[0].duplicate, undefined);
    assert.equal((await ok("/vault/reports")).total, 1);
    assert.equal((await remove()).status, 200);
  });
});
