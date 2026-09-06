import { readBreakfastSemantics } from "../shared/breakfast";
import { LIMITS, normalizePlace, normalizeTemplate, type BlockKind } from "../shared/model";

type Props = Record<string, unknown>;
interface Node { id: string; kind: string; properties?: Props }
interface Edge { source: string; target: string; kind: string }
export interface ImportItem { kind: "template" | "site" | "record" | "rejected"; payload: Props }
const props = (n?: Node): Props => n?.properties ?? {};
const text = (v: unknown) => typeof v === "string" ? v.trim() : "";
const clean = (v: unknown) => typeof v === "string" ? v.replace(/^[•\s]+/, "").trim() : v;
const common = (xs: string[]) => {
  const counts = new Map<string, number>();
  for (const x of xs.filter(Boolean)) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
};

/** Stable, team-scoped IDs make a crash between creation and checkpoint safe. */
async function uuid(key: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const s = [...bytes.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Interpret local paperwork times in its declared zone; reject impossible wall times. */
export function paperTime(date: unknown, clock: unknown, timezone: string): string | null {
  const raw = text(date);
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const parsed = Date.parse(raw); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const us = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T]+(.+))?$/.exec(raw);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]+(.+))?$/.exec(raw);
  if (!us && !iso) return null;
  const [y, m, d] = us ? [+us[3]!, +us[1]!, +us[2]!] : [+iso![1]!, +iso![2]!, +iso![3]!];
  const time = text(clock) || (us ?? iso)![4] || "12:00";
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i.exec(time);
  if (!t) return null;
  let h = +t[1]!;
  const minute = +t[2]!, second = +(t[3] ?? 0);
  if (minute > 59 || second > 59 || h > (t[4] ? 12 : 23) || (t[4] && h < 1)) return null;
  if (t[4]) h = h % 12 + (/pm/i.test(t[4]) ? 12 : 0);
  const wall = Date.UTC(y!, m! - 1, d!, h, minute, second);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m! - 1 || check.getUTCDate() !== d) return null;
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const local = (stamp: number) => {
    const p = Object.fromEntries(fmt.formatToParts(stamp).map(x => [x.type, x.value]));
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  };
  let guess = wall;
  for (let i = 0; i < 3; i++) guess += wall - local(guess);
  return local(guess) === wall ? new Date(guess).toISOString() : null;
}

