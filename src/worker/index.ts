/// <reference types="@cloudflare/workers-types" />
import { LIMITS, normalizeTemplate } from "../shared/model";
import {
  currentUser,
  finishLogin,
  hashToken,
  logout,
  randomToken,
  requireMember,
  sameOrigin,
  startLogin,
  type Role,
  type User,
} from "./auth";
import { ensureSchema } from "./schema";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  APP_ORIGIN?: string;
  /** Optional comma-separated domain allow-list, e.g. "acme.com,acme.co.uk". */
  ALLOWED_EMAIL_DOMAINS?: string;
}

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: HEADERS });
const error = (status: number, message: string) => json({ error: message }, status);

const INVITE_TTL_S = 7 * 24 * 3600;
const UUID = "[0-9a-fA-F-]{36}";
const nowIso = () => new Date().toISOString();

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > LIMITS.body) return null;
  const text = await req.text();
  if (text.length > LIMITS.body) return null;
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const field = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const starterDoc = () => ({
  tasks: [
    {
      id: crypto.randomUUID(),
      name: "First task",
      blocks: [
        { id: crypto.randomUUID(), kind: "photo", label: "Photo", unit: "" },
        { id: crypto.randomUUID(), kind: "button", label: "DONE", unit: "" },
      ],
    },
  ],
});

