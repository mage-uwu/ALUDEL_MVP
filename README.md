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

**Map**: every located site on one map, pinned and numbered by list, with a line through each
list in its stored order. **Optimize** hands all located sites to the Google Maps Platform
**Route Optimization API** (a fleet VRP solver — not the Routes API, not Fleet Engine) for N
routes, an optional depot, a per-stop service time and a day window, then shows the plan: ordered
stops per route with arrival times, skipped sites with Google's reason, distance, time and cost.
*Apply to lists* turns it into lists named `Route 1…N`, sites in visit order, and the map draws
Google's road polylines for any list that still matches its route. Plans are built only from the
stored `AludelPlace` records; the plan itself is stored on the team, and every vehicle carries
`costPerHour` and `costPerKilometer` so the solver has something real to minimise.

### Route Optimization setup

The API takes OAuth only, so the Worker signs in as a service account (RS256 JWT → access token,
cached per isolate). In the same Cloud project:

1. Enable **Route Optimization API**.
2. IAM → Service accounts → create one, grant it the **Route Optimization Editor** role, and
   create a JSON key.
3. Give the Worker the whole key file as one secret:

```sh
wrangler secret put GOOGLE_SERVICE_ACCOUNT < aludel-optimizer-key.json
```

(In the dashboard: paste the file's entire contents as the value.) The three fields it needs are
`project_id`, `client_email` and `private_key`; they may instead be set as three secrets,
`GOOGLE_CLOUD_PROJECT`, `GOOGLE_SA_EMAIL` and `GOOGLE_SA_PRIVATE_KEY`. Until one form is complete
the Optimize sheet says so. Each run is one `optimizeTours` call
(30 s solver budget, 120 s above 40 stops, live traffic when the window starts within a day).

**Assistant**: the console beside the phone on wide screens, and an Assistant screen in the menu
on a phone, is a chat with xAI's Grok (`grok-4.6`). The Worker holds the key and adds a one-line
system prompt; replies stream back as plain text. Chats are saved: each user's live in their own
SQLite-backed **Durable Object** (`ChatStore`, keyed by user id), so one user's chats are separate
from everyone else's by construction, and the store scales per user rather than through one shared
database. The caret on the console opens the index — new chat, recent chats, delete — and the chat
you were in comes back on reload. The model sees the last 20 turns. Nothing else is wired in yet: no
team data, no tools. Set `XAI_API_KEY` as a secret; until then the pane says so. The Durable Object
needs no setup; Cloudflare provisions it on deploy.

**Field**: what a crew can file — every template dispatched to a site — and what was filed lately.
Pick one, fill it (text, numbers with their unit, one key of a buttons block; photos come next),
say when it was done, and file it. A report can only be filed against a dispatch, so it always
names a real site and a real template version.

**Vault**: every filed report, append-only, in the team's own SQLite-backed Durable Object
(`Vault`, keyed by team id). A report is the record: site, template and version, who, when, the
filled document and its SHA-256. Each filled block also becomes one typed **fact** row (number in
`num`, text and the pressed key in `text`, plus label, kind, unit and time), so a labelled block is
a series across the whole stack and the stack is queryable in one shape:

```jsonc
POST /api/teams/:id/vault/query
{ "template": "…", "site": "…", "from": "2025-11-01", "to": "2026-03-01",
  "where": [{ "label": "temp", "num": { "lt": 40 } }],            // every clause: some fact of the report matches
  "select": { "rows": true, "limit": 50 } }                        // or { "agg": "sum", "label": "cost", "groupBy": "site" }
```

Atoms are versioned by template: `{ "atom": { "template", "block" } }` names exactly one block of one
template, while `label` reaps every block whose label contains the word, across templates — similar,
but different, until you filter by template. The shape compiles to parameterised SQL inside the
team's object, so it cannot be injected and cannot cross teams; it is the tool an agent gets.

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

