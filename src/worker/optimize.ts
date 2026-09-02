/// <reference types="@cloudflare/workers-types" />
// Route planning on the Google Maps Platform Route Optimization API (a fleet
// VRP solver) — not the Routes API and not Fleet Engine. Input is the team's
// stored AludelPlaces, output is a RoutePlan; nothing live from Google is kept.
import { parsePlace, type AludelPlace, type RoutePlan } from "../shared/model";
import type { Env } from "./index";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const COST_PER_HOUR = 60;
const COST_PER_KM = 1;
/** Skipping a stop must cost far more than driving to it, so only real infeasibility skips one. */
const SKIP_PENALTY = 10_000;

interface Credentials {
  project: string;
  email: string;
  privateKey: string;
}

/**
 * The service account, from either the whole key file pasted into one secret
 * (GOOGLE_SERVICE_ACCOUNT) or its three fields as separate secrets. Null when
 * neither is complete.
 */
export function credentials(env: Env): Credentials | null {
  if (env.GOOGLE_SERVICE_ACCOUNT) {
    try {
      const j = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT) as Record<string, unknown>;
      if (typeof j.project_id === "string" && typeof j.client_email === "string" && typeof j.private_key === "string")
        return { project: j.project_id, email: j.client_email, privateKey: j.private_key };
    } catch {
      /* not JSON: fall through to the three-secret form */
    }
  }
  return env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_SA_EMAIL && env.GOOGLE_SA_PRIVATE_KEY
    ? { project: env.GOOGLE_CLOUD_PROJECT, email: env.GOOGLE_SA_EMAIL, privateKey: env.GOOGLE_SA_PRIVATE_KEY }
    : null;
}
export const configured = (env: Env) => credentials(env) !== null;

/**
 * PEM → raw base64. The key may carry real newlines, the literal two-character
 * \n of a one-line secret field, or both; the literal form goes first, whole,
 * so its "n" never lands inside the key body.
 */
export const keyBody = (pem: string) =>
  pem.replace(/\\[nr]/g, "").replace(/-----[^-]+-----/g, "").replace(/[^A-Za-z0-9+/=]/g, "");

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const utf8 = (s: string) => new TextEncoder().encode(s);

// ——— server-side OAuth: a service-account JWT exchanged for a short-lived token ———
let cached: { token: string; exp: number } | null = null;

async function accessToken(env: Env, sa: Credentials): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const iat = Math.floor(Date.now() / 1000);
  const part = (o: unknown) => b64url(utf8(JSON.stringify(o)));
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({
    iss: sa.email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat,
    exp: iat + 3600,
  })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(keyBody(sa.privateKey)), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(unsigned)));
  const res = await fetch(env.OPTIMIZE_ENDPOINT ? `${env.OPTIMIZE_ENDPOINT}/token` : TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  if (!res.ok) throw new Error(`Google sign-in for route optimization failed (${res.status})`);
  const { access_token, expires_in } = await res.json<{ access_token: string; expires_in: number }>();
  cached = { token: access_token, exp: Date.now() + expires_in * 1000 };
  return access_token;
}

// ——— request / response mapping: pure, so it can be checked without Google ———
export interface Stop {
  siteId: string;
  clientName: string;
  place: AludelPlace;
}
export interface OptimizeInput {
  routes: number;
  serviceSeconds: number;
  start: string;
  end: string;
  depot: AludelPlace | null;
  stops: Stop[];
}

const latLng = (p: AludelPlace) => ({ latitude: p.lat, longitude: p.lng });

export function buildRequest(i: OptimizeInput) {
  const ends = i.depot ? { startLocation: latLng(i.depot), endLocation: latLng(i.depot) } : {};
  const startMs = Date.parse(i.start);
  return {
    model: {
      globalStartTime: i.start,
      globalEndTime: i.end,
      // every vehicle carries both costs: without them the solver has nothing to minimise
      vehicles: Array.from({ length: i.routes }, (_, k) => ({
        label: `Route ${k + 1}`,
        ...ends,
        costPerHour: COST_PER_HOUR,
        costPerKilometer: COST_PER_KM,
      })),
      // delivery-only visits; a penalty makes each stop skippable rather than fatal
      shipments: i.stops.map((s) => ({
        label: s.siteId,
        penaltyCost: SKIP_PENALTY,
        deliveries: [{ arrivalLocation: latLng(s.place), duration: `${i.serviceSeconds}s` }],
      })),
    },
    timeout: `${i.stops.length > 40 ? 120 : 30}s`,
    searchMode: "CONSUME_ALL_AVAILABLE_TIME",
    // live traffic only makes sense for a window starting about now
    considerRoadTraffic: startMs > Date.now() - 3600_000 && startMs < Date.now() + 86_400_000,
    populatePolylines: true,
  };
}

// the slice of OptimizeToursResponse we read; proto3 JSON omits zero-valued indices
interface ToursResponse {
  routes?: {
    vehicleIndex?: number;
    visits?: { shipmentIndex?: number; startTime?: string }[];
    metrics?: { travelDistanceMeters?: number; totalDuration?: string };
    routePolyline?: { points?: string };
  }[];
  skippedShipments?: { index?: number; reasons?: { code?: string }[] }[];
  metrics?: {
    aggregatedRouteMetrics?: { travelDistanceMeters?: number; totalDuration?: string };
    usedVehicleCount?: number;
    totalCost?: number;
  };
}

const seconds = (d?: string) => Number.parseFloat(d ?? "0") || 0;
const reason = (code?: string) =>
  code ? code.replace(/^CODE_/, "").replace(/_/g, " ").toLowerCase() : "no room in any route";

