import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const hash = (v, format = "hex") => createHash("sha256").update(v).digest(format);
async function module(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: "esm", platform: "neutral" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const contacts = await module("src/shared/site-contacts.ts");
const { mapSite } = await module("src/worker/import-plan.ts");
const { withSiteProfiles } = await module("src/worker/import-context.ts");
const person = { name: null, firstName: null, lastName: null, emails: [], phones: [] };

test("site client contract normalizes contacts without treating staff or display labels as client data", async () => {
  const mapped = await mapSite({ id: "mine-site", address: "10 Main Street", sourceAddress: "10 Main Street", clientName: "Legacy label", place: null,
    client: { ...person, name: "Ada Lovelace", emails: [" ADA@example.com ", "ada@example.com; receipt@example.com"], phones: ["(570) 555-0100", "+1 570 555 0100", "5705550100 x12"] },
    employee: { emails: ["worker@example.com"] }, user: { phones: ["5705550999"] } }, randomUUID(), "job-one");
  assert.equal(mapped.item.payload.clientName, "Ada Lovelace");
  assert.equal(mapped.item.payload.address, "10 Main Street");
  assert.equal(mapped.item.payload.locationNote, "");
  assert.deepEqual(mapped.item.payload.emails, ["ada@example.com", "receipt@example.com"]);
  assert.deepEqual(mapped.item.payload.phones, ["(570) 555-0100", "5705550100 x12"]);
  assert.deepEqual(contacts.contactPhones(["unknown", "N/A", "123", "2024-01-01 not a phone"]), []);
  await assert.rejects(() => mapSite({ id: "bad", client: { name: "Ada", emails: "not an array" } }, "team", "job"), /client contract/);
});

test("site contacts import, recover and persist through the real Worker, D1 and Vault", { timeout: 120_000 }, async t => {
  const worker = await build({ entryPoints: ["src/worker/index.ts"], bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:workers"] });
  const persist = await mkdtemp(join(tmpdir(), "aludel-site-contacts-"));
  const opts = convertV4MiniflareOptions({ resourcePersistencePath: persist, name: "site-contacts", modules: true, script: worker.outputFiles[0].text,
    compatibilityDate: "2025-08-01", d1Databases: { DB: "site-db" }, durableObjects: { VAULT: { className: "Vault", useSQLite: true }, CHATS: { className: "ChatStore", useSQLite: true } } });
  let mf = new Miniflare(opts), db;
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  await mf.ready; await (await mf.dispatchFetch("http://localhost/api/me")).arrayBuffer(); db = await mf.getD1Database("DB");
  const team = randomUUID(), other = randomUUID(), token = "c".repeat(43), now = new Date().toISOString(), sessions = {};
  for (const id of [team, other]) await db.prepare("INSERT INTO teams(id,name,created_at) VALUES(?,?,?)").bind(id, "Client test", now).run();
  for (const [role, target] of [["owner", team], ["member", team], ["other", other]]) {
    const id = randomUUID(), session = randomUUID(); sessions[role] = session;
    await db.prepare("INSERT INTO users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?)").bind(id, id, `${role}@example.test`, role, now).run();
    await db.prepare("INSERT INTO memberships(team_id,user_id,role,created_at) VALUES(?,?,?,?)").bind(target, id, role === "member" ? "member" : "owner", now).run();
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
  const sites = [];
  for (let i = 0; i < 30; i++) sites.push((await ok("/sites", { method: "POST", body: { clientName: "Imported site" } })).id);
  const otherSite = (await ok("/sites", { target: other, role: "other", method: "POST", body: { clientName: "Other tenant", address: "900 Other Road" } })).id;
  const template = randomUUID(), block = randomUUID();
  await db.prepare("INSERT INTO templates(id,team_id,name,doc,updated_at) VALUES(?,?,?,?,?)")
    .bind(template, team, "Service report", JSON.stringify({ tasks: [{ id: randomUUID(), name: "Visit", blocks: [{ id: block, kind: "text", label: "Notes", unit: "", options: [] }] }] }), now).run();
  const record = (i, seq = 0) => {
    const content = JSON.stringify({ note: `Original ${i}/${seq}`, amount: "00012.00" });
    return { siteId: sites[i], templateId: template, origin: { file: "visits.csv", externalId: `${i}-${seq}` },
      history: { schemaVersion: 1, sourceDocument: { schemaVersion: 1, mediaType: "application/json", content, sha256: hash(content) } },
      semantics: { schemaVersion: 1, client: { ...person, name: i < 2 ? "Bob Smith" : `Client ${i}`, emails: [`client${i}@example.com`], phones: [`(570) 555-${String(1000 + i)}`] },
        employee: { ...person, name: "Employee Person", emails: ["employee@example.com"], phones: ["5705550998"] },
        user: { ...person, name: "Uploader", emails: ["uploader@example.com"], phones: ["5705550999"] },
        date: { value: "2026-01-01", precision: "date" }, serviceAddresses: [`${10 + i} Main Street Albany NY`] } };
  };
  const records = Array.from({ length: 90 }, (_, i) => record(i % 30, Math.floor(i / 30)));
  let imported, originalReport;
  await t.test("older producer records populate names, addresses, emails and phones on the assigned sites", async () => {
    imported = await ok("/import", { method: "POST", body: { records } }); assert.equal(imported.filed, 90);
    for (const [i, id] of sites.entries()) {
      const site = await ok(`/sites/${id}`);
      assert.equal(site.clientName, record(i).semantics.client.name);
      assert.equal(site.address, `${10 + i} Main Street Albany NY`);
      assert.deepEqual(site.emails, [`client${i}@example.com`]); assert.deepEqual(site.phones, [`(570) 555-${1000 + i}`]);
    }
    assert.notEqual(sites[0], sites[1], "same client names do not merge different sites");
    originalReport = await ok(`/reports/${imported.results[0].id}`);
    assert.deepEqual(originalReport.history, records[0].history);
    assert.equal(originalReport.semantics.employee.name, "Employee Person");
  });
  await t.test("curated site fields survive duplicate imports and missing PATCH fields preserve phone/address", async () => {
    const existing = await ok(`/sites/${sites[0]}`);
    await ok(`/sites/${sites[0]}`, { method: "PATCH", body: { ...existing, clientName: "Our customer", emails: ["verified@example.com"], phones: ["5705550888"], address: "99 Corrected Lane" } });
    const replay = await ok("/import", { method: "POST", body: { records } }); assert.equal(replay.filed, 0); assert.ok(replay.results.every(r => r.duplicate));
    const curated = await ok(`/sites/${sites[0]}`); assert.equal(curated.clientName, "Our customer"); assert.equal(curated.address, "99 Corrected Lane");
    assert.deepEqual(curated.emails, ["verified@example.com"]); assert.deepEqual(curated.phones, ["5705550888"]);
    const { address, phones, ...oldClientBody } = curated;
    await ok(`/sites/${sites[0]}`, { method: "PATCH", body: oldClientBody });
    const saved = await ok(`/sites/${sites[0]}`); assert.equal(saved.address, address); assert.deepEqual(saved.phones, phones);
  });
  await t.test("a reused source ID cannot enrich a different site with another client's contacts", async () => {
    const before = await ok(`/sites/${sites[2]}`);
    const bad = { ...records[0], siteId: sites[2] };
    const result = await ok("/import", { method: "POST", body: { records: [bad] } }); assert.equal(result.filed, 0); assert.match(result.results[0].error, /different site/);
    assert.deepEqual(await ok(`/sites/${sites[2]}`), before);
  });
  await t.test("new client aliases extend imported lists and case/phone formatting does not create duplicates", async () => {
    const next = record(2, 99); next.semantics.client.emails.push("RECEIPT@example.com", "CLIENT2@EXAMPLE.COM"); next.semantics.client.phones.push("+1 570 555 1002");
    assert.equal((await ok("/import", { method: "POST", body: { records: [next] } })).filed, 1);
    const site = await ok(`/sites/${sites[2]}`); assert.deepEqual(site.emails, ["client2@example.com", "receipt@example.com"]); assert.deepEqual(site.phones, ["(570) 555-1002"]);
  });
  await t.test("bounded recovery repairs previously lost details from Vault without rewriting reports", async () => {
    for (const id of sites.slice(1)) await db.prepare("UPDATE sites SET client_name=address,address='',emails='[]',phones='[]',imported_contacts=NULL,location_note=client_name WHERE id=?").bind(id).run();
    let after = null, checked = 0, updated = 0, pages = 0;
    do { const page = await ok("/sites/recover-contacts", { method: "POST", body: { after } }); assert.ok(page.processedSites <= 25); checked += page.processedSites; updated += page.updatedSites; after = page.nextCursor; pages++; } while (after);
    assert.equal(pages, 2); assert.equal(checked, 30); assert.equal(updated, 29);
    const recovered = await ok(`/sites/${sites[1]}`); assert.equal(recovered.clientName, "Bob Smith"); assert.equal(recovered.address, "11 Main Street Albany NY");
    assert.deepEqual(recovered.emails, ["client1@example.com"]); assert.deepEqual(recovered.phones, ["(570) 555-1001"]);
    assert.deepEqual(await ok(`/reports/${imported.results[0].id}`), originalReport);
    assert.deepEqual((await ok(`/sites/${sites[0]}`)).emails, ["verified@example.com"]);
    assert.equal((await ok(`/sites/${otherSite}`, { target: other, role: "other" })).clientName, "Other tenant");
  });
  await t.test("recovery requires team admin membership and never recreates deleted sites", async () => {
    for (const [options, status] of [[{ role: "member" }, 403], [{ role: "other" }, 404], [{ role: "none" }, 401], [{ headers: { authorization: `Bearer aludel_${token}` } }, 403]]) {
      assert.equal((await call("/sites/recover-contacts", { method: "POST", body: {}, ...options })).status, status);
    }
    await ok(`/sites/${sites[29]}`, { method: "DELETE" });
    let after = null;
    do { const page = await ok("/sites/recover-contacts", { method: "POST", body: { after } }); assert.equal(page.updatedSites, 0); after = page.nextCursor; } while (after);
    assert.equal((await call(`/sites/${sites[29]}`)).status, 404);
  });
  await t.test("stored client phones are sent back to Breakfast as tenant binding priors and survive restart", async () => {
    await mf.dispose(); mf = new Miniflare(opts); await mf.ready; db = await mf.getD1Database("DB");
    const stream = await withSiteProfiles({ DB: db }, team, new Headers({ "content-type": "multipart/form-data; boundary=test-boundary" }), new Response("--test-boundary--\r\n").body);
    const body = await new Response(stream).text(), json = body.split("\r\n\r\n")[1].split("\r\n")[0], profile = JSON.parse(json);
    const restored = profile.sites.find(s => s.siteId === sites[1]); assert.deepEqual(restored.observations[0].fields.client_phone, ["(570) 555-1001"]);
    assert.deepEqual(restored.observations[0].fields.client_email, ["client1@example.com"]);
    assert.ok(!body.includes("employee@example.com") && !body.includes("uploader@example.com") && !body.includes(otherSite));
  });
});
