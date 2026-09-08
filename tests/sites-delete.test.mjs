import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const hash = (data, encoding = "hex") => createHash("sha256").update(data).digest(encoding);

test("permanent site reset is transactional, tenant-scoped and preserves Vault history", { timeout: 90_000 }, async t => {
  const gates = new Map();
  const gate = createServer((req, res) => gates.set(req.url, res));
  await new Promise(resolve => gate.listen(0, "127.0.0.1", resolve));
  t.after(() => { gate.closeAllConnections(); gate.close(); });
  const waitGate = async path => {
    const deadline = Date.now() + 5000;
    while (!gates.has(path)) { assert.ok(Date.now() < deadline, `Waiting for ${path}`); await new Promise(r => setTimeout(r, 10)); }
  };
  const release = path => { gates.get(path)?.end("ok"); gates.delete(path); };
  // Test-only D1 delays expose actual cross-request races without changing the app.
  const worker = await build({ stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
    import app, { Vault, ChatStore } from './src/worker/index';
    export { ChatStore };
    export class TestVault extends Vault {
      control;
      constructor(ctx, env) {
        const control = { lookup: false, deletion: false, failure: false };
        super(ctx, { ...env, DB: {
          prepare(sql) {
            const statement = env.DB.prepare(sql);
            if (!sql.startsWith('SELECT id, client_name AS name FROM sites')) return statement;
            return { bind(...args) { const bound = statement.bind(...args); return { async first() {
              if (control.lookup) { control.lookup = false; await fetch(env.TEST_GATE + '/lookup'); }
              return bound.first();
            } }; } };
          },
          async batch(statements) {
            if (control.deletion) { control.deletion = false; await fetch(env.TEST_GATE + '/delete'); }
            if (control.failure) { control.failure = false; statements.push(env.DB.prepare('DELETE FROM deliberately_missing_table')); }
            return env.DB.batch(statements);
          }
        } });
        this.control = control;
      }
      pause(flags) { Object.assign(this.control, flags); }
      seedJob({ id, team, state, created }) {
        const now = new Date().toISOString();
        this.ctx.storage.sql.exec("INSERT INTO breakfast_jobs(id,team_id,user_id,user_name,name,timezone,upstream_id,state,phase,message,created_at,updated_at,next_poll) VALUES(?,?,'owner','Owner','Old import','UTC','job-old',?,'transfer','Test',?,?,?)", id, team, state, created ?? now, now, Date.now()+3600000);
      }
      finish({ id }) { this.ctx.storage.sql.exec("UPDATE breakfast_jobs SET state='failed' WHERE id=?", id); }
      seedPdf({ sha, bytes }) {
        const data = Uint8Array.from(atob(bytes), c => c.charCodeAt(0));
        this.ctx.storage.sql.exec('INSERT INTO pdf_sources(id,bytes) VALUES(?,?)', sha, data.byteLength);
        this.ctx.storage.sql.exec('INSERT INTO pdf_chunks(id,part,sha256,data) VALUES(?,0,?,?)', sha, sha, data.buffer);
      }
      tick() { return this.alarm(); }
    }
    export default { async fetch(req, env) {
      const match = new URL(req.url).pathname.match(new RegExp('^/__test/([^/]+)/(pause|seedJob|finish|seedPdf|tick)$'));
      if (match) return Response.json(await env.VAULT.get(env.VAULT.idFromName(match[1]))[match[2]](await req.json()) ?? null);
      return app.fetch(req, env);
    } };
  ` }, bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:workers"] });
  const persist = await mkdtemp(join(tmpdir(), "aludel-sites-delete-"));
  const options = convertV4MiniflareOptions({ resourcePersistencePath: persist, name: "sites-delete-test", modules: true,
    script: worker.outputFiles[0].text, compatibilityDate: "2025-08-01", d1Databases: { DB: "test-db" },
    bindings: { TEST_GATE: `http://127.0.0.1:${gate.address().port}` },
    durableObjects: { VAULT: { className: "TestVault", useSQLite: true }, CHATS: { className: "ChatStore", useSQLite: true } } });
  let mf = new Miniflare(options);
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  await mf.ready; await (await mf.dispatchFetch("http://localhost/api/me")).arrayBuffer();
  let db = await mf.getD1Database("DB");
  const team = randomUUID(), other = randomUUID(), token = "s".repeat(43), now = new Date().toISOString(), sessions = {};
  for (const id of [team, other]) await db.prepare("INSERT INTO teams(id,name,plan,created_at) VALUES(?,?,?,?)").bind(id, "Test team", '{"routes":[]}', now).run();
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
  const ok = async (path, options) => { const res = await call(path, options); assert.ok(res.ok, await res.clone().text()); return res.json(); };
  const helper = async (method, body = {}) => {
    const res = await mf.dispatchFetch(`http://localhost/__test/${team}/${method}`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(res.status, 200, await res.clone().text()); return res.json();
  };
  const remove = (options = {}) => call("/sites", { method: "DELETE", body: { teamId: team, confirmation: "DELETE ALL SITES" }, ...options });
  const setup = async (target, role, count) => {
    const list = randomUUID(), template = randomUUID(), block = randomUUID(), sites = Array.from({ length: count }, () => randomUUID());
    await db.prepare("INSERT INTO lists(id,team_id,name,created_at) VALUES(?,?,?,?)").bind(list, target, "Existing list", now).run();
    await db.prepare("INSERT INTO templates(id,team_id,name,doc,updated_at) VALUES(?,?,?,?,?)").bind(template, target, "Service report", JSON.stringify({ tasks: [{ id: randomUUID(), name: "Service", blocks: [{ id: block, kind: "text", label: "Notes", unit: "", options: [] }] }] }), now).run();
    for (let start = 0; start < count; start += 50) await db.batch(sites.slice(start, start + 50).flatMap((site, i) => [
      db.prepare("INSERT INTO sites(id,team_id,list_id,client_name,address,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(site, target, i % 2 ? list : null, "Imported client", `${start+i} Main Street`, now, now),
      db.prepare("INSERT INTO dispatches(id,team_id,site_id,template_id,template_version,created_by,created_at) VALUES(?,?,?,?,1,'owner',?)").bind(randomUUID(), target, site, template, now),
    ]));
    const content = "Client,Notes\r\nAda,Keep the original\r\n";
    const record = { siteId: sites[0], templateId: template, performedAt: now, origin: { file: "history.csv", externalId: "old-record" },
      history: { schemaVersion: 1, sourceDocument: { schemaVersion: 1, mediaType: "text/csv", content, delimiter: ",", sha256: hash(content) } } };
    const filed = await ok("/import", { target, role, method: "POST", body: { records: [record] } }); assert.equal(filed.filed, 1);
    return { sites, list, template, block, record, report: filed.results[0].id };
  };
  const a = await setup(team, "owner", 512), b = await setup(other, "outsider", 1);
  const dispatch = (await ok("/dispatches"))[0];
  await ok("/reports", { method: "POST", body: { dispatchId: dispatch.id, performedAt: now, values: { [a.block]: "Field submission" } } });
  const originalPdf = Buffer.from("%PDF-1.4\nOriginal historical PDF\n%%EOF\n"), sha = hash(originalPdf);
  await helper("seedPdf", { sha, bytes: originalPdf.toString("base64") });
  const pdf = await ok("/import", { method: "POST", body: { records: [{ ...a.record, origin: { file: "original.pdf", externalId: "pdf" },
    history: { schemaVersion: 1, sourceDocument: { schemaVersion: 1, mediaType: "application/pdf", content: "", sha256: sha, pdf: { fileName: "original.pdf", byteLength: originalPdf.length, pages: 1, ocrPages: [] } } } }] } });
  assert.equal(pdf.filed, 1);

  await t.test("only confirmed owner/admin sessions can delete their own team's sites", async () => {
    for (const [options, status] of [
      [{ role: "member" }, 403], [{ role: "outsider" }, 404], [{ role: "none" }, 401],
      [{ headers: { authorization: `Bearer aludel_${token}` } }, 403], [{ headers: { origin: "https://attacker.example" } }, 403],
      [{ body: {} }, 422], [{ body: { teamId: team, confirmation: "DELETE ALL" } }, 422],
      [{ body: { teamId: team, confirmation: "delete all sites" } }, 422], [{ body: { teamId: other, confirmation: "DELETE ALL SITES" } }, 422],
    ]) assert.equal((await remove(options)).status, status, JSON.stringify(options));
    assert.equal((await ok("/sites")).length, 512);
  });
  await t.test("active jobs outside the recent thirty still block site deletion", async () => {
    const active = randomUUID(); await helper("seedJob", { id: active, team, state: "processing", created: "2000-01-01T00:00:00Z" });
    for (let i = 0; i < 30; i++) await helper("seedJob", { id: randomUUID(), team, state: "complete" });
    assert.ok(!(await ok("/breakfast/jobs")).jobs.some(j => j.id === active));
    assert.equal((await remove()).status, 409); assert.equal((await ok("/sites")).length, 512);
    await helper("finish", { id: active });
  });
  await t.test("an in-flight direct import prevents the reset", async () => {
    await helper("pause", { lookup: true });
    const writing = call("/import", { method: "POST", body: { records: [{ ...a.record, origin: { file: "history.csv", externalId: "concurrent" } }] } });
    try { await waitGate("/lookup"); assert.equal((await remove()).status, 409); }
    finally { release("/lookup"); }
    assert.equal((await (await writing).json()).filed, 1);
  });
  const catalog = await ok("/vault/catalog"), history = await ok("/vault/reports"), jobs = await ok("/breakfast/jobs");
  const savedReport = await ok(`/reports/${a.report}`), templates = await ok("/templates"), lists = await ok("/lists");
  await t.test("a D1 failure rolls back sites, dispatches and the route plan together", async () => {
    await helper("pause", { failure: true }); assert.equal((await remove()).status, 500);
    assert.equal((await ok("/sites")).length, 512); assert.equal((await ok("/dispatches")).length, 512);
    assert.notEqual((await db.prepare("SELECT plan FROM teams WHERE id=?").bind(team).first()).plan, null);
  });
  await t.test("admin reset removes every live site while a new import waits, and keeps historical documents", async () => {
    await helper("pause", { deletion: true });
    const deleting = remove({ role: "admin" }); let writing, finished = false;
    try {
      await waitGate("/delete");
      writing = call("/import", { method: "POST", body: { records: [a.record] } }).then(r => { finished = true; return r; });
      await new Promise(r => setTimeout(r, 50)); assert.equal(finished, false, "imports wait for the D1 deletion transaction");
    } finally { release("/delete"); }
    const deleted = await deleting; assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.deepEqual(await deleted.json(), { deletedSites: 512, deletedDispatches: 512 });
    const incoming = await (await writing).json(); assert.equal(incoming.filed, 0); assert.equal(incoming.results[0].error, "Unknown site");
    assert.deepEqual(await ok("/sites"), []); assert.deepEqual(await ok("/dispatches"), []);
    assert.equal((await db.prepare("SELECT plan FROM teams WHERE id=?").bind(team).first()).plan, null);
    assert.deepEqual(await ok("/templates"), templates);
    assert.deepEqual(await ok("/lists"), lists.map(l => ({ ...l, sites: 0 })));
    const archivedCatalog = await ok("/vault/catalog");
    assert.deepEqual(archivedCatalog.templates, catalog.templates);
    // The live address decoration disappears, but archived identities, counts
    // and site filters remain available after removing the actual site rows.
    const identities = entries => entries.map(({ id, name, reports }) => ({ id, name, reports }));
    assert.deepEqual(identities(archivedCatalog.sites), identities(catalog.sites));
    assert.deepEqual(await ok("/vault/reports"), history);
    assert.equal((await ok(`/vault/reports?site=${a.sites[0]}`)).total, history.reports.filter(r => r.siteId === a.sites[0]).length);
    assert.deepEqual(await ok(`/reports/${a.report}`), savedReport); assert.deepEqual(await ok("/breakfast/jobs"), jobs);
    assert.deepEqual(Buffer.from(await (await call(`/reports/${pdf.results[0].id}/source`)).arrayBuffer()), originalPdf);
    assert.equal((await ok("/sites", { target: other, role: "outsider" }))[0].id, b.sites[0]);
    assert.equal((await ok("/dispatches", { target: other, role: "outsider" })).length, 1);
    assert.notEqual((await db.prepare("SELECT plan FROM teams WHERE id=?").bind(other).first()).plan, null);
  });
  await t.test("hard deletion survives restart, stale alarms and contact recovery; retries are harmless", async () => {
    await mf.dispose(); mf = new Miniflare(options); await mf.ready; db = await mf.getD1Database("DB");
    await helper("tick");
    assert.deepEqual(await ok("/sites"), []);
    assert.equal((await ok("/sites/recover-contacts", { method: "POST", body: {} })).updatedSites, 0);
    const repeated = await remove(); assert.equal(repeated.status, 200); assert.deepEqual(await repeated.json(), { deletedSites: 0, deletedDispatches: 0 });
    assert.deepEqual(await ok("/vault/reports"), history);
    assert.equal((await call(`/sites/${a.sites[0]}`)).status, 404);
    const fresh = await ok("/sites", { method: "POST", body: { clientName: "New client" } });
    assert.ok(!a.sites.includes(fresh.id)); assert.equal((await ok("/sites")).length, 1);
  });
});
