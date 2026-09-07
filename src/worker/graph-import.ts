import { readBreakfastSemantics } from "../shared/breakfast";
import { type BlockKind } from "../shared/model";
export { paperTime } from "./paper-time";
import { mapTemplate, mapSite, mapRecord, type TemplateMapping } from "./import-plan";

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
  const templates = new Map<string, TemplateMapping>();
  for (const [i, t] of g.nodes.filter(n => n.kind === "template").entries()) {
    const mine = records.filter(r => first(r.id, "instance_of")?.id === t.id);
    const name = (common(mine.map(r => text(value(r, "form_name")))) || text(props(t).displayName) || text(props(t).name) || `Imported template ${i + 1}`).slice(0, 80);
    const blocks = targets(t.id, "defines_block").map(b => ({ graphId: b.id, label: (text(props(b).conceptDisplayName) || text(props(b).displayName) || text(props(b).labelId) || "Field").slice(0, 60), ...kindOf(b) })).filter(b => b.kind !== "chrome");
    const mapped = await mapTemplate({ id: t.id, name, blocks: blocks.map(b => ({ id: b.graphId, label: b.label, valueKind: b.kind === "buttons" ? "choice" : b.kind === "photo" ? "image" : b.kind, options: b.options })) }, teamId);
    templates.set(t.id, mapped.mapping);
    plan.push(mapped.item);
  }
  const sites = new Map<string, string>();
  for (const s of g.nodes.filter(n => n.kind === "site")) {
    const p = props(s), address = text(p.address);
    const mine = records.filter(r => first(r.id, "at_site")?.id === s.id);
    const names = mine.map(r => semantics.get(r.id) ? semantics.get(r.id)!.client.name || "" : [value(r, "account_name_first", "customer_name_first"), value(r, "account_name_last", "customer_name_last")].map(text).filter(Boolean).join(" "));
    const mapped = await mapSite({ id: s.id, address, clientName: common(names), place: p.place }, teamId, jobId);
    sites.set(s.id, mapped.id);
    plan.push(mapped.item);
  }
  for (const r of records) {
    const p = props(r), t = first(r.id, "instance_of"), s = first(r.id, "at_site");
    const tm = t && templates.get(t.id), siteId = s && sites.get(s.id);
    const values: Props = {};
    for (const f of facts(r)) { const b = first(f.id, "uses_block"); if (b) values[b.id] = props(f).value; }
    plan.push(mapRecord({
      id: r.id, semantics: props(r).semantics, values,
      date: value(r, "date_of_service", "service_date", "performed_date", "visit_date", "performed_at"),
      clock: value(r, "time_of_service", "start_time", "service_time"), submittedOn: value(r, "submitted_on"), performedAt: p.performedAt,
      byName: props(first(r.id, "performed_by")).name,
      origin: {
        file: text(p.sourcePath) || text(p.archiveFolder) || "graph", externalId: text(p.externalId) || text(p.reportId) || r.id,
        ...(typeof p.sha256 === "string" ? { sha256: p.sha256, page: 1 } : {})
      }
    }, tm, siteId, timezone));
  }
  return plan;
}
