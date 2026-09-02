# ALUDEL

Dirt-simple form template builder on Cloudflare Workers + D1.

**Templates**: Templates → Tasks (molecules) → Blocks (atoms: Photo, Text, Number, Buttons).
A task is just a name and an ordered list of blocks; a Buttons block is a prompt with one to six
named keys (two by default) and is placed like any other block —
invalid states are unrepresentable, and the server re-validates every document through the same
`src/shared/model.ts` gate before it touches the database. A save names the version it was
edited from, so two people on the same template get a 409 instead of silently overwriting each other.

**Sites**: Lists → Worksites → Dispatches. A worksite is a client name, a location and up to ten
contact emails, sitting in at most one list (lists are containers of worksites). A location is a
real Google place, not typed text: picked with the current Places autocomplete, plotted on a map,
and stored as a normalized `AludelPlace` record (place id, name, formatted address, lat/lng,
viewport, address parts, fetch time) that the server re-validates through `normalizePlace`. Dispatching *borrows* a
template for a worksite: the dispatch references the template rather than copying it, records the
version it was borrowed at, and the site's metadata rides along by association. A site can hold
one dispatch per template, and deleting a list leaves its sites in place, unlisted.

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

### Google Maps (locations)

Site locations use the Maps JavaScript API with the **new** Places classes
(`PlaceAutocompleteElement` + `gmp-select`, `Place.fetchFields`, `AdvancedMarkerElement`) —
none of the legacy Autocomplete / PlaceResult surface. One `fetchFields` call per pick, for
exactly the fields that are stored, so each selection bills one autocomplete session plus one
Place Details (Essentials/Pro) request; the live `Place` object is never persisted.

1. In the same Google Cloud project enable **Maps JavaScript API** and **Places API (New)**.
2. Create a browser API key, restrict it to **Websites** with your origin
   (`https://<your-domain>/*`), and restrict it to those two APIs.
3. Give the Worker the key as a plain var — it ships to the browser, the referrer restriction is
   what protects it — and optionally a Map ID (Cloud-based styling; advanced markers need one,
   `DEMO_MAP_ID` is the fallback):

```
GOOGLE_MAPS_BROWSER_KEY = "AIza..."
GOOGLE_MAPS_MAP_ID = "..."          # optional
```

Nothing from Google loads until the Location sheet is opened, and without a key the sheet says so
instead of failing quietly. `public/_headers` carries Google's documented CSP allow-list for the
Maps JavaScript API; the rest of the app stays `'self'`.

### Who may sign in

A Google client of type **External** lets any Google account reach the callback, so
authentication is not by itself a gate. Set `ALLOWED_EMAIL_DOMAINS` (a plain var, not a
secret) to restrict it:

```
ALLOWED_EMAIL_DOMAINS = "acme.com,acme.co.uk"
```

Sign-in then requires either an address on one of those domains, or a live invite for that
exact address — so contractors on other domains still work without opening the door. Leave
it unset and any Google account may sign in; they land in their own empty team and can
never see yours, but the account and team rows are theirs to create.

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

