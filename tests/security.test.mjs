import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const hash = value => createHash("sha256").update(value).digest("base64url");

test("integration credentials and public entry points are bounded", async t => {
  const worker = await build({
    entryPoints: ["src/worker/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    external: ["cloudflare:workers"],
  });
  const auth = await build({
    entryPoints: ["src/worker/auth.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
  });
  const { canSignIn } = await import(`data:text/javascript;base64,${Buffer.from(auth.outputFiles[0].text).toString("base64")}`);
  const persist = await mkdtemp(join(tmpdir(), "aludel-security-test-"));
  const mf = new Miniflare(convertV4MiniflareOptions({
    resourcePersistencePath: persist,
    name: "aludel-security-test",
    modules: true,
    script: worker.outputFiles[0].text,
    compatibilityDate: "2025-08-01",
    bindings: { GOOGLE_CLIENT_ID: "test-client" },
    d1Databases: { DB: "security-db" },
    durableObjects: {
      VAULT: { className: "Vault", useSQLite: true },
      CHATS: { className: "ChatStore", useSQLite: true },
    },
  }));
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  await mf.ready;
  await (await mf.dispatchFetch("http://localhost/api/me")).arrayBuffer();

  const db = await mf.getD1Database("DB");
  const now = new Date().toISOString();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const team = randomUUID(), otherTeam = randomUUID(), user = randomUUID();
  const session = "s".repeat(43), active = "a".repeat(43), expired = "e".repeat(43);
  await db.batch([
    db.prepare("INSERT INTO users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?)").bind(user, user, "owner@example.com", "Owner", now),
    db.prepare("INSERT INTO teams(id,name,created_at) VALUES(?,?,?)").bind(team, "Security", now),
    db.prepare("INSERT INTO teams(id,name,created_at) VALUES(?,?,?)").bind(otherTeam, "Other", now),
    db.prepare("INSERT INTO memberships(team_id,user_id,role,created_at) VALUES(?,?,?,?)").bind(team, user, "owner", now),
    db.prepare("INSERT INTO sessions(id,user_id,created_at,last_seen,expires_at) VALUES(?,?,?,?,?)").bind(hash(session), user, now, now, tomorrow),
    db.prepare("INSERT INTO tokens(id,team_id,name,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?)").bind(hash(active), team, "Active importer", user, now, tomorrow),
    db.prepare("INSERT INTO tokens(id,team_id,name,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?)").bind(hash(expired), team, "Expired importer", user, yesterday, yesterday),
  ]);
  const browser = { cookie: `aludel_session=${session}`, origin: "http://localhost", "content-type": "application/json" };
  const bearer = value => ({ authorization: `Bearer aludel_${value}`, "content-type": "application/json" });

  await t.test("active tokens are import-only and newly minted tokens expire", async () => {
    const allowed = await mf.dispatchFetch(`http://localhost/api/teams/${team}/import`, {
      method: "POST", headers: bearer(active), body: JSON.stringify({ records: [] }),
    });
    assert.equal(allowed.status, 422, await allowed.clone().text());
    assert.equal((await mf.dispatchFetch(`http://localhost/api/teams/${team}/reports`, { headers: bearer(active) })).status, 403);
    assert.equal((await mf.dispatchFetch(`http://localhost/api/teams/${otherTeam}/import`, {
      method: "POST", headers: bearer(active), body: JSON.stringify({ records: [{}] }),
    })).status, 404);
    assert.equal((await mf.dispatchFetch(`http://localhost/api/teams/${team}/import`, {
      method: "POST", headers: bearer(expired), body: JSON.stringify({ records: [{}] }),
    })).status, 401);

    const minted = await mf.dispatchFetch(`http://localhost/api/teams/${team}/tokens`, {
      method: "POST", headers: browser, body: JSON.stringify({ name: "New importer" }),
    });
    assert.equal(minted.status, 201, await minted.clone().text());
    const value = await minted.json();
    assert.equal(value.scope, "imports:write");
    assert.ok(Date.parse(value.expiresAt) > Date.now() + 89 * 86_400_000);
    const row = await db.prepare("SELECT scope, expires_at AS expiresAt FROM tokens WHERE id = ?").bind(value.id).first();
    assert.deepEqual(row, { scope: "imports:write", expiresAt: value.expiresAt });
  });

  await t.test("an invalid bearer credential never falls back to a valid cookie", async () => {
    const response = await mf.dispatchFetch(`http://localhost/api/teams/${team}/reports`, {
      headers: { ...browser, authorization: `Bearer aludel_${"x".repeat(43)}` },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Invalid or expired integration token" });
  });

  await t.test("sign-in is closed unless a domain, invite, or explicit public opt-in allows it", async () => {
    assert.equal(await canSignIn(db, "", "stranger@example.net"), false);
    assert.equal(await canSignIn(db, "", "stranger@example.net", true), true);
    assert.equal(await canSignIn(db, "EXAMPLE.COM", "person@example.com"), true);
    await db.prepare(
      "INSERT INTO invites(id,team_id,email,role,invited_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?)"
    ).bind(randomUUID(), team, "guest@example.net", "member", user, now, tomorrow).run();
    assert.equal(await canSignIn(db, "", "guest@example.net"), true);
  });

  await t.test("anonymous login and team creation return 429 with retry guidance", async () => {
    for (let i = 0; i < 20; i++) {
      const response = await mf.dispatchFetch("http://localhost/auth/login", { redirect: "manual", headers: { "cf-connecting-ip": "192.0.2.4" } });
      assert.equal(response.status, 302);
    }
    const blockedLogin = await mf.dispatchFetch("http://localhost/auth/login", { redirect: "manual", headers: { "cf-connecting-ip": "192.0.2.4" } });
    assert.equal(blockedLogin.status, 429);
    assert.ok(Number(blockedLogin.headers.get("retry-after")) > 0);

    for (let i = 0; i < 5; i++) {
      const response = await mf.dispatchFetch("http://localhost/api/teams", {
        method: "POST", headers: browser, body: JSON.stringify({ name: `Team ${i}` }),
      });
      assert.equal(response.status, 201, await response.clone().text());
    }
    const blockedTeam = await mf.dispatchFetch("http://localhost/api/teams", {
      method: "POST", headers: browser, body: JSON.stringify({ name: "One too many" }),
    });
    assert.equal(blockedTeam.status, 429);
    assert.ok(Number(blockedTeam.headers.get("retry-after")) > 0);
    const stored = await db.prepare("SELECT subject FROM rate_limits WHERE bucket = 'login'").first();
    assert.notEqual(stored.subject, "192.0.2.4", "raw client IPs are not stored");
  });
});

test("legacy integration credentials migrate to bounded import-only access", async t => {
  const worker = await build({
    entryPoints: ["src/worker/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    external: ["cloudflare:workers"],
  });
  const persist = await mkdtemp(join(tmpdir(), "aludel-token-migration-test-"));
  const mf = new Miniflare(convertV4MiniflareOptions({
    resourcePersistencePath: persist,
    name: "aludel-token-migration-test",
    modules: true,
    script: worker.outputFiles[0].text,
    compatibilityDate: "2025-08-01",
    d1Databases: { DB: "migration-db" },
    durableObjects: {
      VAULT: { className: "Vault", useSQLite: true },
      CHATS: { className: "ChatStore", useSQLite: true },
    },
  }));
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  await mf.ready;
  const db = await mf.getD1Database("DB");
  await db.prepare(
    `CREATE TABLE tokens (
       id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL,
       created_by TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
     )`
  ).run();
  const raw = "m".repeat(43), createdAt = "2020-01-01T00:00:00.000Z";
  await db.prepare("INSERT INTO tokens(id,team_id,name,created_by,created_at) VALUES(?,?,?,?,?)")
    .bind(hash(raw), randomUUID(), "Legacy", "test", createdAt).run();
  await (await mf.dispatchFetch("http://localhost/api/me")).arrayBuffer();

  const migrated = await db.prepare("SELECT scope, expires_at AS expiresAt FROM tokens WHERE id = ?")
    .bind(hash(raw)).first();
  assert.equal(migrated.scope, "imports:write");
  assert.match(migrated.expiresAt, /^2020-03-31[ T]00:00:00/);
  const response = await mf.dispatchFetch(`http://localhost/api/teams/${randomUUID()}/import`, {
    method: "POST",
    headers: { authorization: `Bearer aludel_${raw}`, "content-type": "application/json" },
    body: JSON.stringify({ records: [{}] }),
  });
  assert.equal(response.status, 401, "old credentials past their migrated expiry stop working");
});
