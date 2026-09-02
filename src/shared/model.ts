// The single source of truth for what a template can be. A task is a name and
// an ordered list of blocks; a buttons group is just another block kind, placed
// wherever the author wants it. `normalizeTemplate` is the server-side gate
// that clamps any untrusted document into that shape or rejects it.

export type BlockKind = "photo" | "text" | "number" | "buttons";

export type Role = "owner" | "admin" | "member";

/** Shape check only: real validation is the mail that arrives. Shared so both sides agree. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Block {
  id: string;
  kind: BlockKind;
  label: string;
  unit: string; // meaningful for "number" only; kept empty otherwise
  options: string[]; // the keys of a "buttons" block, 1–6 of them; empty otherwise
}

export interface Task {
  id: string;
  name: string;
  blocks: Block[];
}

export interface Template {
  name: string;
  tasks: Task[];
}

export const LIMITS = {
  name: 80,
  label: 60,
  unit: 12,
  key: 24,
  options: 6,
  tasks: 30,
  blocks: 20,
  body: 128 * 1024,
} as const;

const BLOCK_KINDS: readonly BlockKind[] = ["photo", "text", "number", "buttons"];

export const DEFAULT_LABEL: Record<BlockKind, string> = {
  photo: "Photo",
  text: "Text",
  number: "Number",
  buttons: "Outcome",
};

/** A fresh buttons block: two named keys, the smallest useful choice. */
export const DEFAULT_OPTIONS: readonly string[] = ["PASS", "FAIL"];

/** 1–6 non-empty keys; an empty or missing list gets the defaults. */
const optionsOf = (v: unknown): string[] => {
  const keys = arr(v, LIMITS.options)
    .map((k) => str(k, LIMITS.key, ""))
    .filter(Boolean);
  return keys.length ? keys : [...DEFAULT_OPTIONS];
};

const str = (v: unknown, max: number, fallback: string): string =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback;

const id = (v: unknown): string =>
  typeof v === "string" && /^[0-9a-fA-F-]{1,36}$/.test(v) ? v : crypto.randomUUID();

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

const arr = (v: unknown, max: number): unknown[] =>
  Array.isArray(v) ? v.slice(0, max) : [];

function normalizeTask(input: unknown): Task {
  const t = rec(input);
  const blocks: Block[] = [];
  // Older documents stored one block per button (`kind: "button"`), and older
  // still a task-bound `outcomes` / `endsWith` list. Each such button becomes a
  // key of a buttons block, and a run of them folds into one block.
  let folding: Block | null = null;
  const legacyKey = (b: Record<string, unknown>) => {
    const key = str(b.label, LIMITS.key, "DONE");
    if (folding && folding.options.length < LIMITS.options) return folding.options.push(key);
    folding = { id: id(b.id), kind: "buttons", label: DEFAULT_LABEL.buttons, unit: "", options: [key] };
    blocks.push(folding);
  };
  for (const b of arr(t.blocks, LIMITS.blocks).map(rec)) {
    if (b.kind === "button") {
      legacyKey(b);
      continue;
    }
    folding = null;
    if (!BLOCK_KINDS.includes(b.kind as BlockKind)) continue;
    const kind = b.kind as BlockKind;
    blocks.push({
      id: id(b.id),
      kind,
      label: str(b.label, LIMITS.label, DEFAULT_LABEL[kind]),
      unit: kind === "number" ? str(b.unit, LIMITS.unit, "").trim() : "",
      options: kind === "buttons" ? optionsOf(b.options) : [],
    });
  }
  folding = null;
  for (const b of arr(t.outcomes ?? t.endsWith, LIMITS.options).map(rec)) legacyKey(b);
  return {
    id: id(t.id),
    name: str(t.name, LIMITS.name, "Untitled task"),
    blocks: blocks.slice(0, LIMITS.blocks),
  };
}

/** Clamp an untrusted document into a valid Template, or null if it isn't even object-shaped. */
export function normalizeTemplate(input: unknown): Template | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const t = input as Record<string, unknown>;
  return {
    name: str(t.name, LIMITS.name, "Untitled template"),
    tasks: arr(t.tasks, LIMITS.tasks).map(normalizeTask),
  };
}

// ---------------------------------------------------------------------------
// Places. A site's location is a Google place, captured once from the picker and
// normalized into this plain record before it is stored. The live google.maps
// Place object never leaves the browser; this is the only shape the server keeps.

