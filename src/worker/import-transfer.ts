import type { ImportItem } from "./graph-import";
import { mapTemplate, mapSite, mapRecord, type TemplateMapping, type SourceTemplate, type SourceSite } from "./import-plan";

export type TransferRow = {
  job_id: string; cursor: string | null; snapshot: string; next_seq: number;
  total_items: number; total_records: number; complete: number;
}
export interface TransferPage {
  schemaVersion: 1; format?: string; jobId: string; snapshot: string; start: number;
  nextCursor: string | null; totalItems: number; totalRecords: number;
  items: Array<{ kind: string; payload: Record<string, unknown> }>;
}
export interface CatalogItem { kind: "template" | "site"; source: string; mapping: TemplateMapping | { id: string } }
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;

export function readTransferPage(raw: unknown, jobId: string, previous?: TransferRow): TransferPage {
  if (!object(raw) || raw.schemaVersion !== 1 || raw.jobId !== jobId || typeof raw.snapshot !== "string" || !/^[a-f0-9]{64}$/.test(raw.snapshot)
    || ![raw.start, raw.totalItems, raw.totalRecords].every(v => Number.isSafeInteger(v) && Number(v) >= 0)
    || Number(raw.totalRecords) > Number(raw.totalItems) || !Array.isArray(raw.items) || raw.items.length > 256) throw new Error("Invalid Breakfast import page");
  const page = raw as unknown as TransferPage, end = page.start + page.items.length;
  if (page.start !== (previous?.next_seq ?? 0) || end > page.totalItems
    || (previous && (page.snapshot !== previous.snapshot || page.totalItems !== previous.total_items || page.totalRecords !== previous.total_records))
    || (end < page.totalItems ? !page.items.length || page.nextCursor !== `${page.snapshot}:${end}` : page.nextCursor !== null)) throw new Error("Breakfast import pages are out of sequence or changed");
  for (const item of page.items) {
    if (!object(item) || !object(item.payload) || !["template", "site", "record", "rejected"].includes(item.kind)) throw new Error("Invalid Breakfast import item");
    const p = item.payload;
    if (item.kind === "rejected") {
      if (!id(p.record) || typeof p.error !== "string" || p.error.length > 1000) throw new Error("Invalid rejected record");
      continue;
    }
    if (!id(p.id)) throw new Error("Invalid import source identity");
    if (item.kind === "template" && (typeof p.name !== "string" || !Array.isArray(p.blocks) || p.blocks.length > 10_000
      || !p.blocks.every(b => object(b) && id(b.id) && typeof b.label === "string" && typeof b.valueKind === "string" && Array.isArray(b.options))
      || new Set(p.blocks.map(b => (b as Record<string, unknown>).id)).size !== p.blocks.length)) throw new Error("Invalid import template");
    if (item.kind === "template" && page.format === "breakfast-database") {
      const fields=p.blocks as Record<string,unknown>[];
      if (!fields.every(b=>id(b.identity)) || new Set(fields.map(b=>b.identity)).size !== fields.length
        || (p.formatIdentity !== undefined && (!Array.isArray(p.formatIdentity) || !p.formatIdentity.every(v=>typeof v === "string")))) throw new Error("Invalid database field identities");
    }
    if (item.kind === "record" && (!object(p.origin) || !object(p.values) || (p.templateId !== null && !id(p.templateId)) || (p.siteId !== null && !id(p.siteId)))) throw new Error("Invalid import record");
  }
  return page;
}

/** Only one page and its referenced catalog entries are held in Worker memory. */
export async function planTransferPage(page: TransferPage, teamId: string, jobId: string, timezone: string,
  load: (kind: string, source: string) => TemplateMapping | { id: string } | undefined,
  reconcile?: { template: (source: SourceTemplate, proposed: Awaited<ReturnType<typeof mapTemplate>>) => Promise<Awaited<ReturnType<typeof mapTemplate>>>; site: (source: SourceSite, proposed: Awaited<ReturnType<typeof mapSite>>) => Promise<Awaited<ReturnType<typeof mapSite>>> }) {
  const catalog: CatalogItem[] = [], items: ImportItem[] = [];
  const cache = new Map<string, TemplateMapping | { id: string } | undefined>();
  const get = (kind: string, source: unknown) => {
    if (!id(source)) return undefined;
    const key = JSON.stringify([kind, source]);
    if (!cache.has(key)) cache.set(key, load(kind, source));
    return cache.get(key);
  };
  for (const item of page.items) {
    const p = item.payload;
    if (item.kind === "template") {
      let mapped = await mapTemplate(p as unknown as SourceTemplate, teamId, jobId);
      if (reconcile) mapped = await reconcile.template(p as unknown as SourceTemplate,mapped);
      catalog.push({ kind: "template", source: p.id as string, mapping: mapped.mapping });
      cache.set(JSON.stringify(["template", p.id]), mapped.mapping); items.push(mapped.item);
    } else if (item.kind === "site") {
      let mapped = await mapSite(p as unknown as SourceSite, teamId, jobId);
      if (reconcile) mapped = await reconcile.site(p as unknown as SourceSite,mapped);
      catalog.push({ kind: "site", source: p.id as string, mapping: { id: mapped.id } });
      cache.set(JSON.stringify(["site", p.id]), { id: mapped.id }); items.push(mapped.item);
    } else if (item.kind === "record") {
      const template = get("template", p.templateId) as TemplateMapping | undefined, site = get("site", p.siteId);
      if ((p.templateId && !template) || (p.siteId && !site)) throw new Error("Import record references a missing template or site");
      items.push(mapRecord(p, template, site?.id, timezone));
    } else items.push({ kind: "rejected", payload: p });
  }
  return { catalog, items };
}
