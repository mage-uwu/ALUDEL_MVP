import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const digest = text => createHash("sha256").update(text).digest("hex");
const sourceOf = (content, mediaType = "application/json", delimiter) => ({ schemaVersion: 1, mediaType, content, sha256: digest(content), ...(delimiter ? { delimiter } : {}) });
const bundled = async path => {
  const out = await build({ entryPoints: [path], bundle: true, write: false, format: "esm", platform: "neutral" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
};
const { readImportHistory, sourceCsvRows } = await bundled("src/shared/import-history.ts");
const { mapRecord } = await bundled("src/worker/import-plan.ts");

test("CSV display preserves original order, duplicate headers, blanks, whitespace and multiline cells", async () => {
  const content = '\ufeff Notes ,Notes,Blank,Amount,Account\r\n"  first\r\nsecond, ""quoted""  ",different,,"$1,234.50",00042\r\n';
  assert.deepEqual(sourceCsvRows(content, ","), [[" Notes ", "Notes", "Blank", "Amount", "Account"], ["  first\r\nsecond, \"quoted\"  ", "different", "", "$1,234.50", "00042"]]);
  assert.deepEqual(sourceCsvRows("Name\tEmpty\r\n Ada \t\r\n", "\t"), [["Name", "Empty"], [" Ada ", ""]]);
  const history = { schemaVersion: 1, sourceDocument: sourceOf(content, "text/csv", ",") };
  assert.deepEqual(await readImportHistory(history), history);
  await assert.rejects(() => readImportHistory({ ...history, sourceDocument: { ...history.sourceDocument, content: content.trim() } }), /checksum mismatch/);
});

test("classification metadata and template wording never rewrite archived data", () => {
  const sourceDocument = sourceOf('{ "amount": "$1,234.50", "notes": [null, false, "  keep  "] }');
  const source = { id: "test", templateId: "format", siteId: "site", date: "2024-01-01", values: { amount: 1234.5 }, origin: { file: "legacy.json" }, sourceDocument };
  const a = mapRecord(source, { id: "template", blocks: { amount: { id: "a", kind: "number", label: "Amount" } } }, "site", "UTC");
  const b = mapRecord(source, { id: "template", blocks: { amount: { id: "b", kind: "buttons", label: "Changed label" } } }, "site", "UTC");
  assert.deepEqual(a.payload.history, b.payload.history);
  assert.deepEqual(a.payload.history.sourceDocument, sourceDocument);
  assert.equal(a.kind, "record"); assert.equal(a.payload.values, undefined);
  const pending = mapRecord(source, { id: "template", blocks: {} }, undefined, "UTC");
  assert.equal(pending.kind, "pending"); assert.deepEqual(pending.payload.history, a.payload.history);
});

test("real Vault archives source independently of templates and serves identical bytes", { timeout: 120_000 }, async t => {
  const worker = await build({ entryPoints: ["src/worker/index.ts"], bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:workers"] });
  const persist = await mkdtemp(join(tmpdir(), "aludel-source-test-"));
  const options = convertV4MiniflareOptions({ resourcePersistencePath: persist, name: "source-history-test", modules: true, script: worker.outputFiles[0].text,
    compatibilityDate: "2025-08-01", d1Databases: { DB: "history-db" }, durableObjects: { VAULT: { className: "Vault", useSQLite: true }, CHATS: { className: "ChatStore", useSQLite: true } } });
  let mf = new Miniflare(options);
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  await mf.ready; await (await mf.dispatchFetch("http://localhost/api/me")).arrayBuffer();
  const db = await mf.getD1Database("DB"), team = randomUUID(), other = randomUUID(), site = randomUUID(), template = randomUUID(), token = "h".repeat(43), otherToken = "o".repeat(43), now = new Date().toISOString();
  for (const [id, key] of [[team, token], [other, otherToken]]) {
    const user = randomUUID();
    await db.prepare("INSERT INTO teams(id,name,created_at) VALUES(?,?,?)").bind(id, "History", now).run();
    await db.prepare("INSERT INTO tokens(id,team_id,name,created_by,created_at) VALUES(?,?,?,?,?)").bind(createHash("sha256").update(key).digest("base64url"), id, "Import", "test", now).run();
    await db.prepare("INSERT INTO users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?)").bind(user, user, `${user}@example.com`, "History test", now).run();
    await db.prepare("INSERT INTO memberships(team_id,user_id,role,created_at) VALUES(?,?,?,?)").bind(id, user, "owner", now).run();
    await db.prepare("INSERT INTO sessions(id,user_id,created_at,last_seen,expires_at) VALUES(?,?,?,?,?)").bind(createHash("sha256").update(key).digest("base64url"), user, now, now, new Date(Date.now() + 86_400_000).toISOString()).run();
  }
  await db.prepare("INSERT INTO sites(id,team_id,client_name,created_at,updated_at) VALUES(?,?,?,?,?)").bind(site, team, "Ada", now, now).run();
  await db.prepare("INSERT INTO templates(id,team_id,name,doc,updated_at) VALUES(?,?,?,?,?)").bind(template, team, "Repair", JSON.stringify({ tasks: [{ id: randomUUID(), name: "Live form", blocks: [{ id: randomUUID(), kind: "number", label: "Unrelated field" }] }] }), now).run();
  const call = async (path, body, target = team, key = token) => {
    const auth = path === "/import"
      ? { authorization: `Bearer aludel_${key}` }
      : { cookie: `aludel_session=${key}`, origin: "http://localhost" };
    const res = await mf.dispatchFetch(`http://localhost/api/teams/${target}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...auth, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers });
  };
  const notes = "  • untouched note <script>alert('x')</script>\r\n".repeat(4000);
  const content = `{\n "Account": "00042", "Amount": "$1,234.50", "Empty": null, "False": false, "Array": [1, null, " raw "], "large": 9007199254740993, "duplicate": 1, "duplicate": 2, "Notes": ${JSON.stringify(notes)}\n}`;
  const record = { siteId: site, templateId: template, performedAt: "2024-01-01", origin: { file: "original.json", externalId: "source-one", sha256: "a".repeat(64) }, history: { schemaVersion: 1, sourceDocument: sourceOf(content) } };
  const submit = async rec => {
    const res = await call("/import", { records: [rec] }); assert.equal(res.status, 200, await res.clone().text()); return res.json();
  };
  let id;
  await t.test("long original content files even when nothing fits the template", async () => {
    assert.ok(Buffer.byteLength(content) > 128 * 1024);
    const filed = await submit(record); assert.equal(filed.filed, 1, JSON.stringify(filed)); id = filed.results[0].id;
    const report = await (await call(`/reports/${id}`)).json();
    assert.deepEqual(report.doc.tasks, []); assert.equal(report.facts, 0);
    assert.deepEqual(report.history, record.history); assert.equal(report.siteId, site); assert.equal(report.templateId, template);
    const download = await call(`/reports/${id}/source`);
    assert.equal(download.status, 200); assert.match(download.headers.get("content-disposition"), /^attachment;/);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(content));
    assert.equal((await call(`/reports/${id}/source`, undefined, other, otherToken)).status, 404);
  });
  await t.test("template edits do not change history or constrain the next import", async () => {
    await db.prepare("UPDATE templates SET name='Edited form',version=2,doc=? WHERE id=?").bind('{"tasks":[]}', template).run();
    const next = await submit({ ...record, origin: { ...record.origin, externalId: "source-two" } });
    assert.equal(next.filed, 1);
    for (const reportId of [id, next.results[0].id]) assert.deepEqual((await (await call(`/reports/${reportId}`)).json()).history, record.history);
    const page = await (await call(`/vault/reports?template=${template}&site=${site}&from=2024-01-01&to=2024-01-01`)).json();
    assert.equal(page.total, 2); assert.ok(page.reports.every(r => r.history === undefined), "listing does not load source bodies");
  });
  await t.test("checksum failures and reused IDs with different content cannot replace the archive", async () => {
    const again = await submit(record); assert.equal(again.filed, 0); assert.equal(again.results[0].duplicate, true);
    const reordered = { ...record, history: { schemaVersion: 1, sourceDocument: Object.fromEntries(Object.entries(record.history.sourceDocument).reverse()) } };
    assert.equal((await submit(reordered)).results[0].duplicate, true, "source envelope property order is not historical content");
    const corrupt = { ...record, history: { schemaVersion: 1, sourceDocument: { ...record.history.sourceDocument, content: "changed" } } };
    assert.match((await submit(corrupt)).results[0].error, /checksum mismatch/);
    corrupt.history.sourceDocument = sourceOf("changed", "text/plain");
    assert.match((await submit(corrupt)).results[0].error, /different or unverifiable/);
    assert.equal(await (await call(`/reports/${id}/source`)).text(), content);
  });
  await t.test("older producer values remain intact and can gain an original only with a matching fingerprint", async () => {
    const values = { "  Unknown field  ": "  • $1,234.50  ", empty: "", null: null, flag: false, array: ["  a  ", null], nested: { keep: "00042" }, notes };
    const old = { ...record, history: undefined, values, origin: { ...record.origin, externalId: "older-producer" } };
    const filed = await submit(old); assert.equal(filed.filed, 1);
    const savedId = filed.results[0].id;
    assert.deepEqual((await (await call(`/reports/${savedId}`)).json()).history.receivedValues, values);
    assert.equal((await call(`/reports/${savedId}/source`)).status, 404);
    const wrong = { ...record, origin: { ...old.origin, sha256: "b".repeat(64) } };
    assert.match((await submit(wrong)).results[0].error, /unverifiable/);
    const restored = await submit({ ...record, origin: old.origin }); assert.equal(restored.results[0].duplicate, true);
    assert.equal(await (await call(`/reports/${savedId}/source`)).text(), content);
  });
  await t.test("sources survive a runtime restart and removal of the live site/template", async () => {
    await db.prepare("DELETE FROM sites WHERE id=?").bind(site).run();
    await db.prepare("DELETE FROM templates WHERE id=?").bind(template).run();
    await mf.dispose(); mf = new Miniflare(options); await mf.ready;
    assert.equal(await (await call(`/reports/${id}/source`)).text(), content);
    assert.equal((await (await call(`/reports/${id}`)).json()).history.sourceDocument.sha256, digest(content));
    const catalog = await (await call("/vault/catalog")).json(); assert.equal(catalog.sites[0].id, site); assert.equal(catalog.templates[0].id, template);
  });
});