/** Team-scoped routes: membership is proven before the handler sees the team. */
async function teamRoutes(
  req: Request,
  env: Env,
  user: User,
  teamId: string,
  rest: string
): Promise<Response> {
  const role = await requireMember(env, user, teamId);
  // an unknown team and a team you don't belong to are indistinguishable
  if (!role) return error(404, "Not found");
  const admin = role === "owner" || role === "admin";

  // ——— templates ———
  const tpl = rest.match(new RegExp(`^/templates(?:/(${UUID}))?$`));
  if (tpl) {
    const id = tpl[1];

    if (req.method === "GET" && !id) {
      const { results } = await env.DB.prepare(
        `SELECT id, name, version, updated_at AS updatedAt,
                json_array_length(doc, '$.tasks') AS tasks
         FROM templates WHERE team_id = ? ORDER BY updated_at DESC LIMIT 100`
      )
        .bind(teamId)
        .all();
      return json(results);
    }

    if (req.method === "POST" && !id) {
      const body = normalizeTemplate(await readBody(req));
      if (!body) return error(422, "Invalid template");
      const newId = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO templates (id, team_id, name, version, doc, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
      )
        .bind(newId, teamId, body.name, JSON.stringify(starterDoc()), nowIso())
        .run();
      return json({ id: newId }, 201);
    }

    if (req.method === "GET" && id) {
      const row = await env.DB.prepare(
        "SELECT name, version, doc FROM templates WHERE id = ? AND team_id = ?"
      )
        .bind(id, teamId)
        .first<{ name: string; version: number; doc: string }>();
      if (!row) return error(404, "Not found");
      const doc = normalizeTemplate({ name: row.name, ...JSON.parse(row.doc) });
      return json({ id, version: row.version, ...doc });
    }

    if (req.method === "PUT" && id) {
      const body = normalizeTemplate(await readBody(req));
      if (!body) return error(422, "Invalid template");
      const row = await env.DB.prepare(
        `UPDATE templates SET name = ?, doc = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND team_id = ? RETURNING version`
      )
        .bind(body.name, JSON.stringify({ tasks: body.tasks }), nowIso(), id, teamId)
        .first<{ version: number }>();
      if (!row) return error(404, "Not found");
      return json({ id, version: row.version });
    }

    if (req.method === "DELETE" && id) {
      const res = await env.DB.prepare("DELETE FROM templates WHERE id = ? AND team_id = ?")
        .bind(id, teamId)
        .run();
      if (!res.meta.changes) return error(404, "Not found");
      return json({ ok: true });
    }
    return error(405, "Method not allowed");
  }

  // ——— members ———
  if (rest === "/members" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.picture, m.role, m.created_at AS joinedAt
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ? ORDER BY m.created_at`
    )
      .bind(teamId)
      .all();
    return json(results);
  }

  const member = rest.match(new RegExp(`^/members/(${UUID})$`));
  if (member) {
    const targetId = member[1]!;
    const target = await env.DB.prepare(
      "SELECT role FROM memberships WHERE team_id = ? AND user_id = ?"
    )
      .bind(teamId, targetId)
      .first<{ role: Role }>();
    if (!target) return error(404, "Not found");

    // leaving is always yours to do; acting on someone else needs admin
    const self = targetId === user.id;
    if (!self && !admin) return error(403, "Admins only");
    // an owner is only ever changed by an owner
    if (target.role === "owner" && role !== "owner") return error(403, "Owners only");

    const lastOwner = async () => {
      if (target.role !== "owner") return false;
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM memberships WHERE team_id = ? AND role = 'owner'"
      )
        .bind(teamId)
        .first<{ n: number }>();
      return (row?.n ?? 0) <= 1;
    };

    if (req.method === "DELETE") {
      if (await lastOwner()) return error(409, "A team needs at least one owner");
      await env.DB.prepare("DELETE FROM memberships WHERE team_id = ? AND user_id = ?")
        .bind(teamId, targetId)
        .run();
      return json({ ok: true });
    }

    if (req.method === "PATCH") {
      if (role !== "owner") return error(403, "Owners only");
      const body = await readBody(req);
      const next = field(body?.role, 10);
      if (!["owner", "admin", "member"].includes(next)) return error(422, "Invalid role");
      if (next !== "owner" && (await lastOwner())) return error(409, "A team needs at least one owner");
      await env.DB.prepare("UPDATE memberships SET role = ? WHERE team_id = ? AND user_id = ?")
        .bind(next, teamId, targetId)
        .run();
      return json({ ok: true });
    }
    return error(405, "Method not allowed");
  }

  // ——— invites ———
  if (rest === "/invites") {
    if (!admin) return error(403, "Admins only");

    if (req.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT id, email, role, created_at AS createdAt, expires_at AS expiresAt
         FROM invites WHERE team_id = ? AND accepted_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC`
      )
        .bind(teamId, nowIso())
        .all();
      return json(results);
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const email = field(body?.email, 160).toLowerCase();
      const inviteRole = field(body?.role, 10) || "member";
      if (!EMAIL.test(email)) return error(422, "Invalid email");
      if (!["admin", "member"].includes(inviteRole)) return error(422, "Invalid role");

      const already = await env.DB.prepare(
        `SELECT 1 AS hit FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.team_id = ? AND u.email = ?`
      )
        .bind(teamId, email)
        .first();
      if (already) return error(409, "Already a member");

      const token = randomToken();
      await env.DB.prepare(
        `INSERT INTO invites (id, team_id, email, role, invited_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          await hashToken(token),
          teamId,
          email,
          inviteRole,
          user.id,
          nowIso(),
          new Date(Date.now() + INVITE_TTL_S * 1000).toISOString()
        )
        .run();
      // the raw token exists only in this response; the row keeps its hash
      return json({ email, role: inviteRole, token }, 201);
    }
    return error(405, "Method not allowed");
  }

  const invite = rest.match(/^\/invites\/([A-Za-z0-9_-]{43})$/);
  if (invite && req.method === "DELETE") {
    if (!admin) return error(403, "Admins only");
    await env.DB.prepare("DELETE FROM invites WHERE id = ? AND team_id = ?")
      .bind(invite[1], teamId)
      .run();
    return json({ ok: true });
  }

  if (rest === "" && req.method === "DELETE") {
    if (role !== "owner") return error(403, "Owners only");
    await env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(teamId).run();
    return json({ ok: true });
  }

  return error(404, "Not found");
}

async function api(req: Request, env: Env, path: string): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) return error(401, "Sign in required");

  if (path === "/me" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.name, m.role FROM memberships m JOIN teams t ON t.id = m.team_id
       WHERE m.user_id = ? ORDER BY t.created_at`
    )
      .bind(user.id)
      .all();
    return json({ user, teams: results });
  }

  if (path === "/teams" && req.method === "POST") {
    const body = await readBody(req);
    const name = field(body?.name, LIMITS.name);
    if (!name) return error(422, "Team name required");
    const teamId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)").bind(
        teamId,
        name,
        nowIso()
      ),
      env.DB.prepare(
        "INSERT INTO memberships (team_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)"
      ).bind(teamId, user.id, nowIso()),
    ]);
    return json({ id: teamId, name, role: "owner" }, 201);
  }

  // accepting an invite is the one route that reaches a team without membership
  if (path === "/invites/accept" && req.method === "POST") {
    const body = await readBody(req);
    const token = field(body?.token, 64);
    if (!token) return error(422, "Invite required");
    const row = await env.DB.prepare(
      `SELECT id, team_id AS teamId, email, role, expires_at AS expiresAt, accepted_at AS acceptedAt
       FROM invites WHERE id = ?`
    )
      .bind(await hashToken(token))
      .first<{ id: string; teamId: string; email: string; role: Role; expiresAt: string; acceptedAt: string | null }>();

    if (!row || row.acceptedAt || row.expiresAt <= nowIso()) return error(404, "Invite is not valid");
    // an invite is issued to a person, not to whoever holds the link
    if (row.email !== user.email.toLowerCase()) return error(403, "This invite is for a different account");

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memberships (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (team_id, user_id) DO NOTHING`
      ).bind(row.teamId, user.id, row.role, nowIso()),
      env.DB.prepare("UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ?").bind(
        nowIso(),
        user.id,
        row.id
      ),
    ]);
    const team = await env.DB.prepare("SELECT id, name FROM teams WHERE id = ?")
      .bind(row.teamId)
      .first<{ id: string; name: string }>();
    return json({ team, role: row.role });
  }

  const scoped = path.match(new RegExp(`^/teams/(${UUID})(.*)$`));
  if (scoped) return teamRoutes(req, env, user, scoped[1]!, scoped[2] ?? "");

  return error(404, "Not found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    try {
      await ensureSchema(env.DB);

      if (url.pathname === "/auth/login") return startLogin(req, env);
      if (url.pathname === "/auth/callback") return finishLogin(req, env);
      if (url.pathname === "/auth/logout" && req.method === "POST") {
        if (!sameOrigin(req, env)) return error(403, "Cross-origin request refused");
        return logout(req, env);
      }

      if (url.pathname.startsWith("/api/")) {
        if (!sameOrigin(req, env)) return error(403, "Cross-origin request refused");
        return await api(req, env, url.pathname.slice(4));
      }

      return error(404, "Not found");
    } catch (e) {
      // detail goes to Workers logs; the client gets nothing exploitable
      console.error("request failed", url.pathname, e);
      return error(500, "Something went wrong");
    }
  },
} satisfies ExportedHandler<Env>;
