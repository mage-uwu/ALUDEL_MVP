# ALUDEL

Dirt-simple form template builder on Cloudflare Workers + D1.

**Model**: Templates → Tasks (molecules) → Blocks (atoms: Photo, Text, Number, Button).
A task is just a name and an ordered list of blocks; buttons are placed like any other block —
invalid states are unrepresentable, and the server re-validates every document through the same
`src/shared/model.ts` gate before it touches the database.

## Auth and tenancy

Sign-in is Google OAuth (authorization code + PKCE, with `state` and `nonce`), and every
row of application data belongs to a team.

- **Sessions** are opaque 256-bit tokens. Only their SHA-256 hash is stored, so a database
  dump yields no usable cookie. Cookies are `HttpOnly; Secure; SameSite=Lax`, rotated on
  login, dropped on logout, with a 7-day idle and 30-day absolute lifetime.
- **Tenancy** is pooled on `team_id`. A team id in a URL grants nothing on its own: one
  guard (`requireMember`) turns it into a role by looking up a membership row, and every
  team route runs behind it, so no handler can reach another team's data by forgetting a
  filter. A team you do not belong to is indistinguishable from one that does not exist.
- **Roles** are `owner` > `admin` > `member`. Admins invite and remove people; owners
  additionally change roles and delete the team. A team can never be left without an owner.
- **Invites** are single-use tokens (hash stored, raw shown once), expire in 7 days, and
  are bound to the address they were issued to — holding the link is not enough.
- **CSRF**: `SameSite=Lax` plus an `Origin` check on every mutation.

### Google setup

1. In the Google Cloud console create an OAuth 2.0 **Web application** client.
2. Add `https://<your-domain>/auth/callback` as an authorized redirect URI.
3. Give the Worker the credentials as secrets (never commit them):

```sh
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

For local development put the same two keys in `.dev.vars` (gitignored). If the Worker is
served on a different origin than the request host, set `APP_ORIGIN` as a var.

## Develop

```sh
npm install
npm run dev          # builds the client, then wrangler dev on http://localhost:8787
```

## Deploy

```sh
wrangler d1 create aludel          # put the returned id into wrangler.jsonc
npm run deploy
```

No migration step: the Worker creates its tables on demand (`CREATE TABLE IF NOT EXISTS`),
so a fresh D1 database works on the first request.

## Layout

- `src/shared/model.ts` — types + the one validation/clamping gate (shared client/server)
- `src/worker/schema.ts` — D1 schema, created on demand
- `src/worker/auth.ts` — OAuth, sessions, and the membership guard
- `src/worker/index.ts` — zero-dependency Worker: team-scoped JSON routes
- `src/client/` — React builder UI (mobile-first, frosted glass; live console pane on wide screens)

Templates created before tenancy have a `NULL` team_id and belong to no team, so they are
not served to anyone. To adopt them into a team:

```sh
wrangler d1 execute aludel --remote --command \
  "UPDATE templates SET team_id = '<team-id>' WHERE team_id IS NULL"
```

