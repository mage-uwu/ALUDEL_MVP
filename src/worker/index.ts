/// <reference types="@cloudflare/workers-types" />
import {
  DEFAULT_OPTIONS,
  EMAIL_RE,
  LIMITS,
  normalizePlace,
  normalizeTemplate,
  parsePlace,
  type AludelPlace,
  type Role,
} from "../shared/model";
import { applyPlan, configured, optimize, readInput } from "./optimize";
import {
  currentUser,
  finishLogin,
  hashToken,
  logout,
  randomToken,
  requireMember,
  sameOrigin,
  startLogin,
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
  /** Browser key for the Maps JavaScript API — public by nature, so restrict it by HTTP referrer. */
  GOOGLE_MAPS_BROWSER_KEY?: string;
  /** Map ID (Cloud-based map style); advanced markers need one. Defaults to Google's demo id. */
  GOOGLE_MAPS_MAP_ID?: string;
  /** Route Optimization API: the service-account key file as one secret… */
  GOOGLE_SERVICE_ACCOUNT?: string;
  /** …or its project_id / client_email / private_key as three. */
  GOOGLE_CLOUD_PROJECT?: string;
  GOOGLE_SA_EMAIL?: string;
  GOOGLE_SA_PRIVATE_KEY?: string;
  /** Test hook only: a base URL standing in for Google's token and optimizeTours endpoints. */
  OPTIMIZE_ENDPOINT?: string;
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

/** Up to 10 valid, lower-cased, de-duplicated addresses; anything else is dropped. */
const emailsOf = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const e = x.trim().toLowerCase();
    if (e.length <= 160 && EMAIL_RE.test(e) && !out.includes(e)) out.push(e);
    if (out.length >= 10) break;
  }
  return out;
};

