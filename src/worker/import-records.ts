import { normalizeFilled, normalizeOrigin, normalizeTemplate, originKey, type Template, type Filled } from "../shared/model";
import type { Env } from "./index";
import type { User } from "./auth";
import type { ReportMeta } from "./vault";

export interface ImportVault {
  byOrigin(key: string): string | null | Promise<string | null>;
  addImported(meta: Omit<ReportMeta, "facts">, doc: Filled, key: string | null):
    { id: string; duplicate?: true } | Promise<{ id: string; duplicate?: true }>;
}
const field = (v: unknown, max: number) => typeof v === "string" ? v.trim().slice(0, max) : "";
const nowIso = () => new Date().toISOString();

/** The same validation gate for external integration tokens and Breakfast jobs. */
export async function fileImportRecords(env: Env, teamId: string, user: Pick<User, "id" | "name">,
  records: unknown[], vault: ImportVault) {
  const results: { index: number; id?: string; duplicate?: true; error?: string }[] = [];
  // a batch is mostly one form at a few sites: look each up once
  type SiteRow = { id: string; name: string };
  type TplRow = { id: string; name: string; version: number; doc: string; template: Template };
  const sites = new Map<string, Promise<SiteRow | null>>();
  const templates = new Map<string, Promise<TplRow | null>>();
  const siteOf = (id: string) =>
    sites.get(id) ??
    sites.set(id, env.DB.prepare("SELECT id, client_name AS name FROM sites WHERE id = ? AND team_id = ?").bind(id, teamId).first<SiteRow>()).get(id)!;
  const templateOf = (id: string) =>
    templates.get(id) ??
    templates
      .set(
        id,
        env.DB.prepare("SELECT id, name, version, doc FROM templates WHERE id = ? AND team_id = ?")
          .bind(id, teamId)
          .first<Omit<TplRow, "template">>()
          .then((t) => t && { ...t, template: normalizeTemplate({ ...JSON.parse(t.doc), name: t.name })! })
      )
      .get(id)!;
  for (const [index, raw] of records.entries()) {
    const rec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const fail = (error: string) => results.push({ index, error });
    const origin = normalizeOrigin(rec.origin);
    if (!origin) {
      fail("origin.file required");
      continue;
    }
    const key = originKey(origin);
    const seen = key ? await vault.byOrigin(key) : null;
    if (seen) {
      results.push({ index, id: seen, duplicate: true });
      continue;
    }
    const site = await siteOf(field(rec.siteId, 36));
    if (!site) {
      fail("Unknown site");
      continue;
    }
    const tpl = await templateOf(field(rec.templateId, 36));
    if (!tpl) {
      fail("Unknown template");
      continue;
    }
    const doc = normalizeFilled(tpl.template, rec);
    if (!doc) {
      fail("Nothing filled in");
      continue;
    }
    const performed = typeof rec.performedAt === "string" ? Date.parse(rec.performedAt) : NaN;
    // old paperwork may be older than the field's five-year window, but not older than the epoch
    if (Number.isNaN(performed) || performed < 0 || performed > Date.now() + 3600_000) {
      fail("performedAt: a past date");
      continue;
    }
    // the record files against a dispatch, made on the spot when this site was never dispatched in the app
    let dispatch = await env.DB.prepare("SELECT id FROM dispatches WHERE site_id = ? AND template_id = ?")
      .bind(site.id, tpl.id)
      .first<{ id: string }>();
    if (!dispatch) {
      dispatch = { id: crypto.randomUUID() };
      await env.DB.prepare(
        `INSERT OR IGNORE INTO dispatches (id, team_id, site_id, template_id, template_version, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(dispatch.id, teamId, site.id, tpl.id, tpl.version, user.id, nowIso())
        .run();
    }
    // Another importer may have created the unique site/template dispatch.
    dispatch = await env.DB.prepare("SELECT id FROM dispatches WHERE site_id = ? AND template_id = ?")
      .bind(site.id, tpl.id).first<{ id: string }>();
    if (!dispatch) throw new Error("Dispatch creation failed");
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const added = await vault.addImported(
      {
        id: crypto.randomUUID(),
        siteId: site.id,
        siteName: site.name,
        templateId: tpl.id,
        templateName: tpl.name,
        templateVersion: tpl.version,
        dispatchId: dispatch.id,
        byUser: user.id,
        byName: field(rec.byName, 80) || user.name,
        performedAt: new Date(performed).toISOString(),
        submittedAt: nowIso(),
        hash,
        origin,
      },
      doc,
      key
    );
    results.push({ index, ...added });
  }
  return { filed: results.filter((r) => r.id && !r.duplicate).length, results };
}