export function toPlan(res: ToursResponse, i: OptimizeInput, unlocated: { siteId: string; clientName: string }[]): RoutePlan {
  const stop = (index?: number) => i.stops[index ?? 0]!;
  const agg = res.metrics?.aggregatedRouteMetrics;
  return {
    createdAt: new Date().toISOString(),
    routes: Array.from({ length: i.routes }, (_, k) => {
      const r = res.routes?.find((x) => (x.vehicleIndex ?? 0) === k);
      return {
        label: `Route ${k + 1}`,
        stops: (r?.visits ?? []).map((v) => {
          const s = stop(v.shipmentIndex);
          return { siteId: s.siteId, clientName: s.clientName, lat: s.place.lat, lng: s.place.lng, arrival: v.startTime ?? "" };
        }),
        distanceMeters: r?.metrics?.travelDistanceMeters ?? 0,
        durationSeconds: seconds(r?.metrics?.totalDuration),
        polyline: r?.routePolyline?.points ?? "",
      };
    }),
    skipped: [
      ...unlocated.map((s) => ({ ...s, reason: "no location" })),
      ...(res.skippedShipments ?? []).map((s) => {
        const x = stop(s.index);
        return { siteId: x.siteId, clientName: x.clientName, reason: reason(s.reasons?.[0]?.code) };
      }),
    ],
    metrics: {
      travelDistanceMeters: agg?.travelDistanceMeters ?? 0,
      totalDurationSeconds: seconds(agg?.totalDuration),
      totalCost: res.metrics?.totalCost ?? 0,
      usedVehicleCount: res.metrics?.usedVehicleCount ?? 0,
    },
  };
}

/** Normalize the client's ask; null means it cannot be a valid run. */
export function readInput(body: Record<string, unknown> | null): Omit<OptimizeInput, "depot" | "stops"> | null {
  const routes = Number(body?.routes);
  const minutes = Number(body?.serviceMinutes ?? 30);
  const start = typeof body?.start === "string" ? Date.parse(body.start) : NaN;
  const end = typeof body?.end === "string" ? Date.parse(body.end) : NaN;
  if (!Number.isInteger(routes) || routes < 1 || routes > 10) return null;
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 240) return null;
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start || end - start > 36 * 3600_000) return null;
  return {
    routes,
    serviceSeconds: Math.round(minutes * 60),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
}

/** Run the solver over every located site of the team and keep the plan on the team. */
export async function optimize(env: Env, teamId: string, ask: Omit<OptimizeInput, "depot" | "stops">): Promise<RoutePlan> {
  const [{ results: rows }, team] = await Promise.all([
    env.DB.prepare("SELECT id, client_name AS clientName, place FROM sites WHERE team_id = ? ORDER BY client_name")
      .bind(teamId)
      .all<{ id: string; clientName: string; place: string | null }>(),
    env.DB.prepare("SELECT depot FROM teams WHERE id = ?").bind(teamId).first<{ depot: string | null }>(),
  ]);
  const stops: Stop[] = [];
  const unlocated: { siteId: string; clientName: string }[] = [];
  for (const r of rows) {
    const place = parsePlace(r.place);
    if (place) stops.push({ siteId: r.id, clientName: r.clientName, place });
    else unlocated.push({ siteId: r.id, clientName: r.clientName });
  }
  if (!stops.length) throw new Error("No site has a location yet");
  const input: OptimizeInput = { ...ask, depot: parsePlace(team?.depot), stops };

  const sa = credentials(env);
  if (!sa) throw new Error("Route optimization is not set up for this deployment");
  const url = env.OPTIMIZE_ENDPOINT
    ? `${env.OPTIMIZE_ENDPOINT}/optimize`
    : `https://routeoptimization.googleapis.com/v1/projects/${encodeURIComponent(sa.project)}:optimizeTours`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken(env, sa)}`, "content-type": "application/json" },
    body: JSON.stringify(buildRequest(input)),
  });
  if (!res.ok) {
    // validation problems come back here with Google's own wording
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(detail?.error?.message ?? `Route optimization failed (${res.status})`);
  }
  const plan = toPlan(await res.json<ToursResponse>(), input, unlocated);
  await env.DB.prepare("UPDATE teams SET plan = ? WHERE id = ?").bind(JSON.stringify(plan), teamId).run();
  return plan;
}

/** Turn the team's latest plan into lists: one "Route n" list per used route, sites in visit order. */
export async function applyPlan(env: Env, teamId: string): Promise<boolean> {
  const team = await env.DB.prepare("SELECT plan FROM teams WHERE id = ?").bind(teamId).first<{ plan: string | null }>();
  const plan = team?.plan ? (JSON.parse(team.plan) as RoutePlan) : null;
  if (!plan) return false;
  const { results: lists } = await env.DB.prepare("SELECT id, name FROM lists WHERE team_id = ?")
    .bind(teamId)
    .all<{ id: string; name: string }>();
  const statements: D1PreparedStatement[] = [];
  for (const route of plan.routes) {
    if (!route.stops.length) continue;
    let listId = lists.find((l) => l.name === route.label)?.id;
    if (!listId) {
      listId = crypto.randomUUID();
      statements.push(
        env.DB.prepare("INSERT INTO lists (id, team_id, name, created_at) VALUES (?, ?, ?, ?)").bind(listId, teamId, route.label, new Date().toISOString())
      );
    }
    route.stops.forEach((s, i) =>
      statements.push(
        env.DB.prepare("UPDATE sites SET list_id = ?, position = ? WHERE id = ? AND team_id = ?").bind(listId, i, s.siteId, teamId)
      )
    );
  }
  if (statements.length) await env.DB.batch(statements);
  return true;
}
