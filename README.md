# ALUDEL

Dirt-simple form template builder on Cloudflare Workers + D1.

**Templates**: Templates → Tasks (molecules) → Blocks (atoms: Photo, Text, Number, Buttons).
A task is just a name and an ordered list of blocks; a Buttons block is a prompt with one to six
named keys (two by default) and is placed like any other block —
invalid states are unrepresentable, and the server re-validates every document through the same
`src/shared/model.ts` gate before it touches the database. A save names the version it was
edited from, so two people on the same template get a 409 instead of silently overwriting each other.

**Sites**: Lists → Worksites → Dispatches. A worksite is a client name, an address, up to ten
contact emails and up to ten phone numbers, sitting in at most one list (lists are containers
of worksites). Addresses can be retained as text before selecting a Google place.
A place is picked with the current Places autocomplete, plotted on a map,
and stored as a normalized `AludelPlace` record (place id, name, formatted address, lat/lng,
viewport, address parts, fetch time) that the server re-validates through `normalizePlace`. Dispatching *borrows* a
template for a worksite: the dispatch references the template rather than copying it, records the
version it was borrowed at, and the site's metadata rides along by association. A site can hold
one dispatch per template, and deleting a list leaves its sites in place, unlisted. Every row
carries a drag handle: the order you drag sites into, on Sites or on a Map card, is the list's
stored order, so it is the order the pins take and the route follows.

**Temporary beta cleanup:** owners/admins can use **Sites → Delete all sites…** and
type `DELETE ALL SITES` to permanently remove the team's sites, Field dispatches and
saved route plan. Lists, templates, Vault reports and original files remain available.
`DELETE /api/teams/:id/sites` requires the matching `teamId` and confirmation in its
JSON body, and returns `{deletedSites, deletedDispatches}`. Integration tokens and
ordinary members cannot use it. Active imports/recovery block deletion with `409`;
the D1 deletion is transactional and serialized with the team's import work. This
is separate from **Vault → Delete all…**, which removes historical paperwork.

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

**Field**: forms available to fill — every template dispatched to a site.
Pick one, fill it (text, numbers with their unit, one key of a buttons block; photos come next),
say when it was done, and file it. A report can only be filed against a dispatch, so it always
names a real site and a real template version.

**Vault**: a separate screen for completed submissions and historical paperwork. Filter by
template, site, and an inclusive work-date range; browse the full history in pages of 50.
Opening a report and going back preserves the filters and page. Filter choices come from saved
reports, so deleting a live site or template does not hide its historical paperwork. Imported
date-only records retain their written dates; timestamped work uses the viewer's calendar timezone.

`GET /api/teams/:id/vault/catalog` returns saved template/site identities and report counts.
`GET /api/teams/:id/vault/reports` accepts `template`, `site`, `from`, `to` (YYYY-MM-DD),
`timezone` (IANA name; defaults to UTC), `limit` (1–100; defaults to 50), and `cursor`.
It returns `{ reports, total, nextCursor }`. Both date endpoints are included; cursors belong
to the selected filters. These browsing routes do not change the existing `/reports` or
`/vault/query` API contracts.

**Temporary beta reset**: team owners/admins can choose **Delete all…** in Vault and type
`DELETE ALL`. This permanently clears every report, original file, indexed fact, pending
document and saved import job in that team, regardless of filters. Sites, templates and Field
dispatches remain. The API is `DELETE /api/teams/:id/vault/reports` with JSON
`{ "teamId": ":id", "confirmation": "DELETE ALL" }`; integration tokens and ordinary members
cannot call it. It returns `{ deletedReports, deletedImports }`, or HTTP 409 while imports or
manual filing are active. The reset is atomic and old import jobs cannot resume afterward.
Remove this temporary UI and endpoint when beta resets are no longer needed.

Filed reports are append-only during normal use, in the team's own SQLite-backed Durable Object
(`Vault`, keyed by team id). A report is the record: site, template and version, who, when, the
filled document or archived source and its SHA-256. Imported history is stored independently
of the generated template. Vault displays original source records and offers a byte-preserving
download through `GET /api/teams/:id/reports/:reportId/source`. CSV headers, duplicate columns,
empty cells, spacing and multiline notes survive; JSON retains its original record text, including
number spelling, nested values and duplicate keys. Source text is rendered as text, never active HTML.