interface PlaceViewport {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** Address components parsed by type; every part is optional, formattedAddress is the fallback. */
export interface AddressParts {
  streetNumber?: string;
  route?: string;
  locality?: string;
  adminArea1?: string;
  adminArea2?: string;
  postalCode?: string;
  country?: string;
  countryCode?: string;
}

export interface AludelPlace {
  googlePlaceId: string;
  name: string;
  formattedAddress: string;
  lat: number;
  lng: number;
  viewport?: PlaceViewport;
  address: AddressParts;
  types: string[];
  /** ISO timestamp of the fetchFields call that produced this record. */
  fetchedAt: string;
}

const PLACE_LIMITS = { id: 512, text: 240, part: 120, types: 20 } as const;

const ADDRESS_KEYS: readonly (keyof AddressParts)[] = [
  "streetNumber", "route", "locality", "adminArea1", "adminArea2", "postalCode", "country", "countryCode",
];

const num = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;

/** A stored place column (JSON text) back into a record; anything that no longer validates reads as no place. */
export const parsePlace = (v: unknown): AludelPlace | null => {
  if (typeof v !== "string" || !v) return null;
  try {
    return normalizePlace(JSON.parse(v));
  } catch {
    return null;
  }
};

// A route plan: what the Route Optimization API answered, mapped back onto the
// team's sites. Produced only by the server, stored on the team, read by the map.
export interface RouteStop {
  siteId: string;
  clientName: string;
  lat: number;
  lng: number;
  arrival: string;
}
export interface RoutePlan {
  createdAt: string;
  routes: {
    label: string;
    stops: RouteStop[];
    distanceMeters: number;
    durationSeconds: number;
    /** Encoded road polyline for the whole route, empty if Google gave none. */
    polyline: string;
  }[];
  skipped: { siteId: string; clientName: string; reason: string }[];
  metrics: { travelDistanceMeters: number; totalDurationSeconds: number; totalCost: number; usedVehicleCount: number };
}

/**
 * Clamp an untrusted place into a valid AludelPlace, or null if it cannot be one:
 * no Google id, no usable coordinates, nothing to call it by, or no fetch time.
 */
export function normalizePlace(input: unknown): AludelPlace | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const p = input as Record<string, unknown>;
  const googlePlaceId = str(p.googlePlaceId, PLACE_LIMITS.id, "");
  const lat = num(p.lat, -90, 90);
  const lng = num(p.lng, -180, 180);
  const formattedAddress = str(p.formattedAddress, PLACE_LIMITS.text, "");
  const name = str(p.name, PLACE_LIMITS.text, formattedAddress);
  const fetchedAt = typeof p.fetchedAt === "string" ? Date.parse(p.fetchedAt) : NaN;
  if (!googlePlaceId || lat === null || lng === null || !name || Number.isNaN(fetchedAt)) return null;

  const address: AddressParts = {};
  const parts = rec(p.address);
  for (const k of ADDRESS_KEYS) {
    const v = str(parts[k], PLACE_LIMITS.part, "");
    if (v) address[k] = v;
  }

  const vp = rec(p.viewport);
  const north = num(vp.north, -90, 90), south = num(vp.south, -90, 90);
  const east = num(vp.east, -180, 180), west = num(vp.west, -180, 180);
  const viewport =
    north !== null && south !== null && east !== null && west !== null && north >= south
      ? { north, south, east, west }
      : undefined;

  const types = arr(p.types, PLACE_LIMITS.types)
    .filter((t): t is string => typeof t === "string" && /^[a-z_]{1,60}$/.test(t));

  return {
    googlePlaceId,
    name,
    formattedAddress: formattedAddress || name,
    lat,
    lng,
    ...(viewport ? { viewport } : {}),
    address,
    types,
    fetchedAt: new Date(fetchedAt).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Filled reports. A crew fills a dispatched template at a site; the result is
// an append-only record. `normalizeFilled` walks the template, not the input,
// so a report can only ever contain the template's own blocks with values of
// the right kind. A block left blank is simply absent from the record.

export type FilledValue = string | number;
export interface FilledBlock {
  id: string;
  kind: BlockKind;
  label: string;
  unit: string;
  value: FilledValue;
}
export interface FilledTask {
  id: string;
  name: string;
  blocks: FilledBlock[];
}
export interface Filled {
  tasks: FilledTask[];
}

export const FILL_LIMITS = { text: 4000 } as const;

/**
 * The template's blocks with the values the crew gave them; unknown blocks and
 * values of the wrong kind are dropped, photos are not captured yet. Null when
 * nothing at all was filled in — an empty report is not a report.
 */
export function normalizeFilled(template: Template, input: unknown): Filled | null {
  const given = rec(input);
  const values = rec(given.values); // block id → raw value
  const tasks: FilledTask[] = [];
  for (const task of template.tasks) {
    const blocks: FilledBlock[] = [];
    for (const b of task.blocks) {
      const raw = values[b.id];
      let value: FilledValue | null = null;
      if (b.kind === "text" && typeof raw === "string" && raw.trim()) value = raw.trim().slice(0, FILL_LIMITS.text);
      if (b.kind === "number" && typeof raw === "number" && Number.isFinite(raw)) value = raw;
      if (b.kind === "number" && typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw))) value = Number(raw);
      if (b.kind === "buttons" && typeof raw === "string" && b.options.includes(raw)) value = raw;
      if (value !== null) blocks.push({ id: b.id, kind: b.kind, label: b.label, unit: b.unit, value });
    }
    if (blocks.length) tasks.push({ id: task.id, name: task.name, blocks });
  }
  return tasks.length ? { tasks } : null;
}

// ---------------------------------------------------------------------------
// Vault queries: the one shape a client (or an agent) may ask in. Everything
// here is compiled to parameterised SQL inside the team's vault; nothing in
// it is ever interpolated.

