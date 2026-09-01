/// <reference types="@cloudflare/workers-types" />
import { LIMITS, normalizeTemplate } from "../shared/model";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: HEADERS });
const error = (status: number, message: string) => json({ error: message }, status);

async function readBody(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? 0) > LIMITS.body) return null;
  const text = await req.text();
  if (text.length > LIMITS.body) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Schema is created on demand so a fresh D1 database needs no migration step.
const SCHEMA =
  "CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, doc TEXT NOT NULL, updated_at TEXT NOT NULL)";
let ready: Promise<unknown> | null = null;
const ensureSchema = (db: D1Database) =>
  (ready ??= db.prepare(SCHEMA).run()).catch((e) => {
    ready = null;
    throw e;
  });

const starterDoc = () => ({
  tasks: [
    {
      id: crypto.randomUUID(),
      name: "First task",
      everyWeeks: 3,
      windowDays: 5,
      blocks: [{ id: crypto.randomUUID(), kind: "photo", label: "Photo", unit: "" }],
      endsWith: [{ id: crypto.randomUUID(), label: "DONE" }],
    },
  ],
});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/api\/templates(?:\/([0-9a-fA-F-]{36}))?$/);
    if (!match) return error(404, "Not found");
    const [, tid] = match;

    try {
      await ensureSchema(env.DB);

      if (req.method === "GET" && !tid) {
        const { results } = await env.DB.prepare(
          "SELECT id, name, version, updated_at AS updatedAt FROM templates ORDER BY updated_at DESC LIMIT 100"
        ).all();
        return json(results);
      }

      if (req.method === "POST" && !tid) {
        const body = normalizeTemplate(await readBody(req));
        if (!body) return error(422, "Invalid template");
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO templates (id, name, version, doc, updated_at) VALUES (?, ?, 1, ?, ?)"
        )
          .bind(id, body.name, JSON.stringify(starterDoc()), new Date().toISOString())
          .run();
        return json({ id }, 201);
      }

      if (req.method === "GET" && tid) {
        const row = await env.DB.prepare("SELECT name, version, doc FROM templates WHERE id = ?")
          .bind(tid)
          .first<{ name: string; version: number; doc: string }>();
        if (!row) return error(404, "Not found");
        const doc = normalizeTemplate({ name: row.name, ...JSON.parse(row.doc) });
        return json({ id: tid, version: row.version, ...doc });
      }

      if (req.method === "PUT" && tid) {
        const body = normalizeTemplate(await readBody(req));
        if (!body) return error(422, "Invalid template");
        const row = await env.DB.prepare(
          "UPDATE templates SET name = ?, doc = ?, version = version + 1, updated_at = ? WHERE id = ? RETURNING version"
        )
          .bind(body.name, JSON.stringify({ tasks: body.tasks }), new Date().toISOString(), tid)
          .first<{ version: number }>();
        if (!row) return error(404, "Not found");
        return json({ id: tid, version: row.version });
      }

      if (req.method === "DELETE" && tid) {
        const res = await env.DB.prepare("DELETE FROM templates WHERE id = ?").bind(tid).run();
        if (!res.meta.changes) return error(404, "Not found");
        return json({ ok: true });
      }

      return error(405, "Method not allowed");
    } catch {
      return error(500, "Something went wrong");
    }
  },
} satisfies ExportedHandler<Env>;
