import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("Vault browses completed paperwork through the real Worker, D1 and tenant SQLite", { timeout: 120_000 }, async t => {
  const worker = await build({ entryPoints: ["src/worker/index.ts"], bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:workers"] });
  const persist = await mkdtemp(join(tmpdir(), "aludel-vault-test-"));
  const mf = new Miniflare(convertV4MiniflareOptions({
    resourcePersistencePath: persist, name: "aludel-vault-test", modules: true,
    script: worker.outputFiles[0].text, compatibilityDate: "2025-08-01",
    d1Databases: { DB: "test-db" },
    durableObjects: { VAULT: { className: "Vault", useSQLite: true }, CHATS: { className: "ChatStore", useSQLite: true } },
  }));
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  await mf.ready;
  await (await mf.dispatchFetch("http://localhost/api/me")).arrayBuffer();
  const db = await mf.getD1Database("DB"), teamA = randomUUID(), teamB = randomUUID();
  const tokenA = "a".repeat(43), tokenB = "b".repeat(43), now = new Date().toISOString();
  for (const [id, token] of [[teamA, tokenA], [teamB, tokenB]]) {
    await db.prepare("INSERT INTO teams(id,name,created_at) VALUES(?,?,?)").bind(id, "Vault test", now).run();
    await db.prepare("INSERT INTO tokens(id,team_id,name,created_by,created_at) VALUES(?,?,?,?,?)")
      .bind(createHash("sha256").update(token).digest("base64url"), id, "Vault test", "test", now).run();
  }
  const call = async (path, { team = teamA, token = tokenA, body } = {}) => {
    const res = await mf.dispatchFetch(`http://localhost/api/teams/${team}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer aludel_${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, data: await res.json() };
  };
  const ok = async (path, options) => {
    const res = await call(path, options);
    assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res));
    return res.data;
  };
  const browse = params => ok(`/vault/reports?${new URLSearchParams(params)}`);
  const siteA = randomUUID(), siteB = randomUUID(), unusedSite = randomUUID();
  for (const [id, name, address] of [[siteA, "Bob Smith", "10 Evergreen Lane"], [siteB, "Bob Smith", "20 Cheshire Lane"], [unusedSite, "No paperwork yet", "30 Birch Lane"]]) {
    await db.prepare("INSERT INTO sites(id,team_id,client_name,address,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .bind(id, teamA, name, address, now, now).run();
  }
  const templateA = randomUUID(), templateB = randomUUID(), unusedTemplate = randomUUID(), block = randomUUID();
  const doc = { tasks: [{ id: randomUUID(), name: "Service", blocks: [{ id: block, kind: "text", label: "Notes", unit: "", options: [] }] }] };
  for (const [id, name] of [[templateA, "Repair report"], [templateB, "Invoice"], [unusedTemplate, "Unused form"]]) {
    await db.prepare("INSERT INTO templates(id,team_id,name,doc,updated_at) VALUES(?,?,?,?,?)")
      .bind(id, teamA, name, JSON.stringify({ ...doc, name }), now).run();
  }
  const person = { name: null, firstName: null, lastName: null, emails: [], phones: [] };
  const record = (label, date, siteId = siteA, templateId = templateA) => ({
    siteId, templateId, performedAt: date, values: { [block]: label },
    origin: { file: "history.csv", externalId: label },
    ...(date.length === 10 ? { semantics: { schemaVersion: 1, client: person, employee: person, user: person, date: { value: date, precision: "date" }, serviceAddresses: [] } } : {}),
  });
  const source = [
    ...Array.from({ length: 60 }, (_, i) => record(`same-time-${i}`, "2024-06-01T12:00:00.000Z")),
    record("other-site", "2024-06-01", siteB), record("other-template", "2024-06-01", siteA, templateB),
    record("spring-before", "2024-03-10T04:59:59.999Z"),
    record("spring-start", "2024-03-10T05:00:00.000Z"), record("spring-date", "2024-03-10"),
    record("spring-end", "2024-03-11T03:59:59.999Z"), record("spring-after", "2024-03-11T04:00:00.000Z"),
    record("fall-before", "2024-11-03T03:59:59.999Z"),
    record("fall-start", "2024-11-03T04:00:00.000Z"), record("fall-date", "2024-11-03"),
    record("fall-end", "2024-11-04T04:59:59.999Z"), record("fall-after", "2024-11-04T05:00:00.000Z"),
  ];
  const imported = await ok("/import", { body: { records: source } });
  assert.equal(imported.filed, source.length, JSON.stringify(imported));
  const ids = new Map(source.map((r, i) => [r.origin.externalId, imported.results[i].id]));

  await t.test("Field dispatches and completed submissions have distinct lists", async () => {
    const dispatches = await ok("/dispatches");
    assert.equal(dispatches.length, 3);
    assert.ok(dispatches.every(d => !d.performedAt && !d.origin));
    const dispatch = dispatches.find(d => d.siteId === siteB && d.templateId === templateA);
    const filed = await ok("/reports", { body: { dispatchId: dispatch.id, performedAt: "2024-06-02T12:00:00.000Z", values: { [block]: "Filed by the crew" } } });
    const history = await browse({ site: siteB, template: templateA });
    assert.equal(history.total, 2);
    assert.equal(history.reports[0].id, filed.id);
    assert.equal(history.reports[0].origin, null);
    assert.equal(history.reports[1].origin.externalId, "other-site");
    assert.equal((await ok("/dispatches")).length, 3, "filing does not add another form to Field");
  });
  await t.test("pagination reaches every record, including repeated work timestamps", async () => {
    const first = await browse({});
    assert.equal(first.total, source.length + 1);
    assert.equal(first.reports.length, 50);
    assert.ok(first.nextCursor);
    const seen = new Set(first.reports.map(r => r.id));
    const second = await browse({ cursor: first.nextCursor });
    assert.equal(second.total, first.total);
    assert.equal(second.nextCursor, null);
    for (const r of second.reports) { assert.ok(!seen.has(r.id)); seen.add(r.id); }
    assert.equal(seen.size, first.total);
    assert.deepEqual((await browse({})).reports.map(r => r.id), first.reports.map(r => r.id));
    const narrowed = { site: siteA, template: templateA, from: "2024-06-01", to: "2024-06-01", limit: "17" };
    let page, cursor, matches = [];
    do {
      page = await browse({ ...narrowed, ...(cursor ? { cursor } : {}) });
      assert.equal(page.total, 60);
      matches.push(...page.reports.map(r => r.id)); cursor = page.nextCursor;
    } while (cursor);
    assert.equal(matches.length, 60); assert.equal(new Set(matches).size, 60);
  });
  await t.test("template, site, and inclusive work-date filters combine by stable identity", async () => {
    assert.equal((await browse({ template: templateB })).total, 1);
    const june = await browse({ site: siteA, template: templateA, from: "2024-06-01", to: "2024-06-01", limit: "100" });
    assert.equal(june.total, 60);
    assert.ok(june.reports.every(r => r.siteId === siteA && r.templateId === templateA));
    const endpoints = await browse({ site: siteB, from: "2024-06-01", to: "2024-06-02" });
    assert.equal(endpoints.total, 2);
    assert.equal((await browse({ from: "2024-06-02", to: "2024-06-02" })).total, 1);
    assert.equal((await browse({ template: unusedTemplate })).total, 0);
  });
  await t.test("calendar days retain date-only records and handle 23/25-hour daylight-saving days", async () => {
    for (const [date, prefix] of [["2024-03-10", "spring"], ["2024-11-03", "fall"]]) {
      const page = await browse({ from: date, to: date, timezone: "America/New_York" });
      assert.deepEqual(new Set(page.reports.map(r => r.id)), new Set(["start", "date", "end"].map(s => ids.get(`${prefix}-${s}`))));
      assert.equal(page.reports.find(r => r.id === ids.get(`${prefix}-date`)).performedAt, date);
    }
    const east = await browse({ from: "2024-03-10", to: "2024-03-10", timezone: "Asia/Tokyo" });
    assert.ok(east.reports.some(r => r.id === ids.get("spring-date")), "a written date does not shift with the viewer's timezone");
  });
  await t.test("invalid dates, filters, page sizes and mismatched cursors fail explicitly", async () => {
    for (const p of [
      { from: "2024-02-30" }, { to: "not-a-date" }, { from: "2024-06-02", to: "2024-06-01" },
      { timezone: "Mars/Olympus" }, { site: "bad" }, { template: "bad" }, { limit: "0" }, { limit: "101" }, { limit: "2.5" }, { cursor: "bad" },
    ]) assert.equal((await call(`/vault/reports?${new URLSearchParams(p)}`)).status, 422, JSON.stringify(p));
    const first = await browse({});
    assert.equal((await call(`/vault/reports?${new URLSearchParams({ cursor: first.nextCursor, template: templateA })}`)).status, 422);
  });
  await t.test("saved catalog and reports survive removal of live sites and templates", async () => {
    let catalog = await ok("/vault/catalog");
    assert.deepEqual(new Set(catalog.templates.map(x => x.id)), new Set([templateA, templateB]));
    assert.deepEqual(new Set(catalog.sites.map(x => x.id)), new Set([siteA, siteB]));
    assert.equal(catalog.sites.find(x => x.id === siteA).address, "10 Evergreen Lane");
    assert.equal(catalog.sites.find(x => x.id === siteB).address, "20 Cheshire Lane");
    await db.prepare("UPDATE templates SET name = ? WHERE id = ?").bind("A renamed repair form", templateA).run();
    assert.equal((await ok("/vault/catalog")).templates[0].name, "A renamed repair form");
    await db.prepare("DELETE FROM sites WHERE id = ?").bind(siteA).run();
    await db.prepare("DELETE FROM templates WHERE id = ?").bind(templateA).run();
    catalog = await ok("/vault/catalog");
    assert.equal(catalog.templates.find(x => x.id === templateA).name, "Repair report");
    assert.equal(catalog.sites.find(x => x.id === siteA).name, "Bob Smith");
    assert.equal((await browse({ site: siteA, template: templateA })).total, 70);
    const report = await ok(`/reports/${ids.get("same-time-0")}`);
    assert.equal(report.templateName, "Repair report");
    assert.equal(report.history.receivedValues[block], "same-time-0");
  });
  await t.test("history, catalog and report contents remain isolated by team", async () => {
    assert.equal((await call("/vault/catalog", { team: teamB })).status, 404);
    assert.equal((await call("/vault/reports", { team: teamB })).status, 404);
    const other = { team: teamB, token: tokenB };
    assert.deepEqual(await ok("/vault/catalog", other), { templates: [], sites: [] });
    assert.deepEqual(await ok("/vault/reports", other), { reports: [], total: 0, nextCursor: null });
    assert.equal((await call(`/reports/${ids.get("same-time-0")}`, other)).status, 404);
    const res = await mf.dispatchFetch(`http://localhost/api/teams/${teamA}/vault/reports`);
    assert.equal(res.status, 401); await res.arrayBuffer();
  });
});
