// The single source of truth for what a template can be. A task is a name and
// an ordered list of blocks; buttons are just another block kind, placed
// wherever the author wants them. `normalizeTemplate` is the server-side gate
// that clamps any untrusted document into that shape or rejects it.

export type BlockKind = "photo" | "text" | "number" | "button";

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
