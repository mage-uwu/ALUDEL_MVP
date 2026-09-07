export type ImportState = "uploading" | "uncertain" | "processing" | "importing" | "complete" | "failed";
export interface ImportJob {
  id: string;
  name: string;
  state: ImportState;
  phase: string;
  percent: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  filed: number;
  duplicates: number;
  rejected: number;
  pending?: number;
  total: number;
  processed: number;
  resumable: boolean;
  errors?: { record: string; error: string }[];
}
export const IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const IMPORT_EXTENSIONS = /\.(zip|csv|tsv|json|jsonl|ndjson|txt|text|md|markdown)$/i;

export interface BreakfastPerson {
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  emails: string[];
  phones: string[];
}
export interface BreakfastSemantics {
  schemaVersion: 1;
  client: BreakfastPerson;
  employee: BreakfastPerson;
  user: BreakfastPerson;
  date: { value: string; precision: "date" | "timestamp" } | null;
  serviceAddresses: string[];
}
/** Consume the resolved contract without inferring roles from display labels. */
export function readBreakfastSemantics(value: unknown): BreakfastSemantics | null {
  if (value === undefined) return null; // cached legacy graph
  const s = value as BreakfastSemantics | null;
  const strings = (xs: unknown): xs is string[] => Array.isArray(xs) && xs.every(v => typeof v === "string");
  const nullable = (v: unknown) => v === null || typeof v === "string";
  const person = (p: BreakfastPerson | null | undefined) => p && nullable(p.name) && nullable(p.firstName) && nullable(p.lastName) && strings(p.emails) && strings(p.phones);
  if (!s || s.schemaVersion !== 1 || !person(s.client) || !person(s.employee) || !person(s.user) || !strings(s.serviceAddresses)
    || (s.date !== null && (!s.date || typeof s.date.value !== "string" || !["date", "timestamp"].includes(s.date.precision)))) throw new Error("Unsupported or invalid Breakfast semantics contract");
  if (s.date) {
    const day = s.date.value.slice(0,10), parsed = Date.parse(s.date.value);
    const validDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0,10) === day;
    const validShape = s.date.precision === "date" ? s.date.value === day : /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s.date.value);
    if (!validDay || !validShape || !Number.isFinite(parsed)) throw new Error("Invalid resolved Breakfast date");
  }
  return s;
}
