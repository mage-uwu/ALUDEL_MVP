# Ingest and the vault — working notes

What the sidecar needs to know to file paperwork into ALUDEL, and what the
"magic calculator" does with it once it is there. Written from a read of
`src/worker/index.ts` (`/import`, `/reports`, `/vault/query`),
`src/worker/vault.ts`, `src/shared/model.ts` and `tools/import-graph.mjs`.

```
sidecar graph ──(tools/import-graph.mjs)──▶ POST /api/teams/<id>/import ──▶ Vault DO (per team)
                                             Bearer aludel_…                 reports + facts
phone (Field) ─────────────────────────────▶ POST /api/teams/<id>/reports ──▶   same tables
assistant / console ───────────────────────▶ POST /api/teams/<id>/vault/query ◀─ compile(DSL) → SQL
```

One vault per team, one SQLite Durable Object, append-only. An imported report
is indistinguishable from a field report except for its `origin`.

## The gate

Native Breakfast imports also populate the assigned site's `clientName`, `address`,
`emails` and `phones` from resolved client ownership. The site-row contract supplies
contacts before records arrive; record semantics support older producers and direct
`/import` callers. Only successfully filed or matching duplicate records contribute.
An existing source ID assigned to a different site requires review. Employees/users
remain separate, and original history is unchanged.

`POST /api/teams/:id/sites/recover-contacts` accepts `{after?: string|null}` and returns
`{processedSites, updatedSites, nextCursor}` for up to 25 saved sites. Repeat with the
returned cursor until null. This owner/admin session route is exposed by **Sites →
Update sites from Vault**; integration tokens cannot call it. Recovery uses only
saved import semantics, fills missing details, preserves manual contact edits and
does not recreate deleted sites. Site POST/PATCH accepts `phones: string[]`; PATCH
preserves the current phone/address fields when older clients omit them.

**Auth.** An integration token (`Members → Integrations`, shown once, stored as
SHA-256 in D1 `tokens`) is `Authorization: Bearer aludel_<43 url-safe chars>`.
It has the `imports:write` scope, expires after 90 days, and can only call the
endpoint below for its team. Its principal is
`{ id: "token:<12 hex>", name: <token name>, email: "<name>@integration" }` — that
is what lands in `by_user` and in `by_name` when a record names nobody.

**Endpoint.** `POST /api/teams/<team>/import`, JSON, `{ records: [ … ] }`,
1–200 records **and ≤ 1 MiB body** (an oversized body reads as
no records → 422 for the whole call). Each record:

| field | rule |
|---|---|
| `siteId` | UUID of an existing site of the team → else `Unknown site` |
| `templateId` | UUID of an existing template → else `Unknown template` |
| `performedAt` | ISO string; must parse, ≥ 1970-01-01, ≤ now + 1 h → else `performedAt: a past date`. **No five-year floor** (the field's `/reports` POST has one) |
| `byName` | optional, ≤ 80 chars; else the token's name |
| `values` | `{ <block id>: value }` keyed by the template's block ids (`GET /templates/:id`) |
| `origin` | **required**; `file` (≤ 200 chars) required; `sha256` 64 hex; `page` int ≥ 1; `confidence` 0–1; `externalId` ≤ 120 chars |

Per record, in order (each step short-circuits with a per-record result; the
call itself always 200s):

1. `normalizeOrigin` → `origin.file required`.
2. `originKey` = `id:<externalId>` else `sha:<sha256>#<page ?? 0>` else null →
   `vault.byOrigin(key)` → `{ index, id, duplicate: true }` with the earlier id.
3. Site, then template, looked up in D1 (memoised per call).
4. `normalizeFilled(template, record)` walks the **template**, not the input:
   unknown ids, wrong kinds and photo blocks are dropped silently; nothing
   left → `Nothing filled in`. Coercions: text trimmed and cut at 4000;
   number accepts a number or a numeric string; buttons accepts exactly one
   of the block's `options`, case-sensitive.
5. Dispatch for (site, template) reused or minted on the spot.
6. `hash` = SHA-256 of the normalised doc JSON; `templateVersion` = the
   template's current version; `submittedAt` = now.
7. `vault.addImported(meta, doc, key)` checks the origin again and appends in
   one synchronous Durable Object turn: the report row plus one `facts` row per
   filled block. A concurrent duplicate returns the earlier id.

Response: `{ filed, results: [{ index, id } | { index, id, duplicate: true } | { index, error }] }`.

**Identity.** `externalId = reportId` from the graph record (stable: copied
from the CSV's `Submission Id`; verified across reruns). Never `sourcePath`
(`zip://<sha>/<inner path>#row=N` changes on repack). `sha256 + page` is a
sound exact-content fallback (page is always 1 for CSV rows). The vault holds
a `UNIQUE` index on `origin_key`; `addImported` checks and inserts without an
await between them, so concurrent attempts return the existing id. Dispatch
creation likewise tolerates another importer creating the same site/template pair.

## Templates, blocks, facts

Block kinds: `photo | text | number | buttons`. Limits: name 80, label 60,
unit 12, buttons key 24, options 1–6 (empty → `["PASS","FAIL"]`), tasks ≤ 30,
blocks per task ≤ 20 (so ≤ 600 blocks per template). Client-supplied block
ids (`/^[0-9a-fA-F-]{1,36}$/`) are kept on `PUT /templates/:id`; the mapper
uses the template and block UUIDs recorded in its prebuilt map file. `PUT` takes
`version` for optimistic concurrency (409 on mismatch); a fresh `POST /templates`
is version 1.

Each filled block becomes one fact row:

```
facts(report_id, seq, site_id, template_id, task_id, task_name, block_id,
      label, kind, unit, num REAL, text TEXT, performed_at)
```

`num` for numbers, `text` for text and the pressed key. A block is addressed two
ways: an **atom** `{ template, block }` (exact; atoms are versioned by template
on purpose) or a **label** (LIKE `%…%` across every template). Cross-template
series therefore depend on the sidecar emitting the *same* `displayName` for
the same concept across forms. Values are typed at import from the block's
kind — a column the mapper inferred as `number` (zip codes, account numbers)
has `text = NULL` and cannot be matched with `text.eq`; if the sidecar knows a
column is an identifier, say so (see *Asks*).

## Time

`performedAt` is stored as UTC ISO. The mapper builds it from
`date_of_service` (`M-D-YYYY`, 1–2 digit month/day) + `time_of_service` or
`start_time` (`h:mm AM/PM`), interpreted in `--tz`, else the graph root's
`timezone`, else `America/New_York`, with a proper DST-aware conversion; the
export's own `performedAt` is not used (it drops the time of day for
`M/D/YYYY` + time columns). Falls back to
`submitted_on`, then to `Date.parse`. `groupBy: "month"` is `substr(performed_at,
1, 7)` — **UTC months**, so a 10 pm Eastern job on the 31st counts in the next
month. Range filters: `from` inclusive, `to` exclusive.

## The magic calculator

`POST /vault/query` with the DSL; `normalizeQuery` makes invalid states
unrepresentable and `compile` turns it into parameterised SQL. No raw SQL ever
crosses the wire.

```jsonc
{ "template": "<uuid>", "site": "<uuid>", "from": "2024-01-01T00:00:00Z", "to": "2025-01-01T00:00:00Z",   // all optional
  "where": [                                     // ≤ 8 clauses, ANDed; each = "some fact of the report satisfies …"
    { "label": "FOUND TEMPERATURE", "num": { "gte": 100 } },
    { "atom": { "template": "<uuid>", "block": "<uuid>" }, "text": { "eq": "FAIL" } },
    { "kind": "text", "text": { "contains": "leak" } }
  ],
  "select": { "rows": true, "limit": 50 }        // ≤ 200 reports, newest first (meta only; GET /reports/:id for the doc)
  // or { "agg": "count|avg|sum|min|max", "label"?: "…", "atom"?: {…}, "groupBy"?: "site|template|month" }  ≤ 500 groups
}
```

Clause fields: `atom` xor `label` (atom wins), `kind`, `num: {eq,lt,lte,gt,gte}`,
`text: {eq (exact, ≤ 4000), contains (LIKE, ≤ 60)}`. A clause compiles to
`EXISTS (SELECT 1 FROM facts f WHERE f.report_id = r.id AND …)`.

Aggregates: `avg|sum|min|max` need a measure (`label` or `atom`) and run over
`m.num` of the measured facts (`n` = facts counted, `value` NULL if none
numeric). `count` without a measure = `COUNT(DISTINCT r.id)` (reports);
`count` with a measure = number of matching facts (fixed in this pass — it was
`COUNT(m.num)`, i.e. 0 for text/buttons facts). Group rows: `{ key, name,
value, n }`, ordered by key.

Indexes: `reports(site_id, performed_at)`, `(template_id, performed_at)`,
`(performed_at)`, `UNIQUE(origin_key)`; `facts(template_id, block_id,
performed_at)`, `(template_id, block_id, num)`, `(label, kind, performed_at)`,
`(site_id, performed_at)`. Label `LIKE '%x%'` cannot use the label index — a
scan of the team's facts, fine at 10⁴–10⁵ facts, worth an exact-label fast path
past that.

Reads: `GET /reports?site=&template=&limit≤100` (meta, newest first),
`GET /reports/:id` (with `doc`).

## The mapper — `tools/import-graph.mjs`

```
node tools/import-graph.mjs graph.json --team <id> --token aludel_… --base https://<host>
                            [--map aludel-map.json] [--tz America/New_York] [--dry] [--keep-constants]
```

Reads only the spine — `record → has_fact → fact → uses_block → block`,
`template → defines_block`, `record → instance_of | at_site | performed_by` —
and ignores `graphtm_rule` and the other edges. Zero dependencies, Node 18+.

- **Templates**: name = most common `form_name` value among its records, else
  `Imported template N`. Block label = `conceptDisplayName || displayName ||
  labelId` (`--form-labels`: `displayName` first). Kind: the export's
  `valueKind` when present — `number` → number; `identifier`, `date`, `time`,
  `text` → text; `choice` → buttons with `choiceOptions` (≤ 6; a key over 24
  chars drops the block to text); `image` → photo (dropped at import);
  `constant` → *chrome* (left off the template unless `--keep-constants`).
  A merged checkbox block (`mergedLabelIds`) is just a choice block whose
  facts hold the chosen key. Without `valueKind`, inferred from every value
  the corpus filed under the block: all numeric → `number`; all image
  filenames → `photo`; one distinct value on ≥ 3 records and > 40 chars →
  chrome; 2–6 distinct values ≤ 24 chars → `buttons`; else `text`. Blocks are
  chunked 20 per task.
- **Sites**: `clientName` = most common `account_name_*` / `customer_name_*`
  pair, else the address; `locationNote` = the raw address; place left for
  the picker in the app.
- **Values**: leading bullets/whitespace stripped (`clean`), empties skipped,
  numbers coerced for number blocks.
- **Provenance**: `origin.file = sourcePath ?? archiveFolder ?? "graph"` cut
  at 200 chars (the gate would cut it too, never reject),
  `origin.externalId = externalId ?? reportId ?? record.id`. `byName` =
  employee name with any `@domain` cut off.
- **Map file** (`aludel-map.json`): `{ templates: { <graph id>: { id, blocks: {graph block → uuid}, kinds } }, sites: { <graph id>: uuid } }`.
  Saved after each creation; a rerun reuses everything. A block that appears
  in the graph but not in the map is reported and dropped (add it in the app,
  then add its id to the map).
- **Batches**: ≤ 200 records and ≤ 120 KB per call. Exit code 1 if any record
  failed; `--dry` prints the plan and writes nothing.

## What the sidecar export provides (branch `claude/tsetlin-pipeline-review-cadz6o`, `d2c7d48`)

All on `mined-graph.json` block and record nodes and in `cloudbase-import.json`;
the mapper consumes each, and falls back to inference for older exports.

1. `externalId` on record nodes and origin, always = `reportId`: the CSV's own
   id column when one exists, else a deterministic id from logical path + row
   order. The export's `sha256` is over the normalised Stage 2 text of the
   report, not the source file; `page` is always 1.
2. `valueKind` per block: `number | identifier | choice | text | image | date |
   time | constant`; `choice` lists `choiceOptions`, most frequent first, ≤ 6.
   Identifiers come from the label's last word or digit shape and stay text
   here. The old `valueType` (integer | float | string) still drives Cloudbase
   coercion and is ignored by the mapper.
3. Exclusive checkbox columns sharing leading label words arrive as one
   `choice` block named by the prefix, with `mergedLabelIds`; each record's
   fact holds the chosen key. Columns that ever co-occur are left apart.
4. `conceptDisplayName` per block: one string per `canonicalLabel` across
   templates. The mapper uses it as the block label.
5. `timezone` on the graph root when the job is created with
   `?timezone=…`; times are not converted by the export.
6. One CSV file → exactly one template.

Still open, separate from ingest: classifier hygiene — featurise label /
concept / value-type / shape, not raw value tokens; evaluate held-out by
customer.

Site and template ids in the graph are stable hashes, not UUIDs; the map file
remains the join.

## Known gaps (not changed)

- `label` clauses are substring matches; `"WEEK"` also hits `"WEEKLY NOTES"`.
- Month grouping is in UTC.
- `byName` defaults to the token's name, so a record naming no technician
  reads as filed by the integration, not by nobody.
- Field `/reports` POST enforces a five-year window; import does not (by
  design — old paperwork), floor is the epoch.

## Built-in Breakfast connection

The Imports screen now runs this flow directly. See the README for the team
routes and the `BREAKFAST_KEY` secret (`BFAST_API_KEY` is also accepted). The Worker forwards uploads to the fixed
Breakfast origin and the team's Vault stores jobs, progress and staged records.
Durable alarms poll and file in bounded batches without an open browser.

`src/worker/graph-import.ts` ports the CLI mapper's typing and graph traversal,
adds strict timezone parsing and service-date aliases, and derives team-scoped
UUIDs from schema/address identity. Schema changes get a new template rather
than dropping new fields. These IDs are independent of legacy `aludel-map.json`
files; CLI-created templates/sites are not automatically adopted. Both paths
share the same source-record deduplication and `fileImportRecords` gate.