const parseEmails = (raw: unknown): string[] => {
  try {
    const v = JSON.parse(typeof raw === "string" ? raw : "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/**
 * The place field of a site body: absent or null clears the location, a valid
 * AludelPlace is kept, and anything else is refused (undefined) rather than
 * quietly dropped — a site never ends up pointing at a location it never chose.
 */
const placeOf = (v: unknown): AludelPlace | null | undefined =>
  v === null || v === undefined ? null : (normalizePlace(v) ?? undefined);

const starterDoc = () => ({
  tasks: [
    {
      id: crypto.randomUUID(),
      name: "First task",
      blocks: [
        { id: crypto.randomUUID(), kind: "photo", label: "Photo", unit: "", options: [] },
        { id: crypto.randomUUID(), kind: "buttons", label: "Outcome", unit: "", options: [...DEFAULT_OPTIONS] },
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
      const doc = normalizeTemplate({ ...JSON.parse(row.doc), name: row.name });
      return json({ id, version: row.version, ...doc });
    }

    if (req.method === "PUT" && id) {
      const body = await readBody(req);
      const doc = normalizeTemplate(body);
      if (!doc) return error(422, "Invalid template");
      // a save names the version it was edited from, so two people editing the
      // same template can't silently overwrite each other
      const from = typeof body?.version === "number" ? body.version : null;
      const row = await env.DB.prepare(
        `UPDATE templates SET name = ?, doc = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND team_id = ? AND (? IS NULL OR version = ?) RETURNING version`
      )
        .bind(doc.name, JSON.stringify({ tasks: doc.tasks }), nowIso(), id, teamId, from, from)
        .first<{ version: number }>();
      if (row) return json({ id, version: row.version });
      const exists = await env.DB.prepare("SELECT 1 AS hit FROM templates WHERE id = ? AND team_id = ?")
        .bind(id, teamId)
        .first();
      return exists
        ? error(409, "Someone saved this template after you opened it. Go back and reopen it to see their version.")
        : error(404, "Not found");
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

  // ——— lists: containers of worksites ———
  if (rest === "/lists") {
    if (req.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT l.id, l.name, (SELECT COUNT(*) FROM sites s WHERE s.list_id = l.id) AS sites
         FROM lists l WHERE l.team_id = ? ORDER BY l.name`
      )
        .bind(teamId)
        .all();
      return json(results);
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const name = field(body?.name, LIMITS.name);
      if (!name) return error(422, "List name required");
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO lists (id, team_id, name, created_at) VALUES (?, ?, ?, ?)")
        .bind(id, teamId, name, nowIso())
        .run();
      return json({ id, name, sites: 0 }, 201);
    }
    return error(405, "Method not allowed");
  }

  const list = rest.match(new RegExp(`^/lists/(${UUID})$`));
  if (list) {
    const id = list[1]!;
    if (req.method === "PATCH") {
      const body = await readBody(req);
      const name = field(body?.name, LIMITS.name);
      if (!name) return error(422, "List name required");
      const res = await env.DB.prepare("UPDATE lists SET name = ? WHERE id = ? AND team_id = ?")
        .bind(name, id, teamId)
        .run();
      return res.meta.changes ? json({ ok: true }) : error(404, "Not found");
    }
    if (req.method === "DELETE") {
      // sites in the list survive; they just become unlisted (ON DELETE SET NULL)
      const res = await env.DB.prepare("DELETE FROM lists WHERE id = ? AND team_id = ?")
        .bind(id, teamId)
        .run();
      return res.meta.changes ? json({ ok: true }) : error(404, "Not found");
    }
    return error(405, "Method not allowed");
  }

  // ——— worksites ———
  /** A list id is only valid if it is one of this team's lists. */
  const listFor = async (v: unknown): Promise<string | null | undefined> => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v !== "string" || !new RegExp(`^${UUID}$`).test(v)) return undefined;
    const row = await env.DB.prepare("SELECT 1 AS hit FROM lists WHERE id = ? AND team_id = ?")
      .bind(v, teamId)
      .first();
    return row ? v : undefined;
  };

  if (rest === "/sites") {
    if (req.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT s.id, s.client_name AS clientName, s.address, s.place, s.position, s.emails,
                s.list_id AS listId, l.name AS listName,
                (SELECT COUNT(*) FROM dispatches d WHERE d.site_id = s.id) AS dispatches
         FROM sites s LEFT JOIN lists l ON l.id = s.list_id
         WHERE s.team_id = ?
         ORDER BY l.name IS NULL, l.name, s.position, s.client_name`
      )
        .bind(teamId)
        .all();
      return json(results.map((r) => ({ ...r, place: parsePlace(r.place), emails: parseEmails(r.emails) })));
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const clientName = field(body?.clientName, LIMITS.name) || "New site";
      const listId = await listFor(body?.listId);
      if (listId === undefined) return error(422, "Unknown list");
      const place = placeOf(body?.place);
      if (place === undefined) return error(422, "Invalid place");
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO sites (id, team_id, list_id, client_name, address, place, location_note, emails, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          teamId,
          listId,
          clientName,
          place?.formattedAddress ?? "",
          place ? JSON.stringify(place) : null,
          field(body?.locationNote, 240),
          JSON.stringify(emailsOf(body?.emails)),
          nowIso(),
          nowIso()
        )
        .run();
      return json({ id }, 201);
    }
    return error(405, "Method not allowed");
  }

  const site = rest.match(new RegExp(`^/sites/(${UUID})(?:/dispatches(?:/(${UUID}))?)?$`));
  if (site) {
    const siteId = site[1]!;
    const onDispatches = rest.includes("/dispatches");
    const dispatchId = site[2];

    // every site route starts by proving the site is this team's
    const owned = await env.DB.prepare("SELECT 1 AS hit FROM sites WHERE id = ? AND team_id = ?")
      .bind(siteId, teamId)
      .first();
    if (!owned) return error(404, "Not found");

    if (!onDispatches && req.method === "GET") {
      const row = await env.DB.prepare(
        `SELECT id, client_name AS clientName, address, place, location_note AS locationNote, emails,
                list_id AS listId
         FROM sites WHERE id = ?`
      )
        .bind(siteId)
        .first<{ emails: string; place: string | null }>();
      const { results: dispatches } = await env.DB.prepare(
        `SELECT d.id, d.template_id AS templateId, t.name AS templateName,
                d.template_version AS templateVersion, t.version AS currentVersion,
                d.created_at AS createdAt
         FROM dispatches d JOIN templates t ON t.id = d.template_id
         WHERE d.site_id = ? ORDER BY d.created_at DESC`
      )
        .bind(siteId)
        .all();
      return json({ ...row, place: parsePlace(row?.place), emails: parseEmails(row?.emails), dispatches });
    }

    if (!onDispatches && req.method === "PATCH") {
      const body = await readBody(req);
      if (!body) return error(422, "Invalid site");
      const clientName = field(body.clientName, LIMITS.name);
      if (!clientName) return error(422, "Client name required");
      const listId = await listFor(body.listId);
      if (listId === undefined) return error(422, "Unknown list");
      const place = placeOf(body.place);
      if (place === undefined) return error(422, "Invalid place");
      await env.DB.prepare(
        `UPDATE sites SET client_name = ?, address = ?, place = ?, location_note = ?, emails = ?, list_id = ?,
                          updated_at = ?
         WHERE id = ?`
      )
        .bind(
          clientName,
          place?.formattedAddress ?? "",
          place ? JSON.stringify(place) : null,
          field(body.locationNote, 240),
          JSON.stringify(emailsOf(body.emails)),
          listId,
          nowIso(),
          siteId
        )
        .run();
      return json({ ok: true });
    }

    if (!onDispatches && req.method === "DELETE") {
      await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(siteId).run();
      return json({ ok: true });
    }

    // dispatch: the site borrows a template, noting the version it borrowed
    if (onDispatches && !dispatchId && req.method === "POST") {
      const body = await readBody(req);
      const templateId = field(body?.templateId, 36);
      const tpl = await env.DB.prepare("SELECT version FROM templates WHERE id = ? AND team_id = ?")
        .bind(templateId, teamId)
        .first<{ version: number }>();
      if (!tpl) return error(422, "Unknown template");
      const id = crypto.randomUUID();
      try {
        await env.DB.prepare(
          `INSERT INTO dispatches (id, team_id, site_id, template_id, template_version, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(id, teamId, siteId, templateId, tpl.version, user.id, nowIso())
          .run();
      } catch (e) {
        if (/UNIQUE/i.test(String(e))) return error(409, "Already dispatched to this site");
        throw e;
      }
      return json({ id, templateVersion: tpl.version }, 201);
    }

    if (onDispatches && dispatchId && req.method === "DELETE") {
      const res = await env.DB.prepare("DELETE FROM dispatches WHERE id = ? AND site_id = ?")
        .bind(dispatchId, siteId)
        .run();
      return res.meta.changes ? json({ ok: true }) : error(404, "Not found");
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
      if (!EMAIL_RE.test(email)) return error(422, "Invalid email");
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

  // ——— routes: the depot, the latest plan, a new plan, and applying it to lists ———
  if (rest === "/plan" && req.method === "GET") {
    const team = await env.DB.prepare("SELECT depot, plan FROM teams WHERE id = ?")
      .bind(teamId)
      .first<{ depot: string | null; plan: string | null }>();
    return json({ depot: parsePlace(team?.depot), plan: team?.plan ? JSON.parse(team.plan) : null });
  }
  if (rest === "/plan" && req.method === "POST") {
    if (!admin) return error(403, "Admins only");
    if (!configured(env)) return error(503, "Route optimization is not set up for this deployment");
    const ask = readInput(await readBody(req));
    if (!ask) return error(422, "Routes must be 1–10, service 0–240 minutes, and the window a day at most");
    try {
      return json(await optimize(env, teamId, ask));
    } catch (e) {
      return error(422, (e as Error).message);
    }
  }
  if (rest === "/plan/apply" && req.method === "POST") {
    if (!admin) return error(403, "Admins only");
    return (await applyPlan(env, teamId)) ? json({ ok: true }) : error(404, "No plan to apply");
  }
  if (rest === "/depot" && req.method === "PUT") {
    if (!admin) return error(403, "Admins only");
    const place = placeOf((await readBody(req))?.place);
    if (place === undefined) return error(422, "Invalid place");
    await env.DB.prepare("UPDATE teams SET depot = ? WHERE id = ?")
      .bind(place ? JSON.stringify(place) : null, teamId)
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
    return json({
      user,
      teams: results,
      maps: {
        key: env.GOOGLE_MAPS_BROWSER_KEY || null,
        mapId: env.GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID",
        optimize: configured(env),
      },
    });
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