export interface Atom {
  template: string;
  block: string;
}
export interface Clause {
  /** Exactly this block of this template… */
  atom?: Atom;
  /** …or any block whose label contains this (case-insensitive), across templates. */
  label?: string;
  kind?: BlockKind;
  num?: { eq?: number; lt?: number; lte?: number; gt?: number; gte?: number };
  text?: { eq?: string; contains?: string };
}
export type Select =
  | { rows: true; limit?: number }
  | { agg: "sum" | "avg" | "min" | "max" | "count"; atom?: Atom; label?: string; groupBy?: "site" | "template" | "month" };
export interface VaultQuery {
  template?: string;
  site?: string;
  from?: string;
  to?: string;
  /** A report matches when every clause is satisfied by at least one of its facts. */
  where: Clause[];
  select: Select;
}

export const QUERY_LIMITS = { clauses: 8, rows: 200, groups: 500 } as const;

const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const uuidOr = (v: unknown): string | undefined => (typeof v === "string" && UUID_RE.test(v) ? v : undefined);
const isoOr = (v: unknown): string | undefined =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined;
const atomOf = (v: unknown): Atom | undefined => {
  const a = rec(v);
  const template = uuidOr(a.template);
  const block = typeof a.block === "string" && /^[0-9a-fA-F-]{1,36}$/.test(a.block) ? a.block : undefined;
  return template && block ? { template, block } : undefined;
};
const numOr = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const strOr = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** Clamp an untrusted query into a VaultQuery, or null if it cannot be one. */
export function normalizeQuery(input: unknown): VaultQuery | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const q = input as Record<string, unknown>;
  const where: Clause[] = [];
  for (const raw of arr(q.where, QUERY_LIMITS.clauses)) {
    const c = rec(raw);
    const clause: Clause = {};
    const atom = atomOf(c.atom);
    const label = strOr(c.label, LIMITS.label);
    if (atom) clause.atom = atom;
    else if (label) clause.label = label;
    if (["photo", "text", "number", "buttons"].includes(c.kind as string)) clause.kind = c.kind as BlockKind;
    const n = rec(c.num);
    const num = { eq: numOr(n.eq), lt: numOr(n.lt), lte: numOr(n.lte), gt: numOr(n.gt), gte: numOr(n.gte) };
    if (Object.values(num).some((x) => x !== undefined)) clause.num = num;
    const t = rec(c.text);
    const text = { eq: strOr(t.eq, FILL_LIMITS.text), contains: strOr(t.contains, LIMITS.label) };
    if (text.eq || text.contains) clause.text = text;
    if (Object.keys(clause).length) where.push(clause);
  }
  const s = rec(q.select);
  let select: Select;
  if (s.rows === true) {
    const limit = numOr(s.limit);
    select = { rows: true, limit: Math.min(QUERY_LIMITS.rows, Math.max(1, Math.floor(limit ?? 50))) };
  } else if (["sum", "avg", "min", "max", "count"].includes(s.agg as string)) {
    select = { agg: s.agg as "sum" };
    const atom = atomOf(s.atom);
    const label = strOr(s.label, LIMITS.label);
    if (atom) select.atom = atom;
    else if (label) select.label = label;
    if (["site", "template", "month"].includes(s.groupBy as string)) select.groupBy = s.groupBy as "site";
    // a numeric aggregate needs something to measure; count does not
    if (select.agg !== "count" && !select.atom && !select.label) return null;
  } else return null;
  const out: VaultQuery = { where, select };
  const template = uuidOr(q.template);
  const site = uuidOr(q.site);
  const from = isoOr(q.from);
  const to = isoOr(q.to);
  if (template) out.template = template;
  if (site) out.site = site;
  if (from) out.from = from;
  if (to) out.to = to;
  return out;
}

// ---------------------------------------------------------------------------
// Provenance. A report filed from a phone has none; a report imported from an
// old document says which file, which page, and how sure the classifier was.
// The key makes a re-run idempotent: the same page never files twice.

export interface Origin {
  file: string;
  sha256?: string;
  page?: number;
  confidence?: number;
  externalId?: string;
}

export function normalizeOrigin(v: unknown): Origin | null {
  const o = rec(v);
  const file = str(o.file, 200, "");
  if (!file) return null;
  const out: Origin = { file };
  if (typeof o.sha256 === "string" && /^[0-9a-f]{64}$/i.test(o.sha256)) out.sha256 = o.sha256.toLowerCase();
  if (typeof o.page === "number" && Number.isInteger(o.page) && o.page >= 1) out.page = o.page;
  if (typeof o.confidence === "number" && o.confidence >= 0 && o.confidence <= 1) out.confidence = o.confidence;
  const externalId = str(o.externalId, 120, "");
  if (externalId) out.externalId = externalId;
  return out;
}

/** What makes two imports the same document: an external id, else the file hash and page. */
export const originKey = (o: Origin): string | null =>
  o.externalId ? `id:${o.externalId}` : o.sha256 ? `sha:${o.sha256}#${o.page ?? 0}` : null;
