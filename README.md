# ALUDEL

Dirt-simple form template builder on Cloudflare Workers + D1.

**Model**: Templates → Tasks (molecules) → Blocks (atoms: Photo, Text, Number).
Outcome buttons live only in a task's **Outcomes** section; every task keeps at least one —
invalid states are unrepresentable, and the server re-validates every document through the same
`src/shared/model.ts` gate before it touches the database.

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

No migration step: the Worker creates its one table on demand (`CREATE TABLE IF NOT EXISTS`),
so a fresh D1 database works on the first request.

## Layout

- `src/shared/model.ts` — types + the one validation/clamping gate (shared client/server)
- `src/worker/index.ts` — zero-dependency Worker: 5 JSON routes over one D1 table
- `src/client/` — React builder UI (mobile-first, frosted glass; live console pane on wide screens)

Team tenancy + Google OAuth are the next pass; the API is deliberately a thin, replaceable layer.