An older producer that provides only values gets an explicitly labelled **Received data** view.
Pre-existing reconstructions are identified as such. Reimport can attach a missing original when
the recorded source fingerprint matches; a reused ID with different archived content requires review.
Original content is never replaced by subsequent imports. Template/site/date filters operate on
classification metadata and do not rewrite the source.

Each block filled in Field also becomes one typed **fact** row (number in
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

### Importing old documents

Open **Imports** in the section menu to send documents directly to Breakfast.
Choose PDFs, ZIP, CSV/TSV, JSON/JSONL, text or Markdown files (64 MiB including multipart
framing) and the timezone used on the paperwork. Breakfast extracts embedded PDF text
and OCRs scanned pages before the existing format/site pipeline. Each PDF stays one
document with all its pages. DOCX and standalone images still need conversion first.
Processing and filing continue in the
team's existing Vault Durable Object after the page closes. Recent imports show
progress, filed/duplicate/pending/rejected counts and documents awaiting review.

Configure the ALUDEL Worker's `BREAKFAST_KEY` runtime secret with **the same
secret value** as Breakfast's `BFAST_API_KEY`:

```sh
npx wrangler secret put BREAKFAST_KEY
```

The legacy ALUDEL name `BFAST_API_KEY` is also accepted. If both are set,
`BREAKFAST_KEY` takes precedence. A blank value falls back to the legacy name.

The production service is
`https://breakfast-tm-container.lafayettejcompton.workers.dev`. Credentials remain
server-side; no browser CORS setup or extra ALUDEL integration token is needed
for this built-in flow. No new Cloudflare binding or migration is required.
Until the secret exists, Imports explains that the connection is not configured.

The app submits once, polls Breakfast with durable alarms, and downloads the
completed `/v1/pipeline/jobs/:jobId/database` export one page at a time (`/import`
is a compatibility fallback for older Breakfast deployments). Each
page, catalog mapping, snapshot and next cursor is committed together in the
team's Vault SQLite storage. No records file until the complete manifest is
staged and its counts match. Filing then processes fifty items at a time through
the same validation gate as `/import`.
Each upload gets a local UUID (`X-Import-Id`); repeating that UUID returns the
existing job without resending its files. A lost upload confirmation is shown as
uncertain and is never automatically retried. An explicit 429 reports Breakfast's
`Retry-After`. Transfer and filing retries are idempotent and can resume after
interruptions or repeated errors. A changed Breakfast snapshot restarts staging
before filing, so two versions cannot be mixed. Requests are authorized before
accessing the team's queue.

Template IDs use stable field identities, types and explicit format discriminators;
compatible existing templates retain their tasks, units, options and versions.
Aludel sends existing site profiles to Breakfast's binder so resolved records reuse
the team's worksite IDs. Records use the source `externalId` for deduplication.
Existing templates and edited site details remain authoritative. Imports fill missing
site details and extend contacts previously managed by imports. Address-only sites
retain their source address for the place picker. Identifier fields and constants stay text,
choices keep their keys, and dates retain their resolved precision. Native records
without a site or valid date remain complete in the team's manual review queue.
Historical field values do not have to fit the generated template.

Each transfer response is bounded to 1 MiB and 256 items; total result size is
not subject to the former 16 MiB graph cap. The queue holds only the current
page and its referenced catalog mappings in Worker memory. Learned field IDs,
types, choice options, client/site identities, resolved dates and source origins
use the shared resolved contract. Individual staged records and templates have a
960 KiB limit; an oversized native source row pauses transfer explicitly.
ALUDEL retains job checkpoints, imported field payloads, unresolved documents and
filed reports, including original PDFs and text source records. Whole ZIP/multipart upload
containers remain in Breakfast. TRANSMUTE is disabled
for these imports, and normal jobs bypass GraphTM training and graph expansion.

Deploy Breakfast's paginated import endpoint before this ALUDEL update. Existing
jobs that failed with "The processed result is too large" gain a **Resume import**
action, which retrieves their completed Breakfast result without reuploading or
rerunning classification. This requires that Breakfast still has the completed
result; no new Cloudflare secret or binding is required.

Authenticated team routes:

| Route | Purpose |
| --- | --- |
| `GET /api/teams/:id/breakfast/jobs` | Connection configuration and the 30 latest team jobs. |
| `POST /api/teams/:id/breakfast/jobs?timezone=...&name=...` | Multipart upload; requires UUID `X-Import-Id`; returns 202 with the local job. |
| `GET /api/teams/:id/breakfast/jobs/:jobId` | Progress, counts and up to 50 record errors. |
| `POST /api/teams/:id/breakfast/jobs/:jobId/resume` | Resume result transfer or filing from saved progress, without another Breakfast upload. |
| `GET /api/teams/:id/reports/:reportId/source` | Download the original; PDFs support byte ranges and `?inline=1`. |
| `GET /api/teams/:id/breakfast/jobs/:jobId/pending/:seq/source` | View/download the original while a document awaits manual filing. |

Original PDFs use the tenant's existing SQLite Vault, with no new bucket or credentials.
The producer sends 384 KiB binary chunks inside bounded `source_chunk` import items.
The queue validates each chunk, stages bytes once outside report JSON, and verifies the
entire file using a streaming SHA-256 before filing or serving it. Restarts/resumes reuse
staged chunks; reused hashes with conflicting bytes fail. PDFs up to the existing
256 MiB archive-member bound do not encounter the 960 KiB historical-row limit.
Uncertain extraction remains visible in manual review with the preserved PDF available.

Vault renders the original with a pinned PDF.js build, page navigation and zoom; source
downloads preserve every byte. Rendering uses canvas only, with no PDF scripts or active
form editing. PDF.js loads on demand; worker code, fonts, CMaps and decoders are served
from Aludel's own static assets. `npm run build` copies those version-matched resources.
PDF rendering is independent of generated Aludel template definitions.

`npm test` runs the graph mapper and the actual Worker, D1, and SQLite Durable
Objects in Miniflare against a local fake Breakfast server. It covers auth,
cross-team access, multipart forwarding, progress recovery, duplicate imports,
original-source fidelity, uncertain uploads and persisted jobs. Transfer regressions cover
results above 16 MiB, cursor recovery across restarts, changed snapshots, manifest
count mismatches, oversized chunked pages, and recovery of prior size failures.
The tests do not call production.

A sidecar that reads old paperwork archives it in the same Vault, organized by template, site
and work date. Imported history does not pass through form validation and does not manufacture
template-derived fact rows. Numeric/field fact queries apply to Field submissions and existing
legacy fact rows; report counts and template/site/date browsing include both kinds of history.
The sidecar authenticates with an
**integration token** (Members → Integrations; shown once, stored hashed, revocable) which acts as a
*member* of one team and nothing else: no `/me`, no chats, no other team, no admin routes.

```
POST /api/teams/<team id>/import
Authorization: Bearer aludel_<token>
Content-Type: application/json
```

```jsonc
{ "records": [                                   // 1–200 per call; at most 1 MiB total
  { "siteId": "<uuid>",                          // an existing site of the team (resolve addresses before you get here)
    "templateId": "<uuid>",                      // an existing template; create it first via POST /templates + PUT if the TM minted a new proto-type
    "performedAt": "2024-01-17T14:00:00Z",       // when the work was done, ISO 8601, in the past
    "byName": "R. Ortiz",                        // optional: the technician named on the document; else the token's name
    "history": {
      "schemaVersion": 1,
      "sourceDocument": {
        "schemaVersion": 1,
        "mediaType": "application/json",        // also text/csv, text/tab-separated-values, text/plain, text/markdown
        "content": "{\"notes\":\"  Leak at the valve  \"}",
        "sha256": "<SHA-256 hex of the exact UTF-8 content>"
      }                                          // CSV/TSV also include the original delimiter
    },                                           // no template field mapping, coercion, trimming, or truncation
    "origin": {                                  // provenance — required
      "file": "2024-jan.pdf",                    // required
      "sha256": "<64 hex>",                      // recommended: with page, makes the record idempotent
      "page": 3,
      "confidence": 0.93,                        // 0–1, the classifier's confidence
      "externalId": "doc-8812"                   // optional: your own id; wins over sha256+page as the idempotency key
    } } ] }
```

Response: `{ "filed": n, "results": [{ "index", "id" } | { "index", "id", "duplicate": true } | { "index", "error" }] }`,
one entry per record in order. A record whose `externalId`, or `sha256` + `page`, was filed before
comes back as a duplicate with the earlier id, so re-running a batch never files twice. A dispatch
for the site and template is made on the spot if the app never dispatched it. Imported reports carry
their `origin` and show as *imported* in Vault.

Sources are checked against their SHA-256 before filing. An individual history record is bounded
to 960 KiB; oversized records fail explicitly without dropping content. Legacy API clients may
still send a `values` object in place of `history`; every supplied value is preserved in
`history.receivedValues` and is not described as an original source. Report detail responses add
`history`; imported reports have an empty `doc.tasks`, while Field reports retain their filled doc.

**From the sidecar's graph export.** `tools/import-graph.mjs` reads the sidecar's graph
(record → fact → block → template, plus site and employee; classifier nodes are ignored) and
files it through the gate above. Zero dependencies, Node 18+:

```
node tools/import-graph.mjs graph.json --team <id> --token aludel_… --base https://<host> [--dry]
```

`--dry` prints the plan and writes nothing. Otherwise a template the map file has never seen is
created from its blocks. A block's kind is what the export declares (`valueKind`: number,
identifier and date/time as text, choice → buttons with its `choiceOptions`, image → photo,
constant → left on the form) and, for an export that declares nothing, inferred from every value
the corpus filed under it (all numeric → number; a closed set of 2–6 short keys → buttons; image
filenames → photo; the same paragraph on every record → left on the form). Blocks are labelled by
the export's `conceptDisplayName` so one series lines up across forms (`--form-labels` keeps each
form's own wording). A site is created from its address with the address as the location note
and the place left for the picker, and both are remembered in `aludel-map.json` so a rerun reuses
them. A record's `performedAt` is its date of service and time of service in the shop's zone
(`--tz`, else the graph's `timezone`, else America/New_York), and its identity is the export's
`externalId`, so a rerun never files twice.

Working notes on the whole ingest path and the query DSL, for whoever configures the sidecar:
[`docs/INGEST.md`](docs/INGEST.md).

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


Breakfast semantic contract
---------------------------

New Breakfast graph records include `properties.semantics.schemaVersion: 1`.
The importer uses its resolved client/employee/user identities and date instead
of inferring them from display labels. Template and block IDs are independent
of LLM display wording. Existing graphs without the contract retain the legacy
adapter.

A resolved date has `value` and `precision` (`date` or `timestamp`). Date-only
records retain `YYYY-MM-DD` in storage and display as dates without a fabricated
clock. A null date stays unfiled with a reason, even if raw fields contain another
date. An unknown worker name stays empty and does not become the uploader or an
email username. Unsupported versions and malformed resolved dates are rejected.

Deploy the compatible importer before the Breakfast contract update. Cached
completed jobs must be re-imported to populate resolved semantics. Changing the
schema identity calculation can create new templates when re-importing records
previously imported with the display-dependent calculation; existing templates
are not migrated or deleted.


### Native Breakfast database imports

Breakfast's normal path retains Tsetlin format sorting and label minting, then
resolves semantics and binds sites without GraphTM training or graph expansion.
Aludel consumes `/database` in bounded, resumable pages (with a legacy `/import`
fallback). Templates and sites precede records, which are ordered by site and format.

The importer reuses compatible templates by stable field identity and existing
site IDs. Batch-local format numbers and renamed display labels do not create new
objects. Existing template tasks, options, units, versions and site settings remain
authoritative. The team's existing site directory is supplied as a streamed binding
profile part; contacts belonging to employees/users remain separate from clients.
Each site/template pair has one dispatch: 60 reports of one format at four sites
create one template and four stacks. Replayed documents use the existing origin
idempotency key. Filing batches reuse site, template and dispatch lookups.

Native site rows carry the resolved `client` contract. Client names, service addresses,
emails and phones populate the D1 site directory; older producers can supply these
through record semantics. Staff and uploader contacts never become client contacts.
Email casing and phone formatting are deduplicated, and saved phones are included in
the existing-site profiles sent back to Breakfast. Import-managed contact lists can
gain aliases; changing or clearing a list manually makes that list authoritative.

For already imported history, an owner/admin can use **Sites → Update sites from
Vault**. It fills missing details from the saved client semantics of approved reports,
25 sites per request. It preserves edited site details, skips deleted sites, and does
not rewrite paperwork or rerun classification. Reports lacking resolved semantics
cannot supply these details automatically.

Unresolved documents are saved in the team's SQLite Vault, including original
values, provenance, binding evidence and unknown dates. **Review documents** on an
import opens these saved documents; choose a site and supply a date when missing.
Manual filing does not require Breakfast or another upload. Records whose fields
cannot fit a native form remain pending instead of silently losing those fields.
Final reports retain the resolved client/employee/user/date contract. Imported
field identities and semantic roles are stored with template definitions.

Database export is a versioned relational JSON contract, not LLM-generated SQL.
Aludel's existing D1 objects and SQLite Vault remain the storage model.
