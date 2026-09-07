import type { VaultFilters } from "../shared/vault";
import { paperTime } from "./paper-time";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const scope = (q: VaultFilters) => JSON.stringify([q.template, q.site, q.from, q.to, q.timezone]);

export interface VaultBrowse extends VaultFilters {
  limit: number;
  fromInstant?: string;
  untilInstant?: string;
  before?: { at: string; id: string };
}

/** Calendar filters include both endpoints. Date-only paperwork keeps its
 * written date; timestamped work uses the viewer's declared calendar zone. */
export function readVaultBrowse(p: URLSearchParams): VaultBrowse {
  const q: VaultBrowse = {
    template: p.get("template") || "", site: p.get("site") || "",
    from: p.get("from") || "", to: p.get("to") || "",
    timezone: p.get("timezone") || "UTC", limit: Number(p.get("limit") ?? 50),
  };
  if ((q.template && !UUID.test(q.template)) || (q.site && !UUID.test(q.site))) throw new Error("Choose a valid template and site");
  if ((q.from && !day(q.from)) || (q.to && !day(q.to))) throw new Error("Dates must be valid YYYY-MM-DD dates");
  if (q.from && q.to && q.from > q.to) throw new Error("The end date must be on or after the start date");
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 100) throw new Error("Page size must be between 1 and 100");
  try {
    if (q.timezone.length > 64) throw new Error();
    q.timezone = new Intl.DateTimeFormat("en", { timeZone: q.timezone }).resolvedOptions().timeZone;
  } catch { throw new Error("Choose a valid timezone"); }
  if (q.from) {
    const start = paperTime(q.from, "00:00", q.timezone);
    if (!start) throw new Error("The start date has no midnight in this timezone");
    q.fromInstant = start;
  }
  if (q.to) {
    const nextDay = new Date(Date.parse(q.to) + 86_400_000).toISOString().slice(0, 10);
    const end = paperTime(nextDay, "00:00", q.timezone);
    if (!end) throw new Error("The end date has no following midnight in this timezone");
    q.untilInstant = end;
  }
  const cursor = p.get("cursor");
  if (cursor) {
    try {
      if (cursor.length > 1500) throw new Error();
      const c = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")));
      if (c.v !== 1 || c.scope !== scope(q) || typeof c.id !== "string" || !UUID.test(c.id) || typeof c.at !== "string" || c.at.length > 40
        || !(day(c.at) || /^\d{4}-\d{2}-\d{2}T/.test(c.at) && Number.isFinite(Date.parse(c.at)))) throw new Error();
      q.before = { at: c.at, id: c.id };
    } catch { throw new Error("Invalid Vault page cursor; return to the first page"); }
  }
  return q;
}

export function vaultWhere(q: VaultBrowse, paginate = false): { sql: string; params: (string | number)[] } {
  const conditions = ["1 = 1"], params: (string | number)[] = [];
  if (q.template) { conditions.push("r.template_id = ?"); params.push(q.template); }
  if (q.site) { conditions.push("r.site_id = ?"); params.push(q.site); }
  if (q.from) {
    conditions.push("(CASE WHEN length(r.performed_at) = 10 THEN r.performed_at >= ? ELSE r.performed_at >= ? END)");
    params.push(q.from, q.fromInstant!);
  }
  if (q.to) {
    conditions.push("(CASE WHEN length(r.performed_at) = 10 THEN r.performed_at <= ? ELSE r.performed_at < ? END)");
    params.push(q.to, q.untilInstant!);
  }
  if (paginate && q.before) {
    conditions.push("(r.performed_at < ? OR (r.performed_at = ? AND r.id < ?))");
    params.push(q.before.at, q.before.at, q.before.id);
  }
  return { sql: conditions.join(" AND "), params };
}

export function vaultCursor(q: VaultBrowse, last: { id: string; performedAt: string }): string {
  return btoa(JSON.stringify({ v: 1, scope: scope(q), at: last.performedAt, id: last.id }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
