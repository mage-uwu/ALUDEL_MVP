/// <reference types="@cloudflare/workers-types" />

// Schema is created on demand so a fresh D1 database needs no migration step.
// Tenancy is pooled: every tenant-owned row carries team_id, and membership is
// what grants access to it — never a value the client hands us.
const TABLES = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     google_sub TEXT NOT NULL UNIQUE,
     email TEXT NOT NULL,
     name TEXT NOT NULL DEFAULT '',
     picture TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS teams (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS memberships (
     team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
     created_at TEXT NOT NULL,
     PRIMARY KEY (team_id, user_id)
   )`,
  // id is the SHA-256 of the session token: a database leak yields no usable cookie
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL,
     last_seen TEXT NOT NULL,
     expires_at TEXT NOT NULL
   )`,
  // one row per login attempt: holds the PKCE verifier, state and nonce server-side
  `CREATE TABLE IF NOT EXISTS login_flows (
     id TEXT PRIMARY KEY,
     state TEXT NOT NULL,
     verifier TEXT NOT NULL,
     nonce TEXT NOT NULL,
     return_to TEXT NOT NULL,
     expires_at TEXT NOT NULL
   )`,
  // id is the SHA-256 of the invite token; the raw token is shown once, never stored
  `CREATE TABLE IF NOT EXISTS invites (
     id TEXT PRIMARY KEY,
     team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
     email TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
     invited_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     accepted_at TEXT,
     accepted_by TEXT
   )`,
  // lists are containers of worksites; a site may sit in at most one
  `CREATE TABLE IF NOT EXISTS lists (
     id TEXT PRIMARY KEY,
     team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sites (
     id TEXT PRIMARY KEY,
     team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
     list_id TEXT REFERENCES lists(id) ON DELETE SET NULL,
     client_name TEXT NOT NULL,
     address TEXT NOT NULL DEFAULT '',
     emails TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS templates (
     id TEXT PRIMARY KEY,
     team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     doc TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  // a template borrowed by a worksite; one borrow of a given template per site
  `CREATE TABLE IF NOT EXISTS dispatches (
     id TEXT PRIMARY KEY,
     team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
     site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
     template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
     template_version INTEGER NOT NULL,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (site_id, template_id)
   )`,
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lists_team ON lists(team_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sites_team ON sites(team_id, list_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dispatches_site ON dispatches(site_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dispatches_template ON dispatches(template_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invites_team ON invites(team_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email)`,
  `CREATE INDEX IF NOT EXISTS idx_templates_team ON templates(team_id, updated_at DESC)`,
];

let ready: Promise<unknown> | null = null;

export function ensureSchema(db: D1Database): Promise<unknown> {
  return (ready ??= (async () => {
    await db.batch(TABLES.map((sql) => db.prepare(sql)));
    // databases created before tenancy existed still need the column, and it
    // has to land before anything indexes it
    const addColumn = (sql: string) =>
      db.prepare(sql).run().catch((e) => {
        if (!/duplicate column/i.test(String(e))) throw e;
      });
    await addColumn("ALTER TABLE templates ADD COLUMN team_id TEXT");
    // sites created before emails replaced phone
    await addColumn("ALTER TABLE sites ADD COLUMN emails TEXT NOT NULL DEFAULT '[]'");
    await db.batch(INDEXES.map((sql) => db.prepare(sql)));
  })()).catch((e) => {
    ready = null;
    throw e;
  });
}
