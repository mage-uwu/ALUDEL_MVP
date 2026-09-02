/// <reference types="@cloudflare/workers-types" />
import type { Role } from "../shared/model";
import type { Env } from "./index";

export const ROLE_RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export interface User {
  id: string;
  email: string;
  name: string;
  picture: string;
}

const SESSION_COOKIE = "aludel_session";
const FLOW_COOKIE = "aludel_flow";
const SESSION_TTL_S = 30 * 24 * 3600; // absolute lifetime
const IDLE_TTL_S = 7 * 24 * 3600; // extended while in use
const FLOW_TTL_S = 600;
const REFRESH_AFTER_S = 3600; // limit session writes to once an hour

const enc = new TextEncoder();
const now = () => new Date();
const iso = (d: Date) => d.toISOString();
const plus = (s: number) => iso(new Date(Date.now() + s * 1000));

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** 256 bits from the platform CSPRNG — the only place tokens are minted. */
export const randomToken = (): string => b64url(crypto.getRandomValues(new Uint8Array(32)));

/** Tokens are looked up by hash, so a database dump can't be replayed as a cookie. */
export const hashToken = async (token: string): Promise<string> =>
  b64url(await crypto.subtle.digest("SHA-256", enc.encode(token)));

/** Constant-time compare for values checked by equality rather than lookup. */
const sameSecret = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const readCookie = (req: Request, name: string): string | null => {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
};

const cookie = (name: string, value: string, maxAge: number, path = "/"): string =>
  `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

const clearCookie = (name: string, path = "/"): string =>
  `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

const origin = (req: Request, env: Env): string => env.APP_ORIGIN || new URL(req.url).origin;

/**
 * SameSite=Lax already blocks cross-site form posts; this rejects the rest
 * (fetch from another origin) before any mutation touches the database.
 */
export function sameOrigin(req: Request, env: Env): boolean {
  if (["GET", "HEAD"].includes(req.method)) return true;
  const o = req.headers.get("origin");
  return !!o && o === origin(req, env);
}

/**
 * With an "External" Google client any Google account on earth can reach the
 * callback, so authentication alone is not a gate. When ALLOWED_EMAIL_DOMAINS
 * is set, only those domains may sign in — plus anyone holding a live invite,
 * so contractors on other domains still work without opening the door.
 */
export async function canSignIn(db: D1Database, allowList: string, email: string): Promise<boolean> {
  const domains = allowList
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  if (domains.length === 0) return true; // unset: any Google account may sign in

  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (domains.includes(domain)) return true;

  const invited = await db
    .prepare("SELECT 1 AS hit FROM invites WHERE email = ? AND accepted_at IS NULL AND expires_at > ?")
    .bind(email, iso(now()))
    .first();
  return !!invited;
}

// ————— OAuth: authorization code + PKCE, with state and nonce —————

export async function startLogin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const raw = url.searchParams.get("return") ?? "/";
  // a same-site path only: never an absolute URL, and never the `//host` or
  // `/\host` forms browsers read as one
  const returnTo = /^\/(?![\/\\])\S*$/.test(raw) ? raw : "/";

  const flowId = randomToken();
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const challenge = await hashToken(verifier);

  await env.DB.batch([
    // the one unauthenticated write path also sweeps what it and sign-in leave behind,
    // so abandoned flows and dead sessions can't pile up
    env.DB.prepare("DELETE FROM login_flows WHERE expires_at < ?").bind(iso(now())),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(iso(now())),
    env.DB.prepare(
      "INSERT INTO login_flows (id, state, verifier, nonce, return_to, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(await hashToken(flowId), state, verifier, nonce, returnTo, plus(FLOW_TTL_S)),
  ]);

  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin(req, env)}/auth/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "online",
    prompt: "select_account",
  }).toString();

  return new Response(null, {
    status: 302,
    headers: {
      location: auth.toString(),
      "set-cookie": cookie(FLOW_COOKIE, flowId, FLOW_TTL_S, "/auth"),
      "cache-control": "no-store",
    },
  });
}

