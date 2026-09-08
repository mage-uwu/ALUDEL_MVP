import { readBreakfastSemantics } from "../shared/breakfast";
import { LIMITS, normalizePlace, normalizeTemplate, type BlockKind } from "../shared/model";
import { paperTime } from "./paper-time";
import type { ImportItem } from "./graph-import";
import { HISTORY_MAX_BYTES, type ImportHistory } from "../shared/import-history";
import { siteClient } from "../shared/site-contacts";

type Props = Record<string, unknown>;
export interface TemplateMapping { id: string; blocks: Record<string, { id: string; kind: BlockKind; label?: string }> }
export interface SourceTemplate { id: string; name: string; sortStatus?: string; formatIdentity?: string[]; blocks: Array<{ id: string; label: string; valueKind: string; options: unknown[]; identity?: string; canonicalLabel?: string; semanticRole?: string; semanticConfidence?:number; unit?: string }> }
export interface SourceSite { id: string; address: unknown; clientName: unknown; place: unknown; sourceAddress?: string; client?: unknown }
const text = (v: unknown) => typeof v === "string" ? v.trim() : "";
const clean = (v: unknown) => typeof v === "string" ? v.replace(/^[•\s]+/, "").trim() : v;

async function uuid(key: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const s = [...bytes.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function bounded(item: ImportItem): ImportItem {
  if (new TextEncoder().encode(JSON.stringify(item.payload)).byteLength <= HISTORY_MAX_BYTES) return item;
  throw new Error("An import item exceeds 960 KiB; no historical content was discarded");
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
  const client = siteClient(source.client);
  return { id, item: bounded({ kind: "site", payload: { id, clientName: (client?.name || text(source.clientName) || address || "Imported site").slice(0, 80),
    address: (place?.formattedAddress || address).slice(0, 240), locationNote: "", place, emails: client?.emails ?? [], phones: client?.phones ?? [] } }) };
}

export function mapRecord(source: Props, template: TemplateMapping | undefined, siteId: string | undefined, timezone: string): ImportItem {
  const resolved = readBreakfastSemantics(source.semantics);
  const when = resolved ? resolved.date?.value ?? null : paperTime(source.date, source.clock, timezone)
    || paperTime(source.submittedOn, "", timezone) || paperTime(source.performedAt, "", timezone);
  const rawOrigin = (source.origin ?? {}) as Props;
  const externalId = text(rawOrigin.externalId) || text(source.id);
  const pdf = (source.sourceDocument as ImportHistory["sourceDocument"])?.pdf;
  const problem = pdf?.reviewReason || (!template ? "No template" : !siteId ? "No site" : !when ? "No valid date of service"
    : externalId.length > 120 ? "Source report ID exceeds 120 characters" : null);
  const history: ImportHistory = source.sourceDocument
    ? { schemaVersion: 1, sourceDocument: source.sourceDocument as ImportHistory["sourceDocument"] }
    : { schemaVersion: 1, receivedValues: source.values as ImportHistory["receivedValues"] };
  // Template definitions are for future forms. None of their block kinds,
  // labels, options, or text limits participate in archiving historical data.
  return bounded({ kind: problem ? "pending" : "record", payload: {
    ...(problem ? { record: source.id, error: problem } : {}),
    history, siteId: siteId ?? null, templateId: template?.id ?? null, performedAt: when,
    byName: resolved ? resolved.employee.name || "" : text(source.byName),
    ...(resolved ? { semantics: resolved } : {}),
    ...(source.siteBinding !== undefined ? { siteBinding: source.siteBinding, sortDecision: source.sortDecision } : {}),
    origin: { ...rawOrigin, file: (text(rawOrigin.file) || "graph").slice(0, 200), externalId },
  } });
}
