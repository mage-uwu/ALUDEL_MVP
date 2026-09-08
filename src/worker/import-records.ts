import { readBreakfastSemantics } from "../shared/breakfast";
import { normalizeOrigin, originKey, type Filled } from "../shared/model";
import { readImportHistory, sha256, type ImportHistory } from "../shared/import-history";
import type { Env } from "./index";
import type { User } from "./auth";
import type { ReportMeta } from "./vault";
import { SiteContacts } from "../shared/site-contacts";
import { enrichSite } from "./site-contacts";

export interface ImportVault {
  byOrigin(key: string): string | null | Promise<string | null>;
  addImported(meta: Omit<ReportMeta, "facts">, doc: Filled, key: string | null, history?: ImportHistory):
    { id: string; duplicate?: true; error?: string } | Promise<{ id: string; duplicate?: true; error?: string }>;
}
const field = (v: unknown, max: number) => typeof v === "string" ? v.trim().slice(0, max) : "";
const nowIso = () => new Date().toISOString();

/** The same validation gate for external integration tokens and Breakfast jobs. */
export async function fileImportRecords(env: Env, teamId: string, user: Pick<User, "id" | "name">,
  records: unknown[], vault: ImportVault) {
  const results: { index: number; id?: string; duplicate?: true; error?: string }[] = [];
  const contacts = new Map<string, SiteContacts>();
  // a batch is mostly one form at a few sites: look each up once
  type SiteRow = { id: string; name: string };
  type TplRow = { id: string; name: string; version: number };
  const sites = new Map<string, Promise<SiteRow | null>>();
  const dispatches=new Map<string,{id:string}>();
  const templates = new Map<string, Promise<TplRow | null>>();
  const siteOf = (id: string) =>
    sites.get(id) ??
    sites.set(id, env.DB.prepare("SELECT id, client_name AS name FROM sites WHERE id = ? AND team_id = ?").bind(id, teamId).first<SiteRow>()).get(id)!;
  const templateOf = (id: string) =>
    templates.get(id) ??
    templates
      .set(
        id,
        env.DB.prepare("SELECT id, name, version FROM templates WHERE id = ? AND team_id = ?")
          .bind(id, teamId)
          .first<TplRow>()
      )
      .get(id)!;
  for (const [index, raw] of records.entries()) {
    const rec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const fail = (error: string) => results.push({ index, error });
    let semantics;
    try { semantics = readBreakfastSemantics(rec.semantics); }
    catch { fail("Invalid semantics contract"); continue; }
    const origin = normalizeOrigin(rec.origin);
    if (!origin) {
      fail("origin.file required");
      continue;
    }
    if (typeof (rec.origin as Record<string, unknown>).externalId === "string" && ((rec.origin as Record<string, unknown>).externalId as string).trim().length > 120) {
      fail("Source report ID exceeds 120 characters"); continue;
    }
    let history: ImportHistory;
    try { history = await readImportHistory(rec.history ?? { schemaVersion: 1, receivedValues: rec.values }); }
    catch (e) { fail((e as Error).message); continue; }
    const key = originKey(origin);
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
    // Existing storage also holds forms filled in Field. Imported history has
    // no reconstructed form or template-derived facts; its content stands alone.
    const doc: Filled = { tasks: [] };
    const date = semantics ? semantics.date?.value ?? null : rec.performedAt;
    const performed = typeof date === "string" ? Date.parse(date) : NaN;
    // old paperwork may be older than the field's five-year window, but not older than the epoch
    if (Number.isNaN(performed) || performed < 0 || performed > Date.now() + 3600_000) {
      fail("performedAt: a past date");
      continue;
    }
    const dispatchKey=`${site.id}:${tpl.id}`;
    let dispatch=dispatches.get(dispatchKey);
    if (!dispatch) {
      dispatch=await env.DB.prepare("SELECT id FROM dispatches WHERE team_id = ? AND site_id = ? AND template_id = ?").bind(teamId,site.id,tpl.id).first<{id:string}>() ?? undefined;
      if (!dispatch) {
        await env.DB.prepare(`INSERT OR IGNORE INTO dispatches (id, team_id, site_id, template_id, template_version, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(),teamId,site.id,tpl.id,tpl.version,user.id,nowIso()).run();
        dispatch=await env.DB.prepare("SELECT id FROM dispatches WHERE team_id = ? AND site_id = ? AND template_id = ?").bind(teamId,site.id,tpl.id).first<{id:string}>() ?? undefined;
      }
      if (!dispatch) throw new Error("Dispatch creation failed");
      dispatches.set(dispatchKey,dispatch);
    }
    const hash = await sha256(JSON.stringify(history));
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
        byName: semantics ? field(semantics.employee.name, 80) : field(rec.byName, 80) || user.name,
        performedAt: semantics?.date?.precision === "date" ? semantics.date.value : new Date(performed).toISOString(),
        submittedAt: nowIso(),
        hash,
        origin,
        semantics,
      },
      doc,
      key,
      history
    );
    if (added.error) fail(added.error);
    else {
      results.push({ index, ...added });
      if (semantics) {
        const profile = contacts.get(site.id) ?? new SiteContacts();
        profile.add(semantics); contacts.set(site.id, profile);
      }
    }
  }
  // Once per site per bounded batch, including duplicate reimports from older
  // producers whose site rows omitted contacts. Never mine display labels again.
  for (const [siteId, profile] of contacts) await enrichSite(env, teamId, siteId, profile.details());
  return { filed: results.filter((r) => r.id && !r.duplicate).length, results };
}
