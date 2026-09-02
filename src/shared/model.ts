// The single source of truth for what a template can be. A task is a name and
// an ordered list of blocks; buttons are just another block kind, placed
// wherever the author wants them. `normalizeTemplate` is the server-side gate
// that clamps any untrusted document into that shape or rejects it.

export type BlockKind = "photo" | "text" | "number" | "button";

export type Role = "owner" | "admin" | "member";

/** Shape check only: real validation is the mail that arrives. Shared so both sides agree. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Block {
  id: string;
  kind: BlockKind;
  label: string;
  unit: string; // meaningful for "number" only; kept empty otherwise
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
  tasks: 30,
  blocks: 20,
  body: 128 * 1024,
} as const;

const BLOCK_KINDS: readonly BlockKind[] = ["photo", "text", "number", "button"];

const DEFAULT_LABEL: Record<BlockKind, string> = {
  photo: "Photo",
  text: "Text",
  number: "Number",
  button: "DONE",
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
  const blocks = arr(t.blocks, LIMITS.blocks)
    .map(rec)
    .filter((b) => BLOCK_KINDS.includes(b.kind as BlockKind))
    .map((b): Block => {
      const kind = b.kind as BlockKind;
      return {
        id: id(b.id),
        kind,
        label: str(b.label, LIMITS.label, DEFAULT_LABEL[kind]),
        unit: kind === "number" ? str(b.unit, LIMITS.unit, "").trim() : "",
      };
    });
  // `outcomes` (and its older name `endsWith`) was a task-bound button list;
  // stored documents keep their buttons by landing them at the end of blocks.
  const legacy = arr(t.outcomes ?? t.endsWith, LIMITS.blocks)
    .map(rec)
    .map((b): Block => ({
      id: id(b.id),
      kind: "button",
      label: str(b.label, LIMITS.label, DEFAULT_LABEL.button),
      unit: "",
    }));
  return {
    id: id(t.id),
    name: str(t.name, LIMITS.name, "Untitled task"),
    blocks: [...blocks, ...legacy].slice(0, LIMITS.blocks),
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
