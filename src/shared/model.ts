// The single source of truth for what a template can be. The types make
// invalid states unrepresentable (outcome buttons exist only in `outcomes`,
// which is never empty) and `normalizeTemplate` is the server-side gate that
// clamps any untrusted document into that shape or rejects it.

export type BlockKind = "photo" | "text" | "number";

export interface Block {
  id: string;
  kind: BlockKind;
  label: string;
  unit: string; // meaningful for "number" only; kept empty otherwise
}

export interface Outcome {
  id: string;
  label: string;
}

export interface Task {
  id: string;
  name: string;
  blocks: Block[];
  outcomes: Outcome[]; // always at least one — a task must have an outcome
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
  outcomes: 6,
  body: 128 * 1024,
} as const;

const BLOCK_KINDS: readonly BlockKind[] = ["photo", "text", "number"];

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
        label: str(b.label, LIMITS.label, { photo: "Photo", text: "Text", number: "Number" }[kind]),
        unit: kind === "number" ? str(b.unit, LIMITS.unit, "").trim() : "",
      };
    });
  // `endsWith` is the pre-rename key; accept it so older stored docs load.
  const outcomes = arr(t.outcomes ?? t.endsWith, LIMITS.outcomes)
    .map(rec)
    .map((b): Outcome => ({ id: id(b.id), label: str(b.label, LIMITS.label, "DONE") }));
  if (outcomes.length === 0) outcomes.push({ id: crypto.randomUUID(), label: "DONE" });
  return {
    id: id(t.id),
    name: str(t.name, LIMITS.name, "Untitled task"),
    blocks,
    outcomes,
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
