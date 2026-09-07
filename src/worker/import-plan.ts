import { readBreakfastSemantics } from "../shared/breakfast";
import { LIMITS, normalizePlace, normalizeTemplate, type BlockKind } from "../shared/model";
import { paperTime } from "./paper-time";
import type { ImportItem } from "./graph-import";

type Props = Record<string, unknown>;
export interface TemplateMapping { id: string; blocks: Record<string, { id: string; kind: BlockKind }> }
export interface SourceTemplate { id: string; name: string; blocks: Array<{ id: string; label: string; valueKind: string; options: unknown[] }> }
export interface SourceSite { id: string; address: unknown; clientName: unknown; place: unknown }
const text = (v: unknown) => typeof v === "string" ? v.trim() : "";
const clean = (v: unknown) => typeof v === "string" ? v.replace(/^[•\s]+/, "").trim() : v;

async function uuid(key: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const s = [...bytes.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function bounded(item: ImportItem): ImportItem {
  if (new TextEncoder().encode(JSON.stringify(item.payload)).byteLength <= 120 * 1024) return item;
  if (item.kind !== "record") throw new Error("A template exceeds 120 KiB; split this source before importing");
  return { kind: "rejected", payload: { record: (item.payload.origin as Props).externalId, error: "Record exceeds 120 KiB; split the source form" } };
}

export async function mapTemplate(source: SourceTemplate, teamId: string): Promise<{ item: ImportItem; mapping: TemplateMapping }> {
  const declared: Record<string, BlockKind | "chrome"> = { number: "number", identifier: "text", choice: "buttons", text: "text", image: "photo", date: "text", time: "text", constant: "chrome" };
  const name = (text(source.name) || "Imported template").slice(0, 80);
  const blocks = source.blocks.map(b => {
    let kind = Object.hasOwn(declared, b.valueKind) ? declared[b.valueKind] : undefined;
    if (!kind) throw new Error("Breakfast returned an unsupported field type");
    const options = [...new Set(b.options.map(v => String(clean(v))).filter(Boolean))];
    if (kind === "buttons" && (!options.length || options.length > 6 || options.some(v => v.length > 24))) kind = "text";
    return { graphId: b.id, label: (text(b.label) || "Field").slice(0, 60), kind, options: kind === "buttons" ? options : [] };
  }).filter(b => b.kind !== "chrome");
  if (blocks.length > LIMITS.tasks * LIMITS.blocks) throw new Error(`Template ${name} exceeds 600 fields; split this source before importing`);
  const schema = JSON.stringify([source.id, blocks.map(b => [b.graphId, b.kind, b.options]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
  const id = await uuid(`${teamId}:template:${schema}`);
  const mapped: TemplateMapping["blocks"] = Object.create(null);
  for (const b of blocks) mapped[b.graphId] = { id: await uuid(`${id}:${b.graphId}`), kind: b.kind as BlockKind };
  const tasks = [];
  for (let k = 0; k < blocks.length; k += 20) tasks.push({
    id: await uuid(`${id}:task:${k}`), name: k ? `${name} (${k / 20 + 1})`.slice(0, 80) : name,
    blocks: blocks.slice(k, k + 20).map(b => ({ ...mapped[b.graphId]!, label: b.label, options: b.options, unit: "" }))
  });
  const template = normalizeTemplate({ name, tasks });
  if (!template) throw new Error("Breakfast returned an empty or invalid template");
  return { item: bounded({ kind: "template", payload: { id, ...template } }), mapping: { id, blocks: mapped } };
}

export async function mapSite(source: SourceSite, teamId: string, jobId: string): Promise<{ item: ImportItem; id: string }> {
  const address = text(source.address), place = normalizePlace(source.place);
  const key = place?.googlePlaceId || address.toLowerCase().replace(/\s+/g, " ") || `${jobId}:${source.id}`;
  const id = await uuid(`${teamId}:site:${key}`);
  return { id, item: bounded({ kind: "site", payload: { id, clientName: (text(source.clientName) || address || "Imported site").slice(0, 80), locationNote: address.slice(0, 240), place } }) };
}

export function mapRecord(source: Props, template: TemplateMapping | undefined, siteId: string | undefined, timezone: string): ImportItem {
  const resolved = readBreakfastSemantics(source.semantics);
  const when = resolved ? resolved.date?.value ?? null : paperTime(source.date, source.clock, timezone)
    || paperTime(source.submittedOn, "", timezone) || paperTime(source.performedAt, "", timezone);
  const reject = (error: string): ImportItem => ({ kind: "rejected", payload: { record: source.id, error } });
  if (!template || !siteId || !when) return reject(!template ? "No template" : !siteId ? "No site" : "No valid date of service");
  const rawOrigin = source.origin as Props;
  const externalId = text(rawOrigin.externalId) || text(source.id);
  if (externalId.length > 120) return reject("Source report ID exceeds 120 characters");
  const values: Props = {};
  for (const [id, raw] of Object.entries(source.values as Props)) {
    const mapped = Object.hasOwn(template.blocks, id) ? template.blocks[id] : undefined, v = clean(raw);
    if (!mapped || mapped.kind === "photo" || v == null || v === "") continue;
    values[mapped.id] = mapped.kind === "number" ? Number(v) : String(v);
  }
  return bounded({
    kind: "record", payload: {
      siteId, templateId: template.id, performedAt: when,
      byName: resolved ? resolved.employee.name || "" : text(source.byName).split("@")[0], ...(resolved ? { semantics: resolved } : {}), values,
      origin: { file: (text(rawOrigin.file) || "graph").slice(0, 200), externalId, ...(typeof rawOrigin.sha256 === "string" ? { sha256: rawOrigin.sha256, page: 1 } : {}) }
    }
  });
}
