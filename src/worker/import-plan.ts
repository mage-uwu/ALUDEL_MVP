import { readBreakfastSemantics } from "../shared/breakfast";
import { LIMITS, normalizePlace, normalizeTemplate, type BlockKind } from "../shared/model";
import { paperTime } from "./paper-time";
import type { ImportItem } from "./graph-import";

type Props = Record<string, unknown>;
export interface TemplateMapping { id: string; blocks: Record<string, { id: string; kind: BlockKind; label?: string }> }
export interface SourceTemplate { id: string; name: string; sortStatus?: string; formatIdentity?: string[]; blocks: Array<{ id: string; label: string; valueKind: string; options: unknown[]; identity?: string; canonicalLabel?: string; semanticRole?: string; semanticConfidence?:number; unit?: string }> }
export interface SourceSite { id: string; address: unknown; clientName: unknown; place: unknown; sourceAddress?: string }
const text = (v: unknown) => typeof v === "string" ? v.trim() : "";
const numberValue = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return NaN;
  const raw=value.trim();
  if (!/^\$?[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) return NaN;
  return Number(raw.replace(/^\$/," ").trim().replaceAll(",",""));
};
const clean = (v: unknown) => typeof v === "string" ? v.replace(/^[•\s]+/, "").trim() : v;

async function uuid(key: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const s = [...bytes.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function bounded(item: ImportItem): ImportItem {
  if (new TextEncoder().encode(JSON.stringify(item.payload)).byteLength <= 120 * 1024) return item;
  if (item.kind !== "record" && item.kind !== "pending") throw new Error("A template exceeds 120 KiB; split this source before importing");
  if (item.payload.source || item.payload.siteBinding !== undefined) throw new Error("A database record exceeds 120 KiB; original document is still available in Breakfast");
  return { kind: "rejected", payload: { record: (item.payload.origin as Props).externalId, error: "Record exceeds 120 KiB; split the source form" } };
}

export async function mapTemplate(source: SourceTemplate, teamId: string, jobId = ""): Promise<{ item: ImportItem; mapping: TemplateMapping }> {
  const declared: Record<string, BlockKind | "chrome"> = { number: "number", identifier: "text", choice: "buttons", text: "text", image: "photo", date: "text", time: "text", constant: "chrome" };
  const native = source.blocks.every(b => typeof b.identity === "string" && b.identity.length > 0);
  const name = (text(source.name) || "Imported template").slice(0, 80);
  const blocks = source.blocks.map(b => {
    let kind = Object.hasOwn(declared, b.valueKind) ? declared[b.valueKind] : undefined;
    if (!kind) throw new Error("Breakfast returned an unsupported field type");
    const options = [...new Set(b.options.map(v => String(clean(v))).filter(Boolean))];
    if (kind === "buttons" && (!options.length || options.length > 6 || options.some(v => v.length > 24))) kind = "text";
    if (native && kind === "chrome") kind = "text";
    return { identity: b.identity, semanticRole: b.semanticRole, semanticConfidence:b.semanticConfidence, unit: text(b.unit).slice(0,12), graphId: b.id, label: (text(b.label) || "Field").slice(0, 60), kind, options: kind === "buttons" ? options : [] };
  }).filter(b => b.kind !== "chrome");
  if (blocks.length > LIMITS.tasks * LIMITS.blocks) throw new Error(`Template ${name} exceeds 600 fields; split this source before importing`);
  const schema = native ? JSON.stringify([source.sortStatus === "provisional" ? [jobId,source.id] : ["learned",...(source.formatIdentity ?? []).map(v=>v.toLowerCase()).sort()], blocks.map(b => [b.identity,b.kind,b.unit,b.semanticRole ?? null,[...b.options].sort()]).sort((a,b) => String(a[0]).localeCompare(String(b[0])))]) : JSON.stringify([source.id, blocks.map(b => [b.graphId, b.kind, b.options]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
  const id = await uuid(`${teamId}:template:${schema}`);
  const mapped: TemplateMapping["blocks"] = Object.create(null);
  for (const b of blocks) mapped[b.graphId] = { id: await uuid(native ? `${teamId}:field:${b.identity}` : `${id}:${b.graphId}`), kind: b.kind as BlockKind, ...(native ? {label:b.label} : {}) };
  const tasks = [];
  for (let k = 0; k < blocks.length; k += 20) tasks.push({
    id: await uuid(`${id}:task:${k}`), name: k ? `${name} (${k / 20 + 1})`.slice(0, 80) : name,
    blocks: blocks.slice(k, k + 20).map(b => ({ ...mapped[b.graphId]!, label: b.label, options: b.options, unit: b.unit, ...(b.identity ? {fieldIdentity:b.identity} : {}), ...(b.semanticRole ? {semanticRole:b.semanticRole,semanticConfidence:b.semanticConfidence} : {}) }))
  });
  const template = normalizeTemplate({ name, tasks });
  if (!template) throw new Error("Breakfast returned an empty or invalid template");
  return { item: bounded({ kind: "template", payload: { id, ...template } }), mapping: { id, blocks: mapped } };
}

export async function mapSite(source: SourceSite, teamId: string, jobId: string): Promise<{ item: ImportItem; id: string }> {
  const address = text(source.address), place = normalizePlace(source.place);
  const key = source.sourceAddress !== undefined ? source.id : place?.googlePlaceId || address.toLowerCase().replace(/\s+/g, " ") || `${jobId}:${source.id}`;
  const id = await uuid(`${teamId}:site:${key}`);
  return { id, item: bounded({ kind: "site", payload: { id, clientName: (text(source.clientName) || address || "Imported site").slice(0, 80), locationNote: address.slice(0, 240), place } }) };
}

export function mapRecord(source: Props, template: TemplateMapping | undefined, siteId: string | undefined, timezone: string): ImportItem {
  const resolved = readBreakfastSemantics(source.semantics);
  const when = resolved ? resolved.date?.value ?? null : paperTime(source.date, source.clock, timezone)
    || paperTime(source.submittedOn, "", timezone) || paperTime(source.performedAt, "", timezone);
  const reject = (error: string): ImportItem => ({ kind: "rejected", payload: { record: source.id, error } });
  let problem = !template ? "No template" : !siteId ? "No site" : !when ? "No valid date of service" : null;
  const native = source.siteBinding !== undefined;
  if (problem && !native) return reject(problem);
  if (native && template) for (const [id,value] of Object.entries(source.values as Props)) {
    const block=template.blocks[id];
    if (!block || block.kind === "photo" || Array.isArray(value) || (typeof value === "object" && value !== null)) problem ||= "Some fields require review before filing";
    else if (block.kind === "number" && value !== null && value !== "" && !Number.isFinite(numberValue(value))) problem ||= "A number could not be read";
    else if (typeof value === "string" && value.length > 4000) problem ||= "A field exceeds the report text limit";
  }
  const rawOrigin = (source.origin ?? {}) as Props;
  const externalId = text(rawOrigin.externalId) || text(source.id);
  if (externalId.length > 120) return reject("Source report ID exceeds 120 characters");
  const values: Props = {};
  for (const [id, raw] of Object.entries(source.values as Props)) {
    const mapped = template && Object.hasOwn(template.blocks, id) ? template.blocks[id] : undefined, v = clean(raw);
    if (!mapped || mapped.kind === "photo" || v == null || v === "") continue;
    values[mapped.id] = mapped.kind === "number" ? numberValue(v) : String(v);
  }
  return bounded({
    kind: problem ? "pending" : "record", payload: {
      ...(problem ? {record:source.id,error:problem} : {}),
      ...(native ? {siteBinding:source.siteBinding,sortDecision:source.sortDecision} : {}),
      ...(native && problem ? {source,fieldLabels:Object.fromEntries(Object.keys(source.values as Props).map(id=>[id,template?.blocks[id]?.label || id]))} : {}),
      siteId:siteId ?? null, templateId: template?.id ?? null, performedAt: when,
      byName: resolved ? resolved.employee.name || "" : text(source.byName).split("@")[0], ...(resolved ? { semantics: resolved } : {}), ...(native && problem ? {} : {values}),
      origin: { file: (text(rawOrigin.file) || "graph").slice(0, 200), externalId, ...(typeof rawOrigin.sha256 === "string" ? { sha256: rawOrigin.sha256, page: 1 } : {}) }
    }
  });
}