const fail = (msg: string) =>
  new Response(`Sign-in failed: ${msg}`, {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

interface IdClaims {
  iss: string;
  aud: string;
  exp: number;
  sub: string;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

/**
 * The ID token is fetched by us, directly from Google's token endpoint over
 * TLS, so per OIDC Core 3.1.3.7 the signature needs no separate check — but
 * every claim that binds it to *this* login attempt still does.
 */
function readClaims(idToken: string): IdClaims | null {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const bytes = Uint8Array.from(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as IdClaims;
  } catch {
    return null;
  }
}

export async function finishLogin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.searchParams.get("error")) return fail(url.searchParams.get("error") ?? "denied");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const flowId = readCookie(req, FLOW_COOKIE);
  if (!code || !state || !flowId) return fail("missing login state");

  // single use: the flow row is consumed whether or not the rest succeeds
  const flowKey = await hashToken(flowId);
  const flow = await env.DB.prepare(
    "DELETE FROM login_flows WHERE id = ? RETURNING state, verifier, nonce, return_to, expires_at"
  )
    .bind(flowKey)
    .first<{ state: string; verifier: string; nonce: string; return_to: string; expires_at: string }>();

  if (!flow) return fail("unknown login attempt");
  if (flow.expires_at < iso(now())) return fail("login attempt expired");
  if (!sameSecret(flow.state, state)) return fail("state mismatch");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin(req, env)}/auth/callback`,
      grant_type: "authorization_code",
      code_verifier: flow.verifier,
    }),
  });
  if (!res.ok) return fail("token exchange rejected");

  const token = (await res.json()) as { id_token?: string };
  const claims = token.id_token ? readClaims(token.id_token) : null;
  if (!claims) return fail("no identity token");

  const issuers = ["https://accounts.google.com", "accounts.google.com"];
  if (!issuers.includes(claims.iss)) return fail("bad issuer");
  if (claims.aud !== env.GOOGLE_CLIENT_ID) return fail("bad audience");
  if (claims.exp * 1000 <= Date.now()) return fail("identity token expired");
  if (!claims.nonce || !sameSecret(flow.nonce, claims.nonce)) return fail("nonce mismatch");
  if (!claims.email || claims.email_verified !== true) return fail("unverified email");

  const email = claims.email.toLowerCase();
  if (!(await canSignIn(env.DB, env.ALLOWED_EMAIL_DOMAINS ?? "", email)))
    return fail("this account is not allowed to sign in");

  const userId = crypto.randomUUID();
  const user = await env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, name, picture, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (google_sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture
     RETURNING id`
  )
    .bind(userId, claims.sub, email, claims.name ?? "", claims.picture ?? "", iso(now()))
    .first<{ id: string }>();
  if (!user) return fail("could not establish account");

  // a fresh session id per login: nothing minted before sign-in stays valid
  const sessionToken = randomToken();
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(await hashToken(sessionToken), user.id, iso(now()), iso(now()), plus(IDLE_TTL_S))
    .run();

  const headers = new Headers({ location: flow.return_to, "cache-control": "no-store" });
  headers.append("set-cookie", cookie(SESSION_COOKIE, sessionToken, IDLE_TTL_S));
  headers.append("set-cookie", clearCookie(FLOW_COOKIE, "/auth"));
  return new Response(null, { status: 302, headers });
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await hashToken(token)).run();
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": clearCookie(SESSION_COOKIE), "cache-control": "no-store" },
  });
}

// ————— session and tenancy guards —————

export async function currentUser(req: Request, env: Env): Promise<User | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const key = await hashToken(token);
  const row = await env.DB.prepare(
    `SELECT s.created_at AS started, s.last_seen AS seen, s.expires_at AS expires,
            u.id, u.email, u.name, u.picture
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`
  )
    .bind(key)
    .first<{ started: string; seen: string; expires: string; id: string; email: string; name: string; picture: string }>();
  if (!row) return null;

  const nowIso = iso(now());
  const absolute = new Date(Date.parse(row.started) + SESSION_TTL_S * 1000).toISOString();
  if (row.expires <= nowIso || absolute <= nowIso) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(key).run();
    return null;
  }
  if (Date.parse(nowIso) - Date.parse(row.seen) > REFRESH_AFTER_S * 1000) {
    await env.DB.prepare("UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?")
      .bind(nowIso, plus(IDLE_TTL_S), key)
      .run();
  }
  return { id: row.id, email: row.email, name: row.name, picture: row.picture };
}

/**
 * The single gate for tenant data. A team id in a URL means nothing until a
 * membership row proves this user belongs to it, so no route can reach another
 * team's rows by forgetting a filter.
 */
export async function requireMember(
  env: Env,
  user: User,
  teamId: string,
  atLeast: Role = "member"
): Promise<Role | null> {
  const row = await env.DB.prepare("SELECT role FROM memberships WHERE team_id = ? AND user_id = ?")
    .bind(teamId, user.id)
    .first<{ role: Role }>();
  if (!row) return null;
  return ROLE_RANK[row.role] >= ROLE_RANK[atLeast] ? row.role : null;
}