/** Port of tools/import-graph.mjs for the Worker: no filesystem or outbound writes. */
export async function planGraph(input: unknown, teamId: string, jobId: string, timezone: string): Promise<ImportItem[]> {
  const g = input as { nodes?: Node[]; edges?: Edge[] } | null;
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges) || !g.nodes.every(n => n && typeof n.id === "string" && typeof n.kind === "string") || !g.edges.every(e => e && typeof e.source === "string" && typeof e.target === "string" && typeof e.kind === "string")) throw new Error("Breakfast returned an invalid graph");
  const nodes = new Map(g.nodes.map(n => [n.id, n]));
  const edges = new Map<string, Map<string, Node[]>>();
  for (const e of g.edges) {
    const target = nodes.get(e.target); if (!target) continue;
    let out = edges.get(e.source); if (!out) edges.set(e.source, out = new Map());
    let group = out.get(e.kind); if (!group) out.set(e.kind, group = []);
    group.push(target);
  }
  const targets = (id: string, kind: string) => edges.get(id)?.get(kind) ?? [];
  const first = (id: string, kind: string) => targets(id, kind)[0];
  const records = g.nodes.filter(n => n.kind === "record");
  if (!records.length) throw new Error("Breakfast returned no report records");
  const semantics = new Map(records.map(r => [r.id, readBreakfastSemantics(props(r).semantics)]));
  const facts = (r: Node) => targets(r.id, "has_fact");
  const value = (r: Node, ...labels: string[]) => props(facts(r).find(f => labels.includes(text(props(f).labelId)) || labels.includes(text(props(f).canonicalLabel)))).value;
  const usage = new Map<string, unknown[]>();
  for (const r of records) for (const f of facts(r)) {
    const b = first(f.id, "uses_block"); if (!b) continue;
    if (!usage.has(b.id)) usage.set(b.id, []);
    usage.get(b.id)!.push(clean(props(f).value));
  }
  const declared: Record<string, BlockKind | "chrome"> = { number: "number", identifier: "text", choice: "buttons", text: "text", image: "photo", date: "text", time: "text", constant: "chrome" };
  const kindOf = (b: Node): { kind: BlockKind | "chrome"; options: string[] } => {
    const p = props(b), vals = (usage.get(b.id) ?? []).filter(v => v !== "" && v != null);
    let kind = declared[text(p.valueKind)];
    const distinct = [...new Set(vals.map(String))];
    if (!kind) kind = vals.length && vals.every(v => typeof v === "number" || /^-?\d+(\.\d+)?$/.test(String(v))) ? "number"
      : vals.length && vals.every(v => /\.(jpe?g|png|gif|heic|webp)$/i.test(String(v))) ? "photo"
      : distinct.length === 1 && vals.length >= 3 && distinct[0]!.length > 40 ? "chrome"
      : distinct.length >= 2 && distinct.length <= 6 && distinct.every(v => v.length <= 24) ? "buttons" : "text";
    const options = Array.isArray(p.choiceOptions) ? [...new Set(p.choiceOptions.map(v => String(clean(v))).filter(Boolean))] : distinct;
    if (kind === "buttons" && (!options.length || options.length > 6 || options.some(v => v.length > 24))) kind = "text";
    return { kind, options: kind === "buttons" ? options : [] };
  };
  const plan: ImportItem[] = [];
  const templates = new Map<string, { id: string; blocks: Map<string, { id: string; kind: BlockKind }> }>();
  for (const [i, t] of g.nodes.filter(n => n.kind === "template").entries()) {
    const mine = records.filter(r => first(r.id, "instance_of")?.id === t.id);
    const name = (common(mine.map(r => text(value(r, "form_name")))) || text(props(t).displayName) || text(props(t).name) || `Imported template ${i + 1}`).slice(0, 80);
    const blocks = targets(t.id, "defines_block").map(b => ({ graphId: b.id, label: (text(props(b).conceptDisplayName) || text(props(b).displayName) || text(props(b).labelId) || "Field").slice(0, 60), ...kindOf(b) })).filter(b => b.kind !== "chrome");
    if (blocks.length > LIMITS.tasks * LIMITS.blocks) throw new Error(`Template ${name} exceeds 600 fields; split this source before importing`);
    // Schema is part of identity: another upload's template_01 must never reuse an unrelated form.
    const schema = JSON.stringify([t.id, blocks.map(b => [b.graphId, b.kind, b.options]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
    const id = await uuid(`${teamId}:template:${schema}`);
    const mapped = new Map<string, { id: string; kind: BlockKind }>();
    for (const b of blocks) mapped.set(b.graphId, { id: await uuid(`${id}:${b.graphId}`), kind: b.kind as BlockKind });
    const tasks = [];
    for (let k = 0; k < blocks.length; k += 20) tasks.push({ id: await uuid(`${id}:task:${k}`), name: k ? `${name} (${k / 20 + 1})`.slice(0, 80) : name, blocks: blocks.slice(k, k + 20).map(b => ({ ...mapped.get(b.graphId)!, label: b.label, options: b.options, unit: "" })) });
    templates.set(t.id, { id, blocks: mapped });
    plan.push({ kind: "template", payload: { id, ...normalizeTemplate({ name, tasks })! } });
  }
  const sites = new Map<string, string>();
  for (const s of g.nodes.filter(n => n.kind === "site")) {
    const p = props(s), address = text(p.address);
    const mine = records.filter(r => first(r.id, "at_site")?.id === s.id);
    const names = mine.map(r => semantics.get(r.id) ? semantics.get(r.id)!.client.name || "" : [value(r, "account_name_first", "customer_name_first"), value(r, "account_name_last", "customer_name_last")].map(text).filter(Boolean).join(" "));
    // Only an already normalized place is accepted; raw addresses remain notes for the picker.
    const place = normalizePlace(p.place);
    const key = place?.googlePlaceId || address.toLowerCase().replace(/\s+/g, " ") || `${jobId}:${s.id}`;
    const id = await uuid(`${teamId}:site:${key}`); sites.set(s.id, id);
    plan.push({ kind: "site", payload: { id, clientName: (common(names) || address || "Imported site").slice(0, 80), locationNote: address.slice(0, 240), place } });
  }
  for (const r of records) {
    const p = props(r), t = first(r.id, "instance_of"), s = first(r.id, "at_site");
    const tm = t && templates.get(t.id), siteId = s && sites.get(s.id);
    const resolved = semantics.get(r.id);
    const when = resolved ? resolved.date?.value ?? null : paperTime(value(r, "date_of_service", "service_date", "performed_date", "visit_date", "performed_at"), value(r, "time_of_service", "start_time", "service_time"), timezone)
      || paperTime(value(r, "submitted_on"), "", timezone) || paperTime(p.performedAt, "", timezone);
    const reject = (error: string) => plan.push({ kind: "rejected", payload: { record: r.id, error } });
    if (!tm || !siteId || !when) { reject(!tm ? "No template" : !siteId ? "No site" : "No valid date of service"); continue; }
    const values: Props = {};
    for (const f of facts(r)) {
      const b = first(f.id, "uses_block"), mapped = b && tm.blocks.get(b.id), v = clean(props(f).value);
      if (!mapped || mapped.kind === "photo" || v == null || v === "") continue;
      values[mapped.id] = mapped.kind === "number" ? Number(v) : String(v);
    }
    const externalId = text(p.externalId) || text(p.reportId) || r.id;
    if (externalId.length > 120) { reject("Source report ID exceeds 120 characters"); continue; }
    plan.push({ kind: "record", payload: { siteId, templateId: tm.id, performedAt: when, byName: resolved ? resolved.employee.name || "" : text(props(first(r.id, "performed_by")).name).split("@")[0], ...(resolved ? {semantics:resolved} : {}), values,
      origin: { file: (text(p.sourcePath) || text(p.archiveFolder) || "graph").slice(0, 200), externalId, ...(typeof p.sha256 === "string" ? { sha256: p.sha256, page: 1 } : {}) } } });
  }
  const encoder = new TextEncoder();
  for (const [index, item] of plan.entries()) {
    if (encoder.encode(JSON.stringify(item.payload)).byteLength <= 120 * 1024) continue;
    if (item.kind !== "record") throw new Error("A template exceeds 120 KiB; split this source before importing");
    const origin = item.payload.origin as Props;
    plan[index] = { kind: "rejected", payload: { record: origin.externalId, error: "Record exceeds 120 KiB; split the source form" } };
  }
  return plan;
}
