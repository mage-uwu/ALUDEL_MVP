import { IMPORT_MAX_BYTES, type ImportJob } from "../shared/breakfast";
import { normalizePlace, normalizeTemplate } from "../shared/model";
import { breakfast, breakfastKey, BreakfastError, limitStream, uploadHeaders } from "./breakfast-api";
import { type ImportItem } from "./graph-import";
import { readTransferPage, planTransferPage, type TransferRow } from "./import-transfer";
import { fileImportRecords, type ImportVault } from "./import-records";
import { mapRecord, type TemplateMapping } from "./import-plan";
import { readBreakfastSemantics } from "../shared/breakfast";
import { readSourceChunk } from "../shared/import-history";
import { PdfStore } from "./pdf-store";
import { importReconciler, withSiteProfiles } from "./import-context";
import type { Env } from "./index";

type JobRow = {
  id: string; team_id: string; user_id: string; user_name: string; name: string; timezone: string;
  upstream_id: string | null; state: ImportJob["state"]; phase: string; percent: number;
  message: string; created_at: string; updated_at: string; next_poll: number; attempts: number;
}
const now = () => new Date().toISOString();
const json = (value: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
});
const ACTIVE = "'uploading','processing','importing'";

/** One durable queue inside the team's existing Vault. Alarms survive closed tabs. */
export class BreakfastImports {
  private sql: SqlStorage;
  private pdfs: PdfStore;
  constructor(private ctx: DurableObjectState, private env: Env, private vault: ImportVault) {
    this.sql = ctx.storage.sql;
    this.pdfs = new PdfStore(this.sql);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS breakfast_jobs (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL, user_id TEXT NOT NULL, user_name TEXT NOT NULL,
      name TEXT NOT NULL, timezone TEXT NOT NULL, upstream_id TEXT, state TEXT NOT NULL,
      phase TEXT NOT NULL, percent REAL NOT NULL DEFAULT 0, message TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_poll INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS breakfast_items (
      job_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
      outcome TEXT, error TEXT, PRIMARY KEY(job_id, seq)
    ); CREATE INDEX IF NOT EXISTS breakfast_pending ON breakfast_items(job_id, outcome, seq);
    CREATE TABLE IF NOT EXISTS breakfast_transfers (
      job_id TEXT PRIMARY KEY, cursor TEXT, snapshot TEXT NOT NULL, next_seq INTEGER NOT NULL,
      total_items INTEGER NOT NULL, total_records INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS breakfast_catalog (
      job_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, mapping TEXT NOT NULL,
      PRIMARY KEY(job_id,kind,source_id)
    );`);
  }
  private row(id: string) { return this.sql.exec<JobRow>("SELECT * FROM breakfast_jobs WHERE id = ?", id).toArray()[0]; }
  private transfer(id: string) { return this.sql.exec<TransferRow>("SELECT * FROM breakfast_transfers WHERE job_id = ?", id).toArray()[0]; }
  private needsTransfer(row: JobRow) {
    // Existing beta failures predate cursor storage and lost their original phase.
    return row.phase === "transfer" || row.message === "The processed result is too large. Split the source into smaller uploads.";
  }
  private view(row: JobRow): ImportJob {
    const c = this.sql.exec<{ total: number; filed: number; duplicates: number; rejected: number; pending: number; processed: number }>(`SELECT
      COUNT(*) AS total, COALESCE(SUM(outcome = 'filed'),0) AS filed, COALESCE(SUM(outcome = 'duplicate'),0) AS duplicates,
      COALESCE(SUM(outcome = 'rejected'),0) AS rejected, COALESCE(SUM(outcome = 'pending'),0) AS pending, COUNT(outcome) AS processed
      FROM breakfast_items WHERE job_id = ? AND kind IN ('record','rejected','pending')`, row.id).toArray()[0]!;
    return {
      id: row.id, name: row.name, state: row.state, phase: row.phase, percent: row.percent, message: row.message,
      createdAt: row.created_at, updatedAt: row.updated_at, ...c, total: this.transfer(row.id)?.total_records ?? c.total,
      resumable: row.state === "failed" && Boolean(row.upstream_id) && (this.needsTransfer(row) || this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM breakfast_items WHERE job_id = ? AND outcome IS NULL", row.id).toArray()[0]!.n > 0)
    };
  }
  list(): ImportJob[] { return this.sql.exec<JobRow>("SELECT * FROM breakfast_jobs ORDER BY created_at DESC LIMIT 30").toArray().map(r => this.view(r)); }
  get(id: string): ImportJob | null {
    const row = this.row(id); if (!row) return null;
    return {
      ...this.view(row), errors: this.sql.exec<{ record: string; error: string }>(`SELECT
      COALESCE(json_extract(payload, '$.record'), json_extract(payload, '$.origin.externalId'), 'Record') AS record, error
      FROM breakfast_items WHERE job_id = ? AND error IS NOT NULL ORDER BY seq LIMIT 50`, id).toArray()
    };
  }
  pending(id: string, after = -1) {
    if (!this.row(id)) return null;
    return this.sql.exec<{ seq:number; record:string; reason:string }>(`SELECT seq,
      COALESCE(json_extract(payload,'$.origin.externalId'),json_extract(payload,'$.record'),'Document') AS record,
      error AS reason FROM breakfast_items WHERE job_id=? AND outcome='pending' AND seq>? ORDER BY seq LIMIT 50`,id,after).toArray();
  }
  pendingDocument(id: string, seq: number) {
    const row = this.sql.exec<{payload:string;error:string}>("SELECT payload,error FROM breakfast_items WHERE job_id=? AND seq=? AND outcome='pending'",id,seq).toArray()[0];
    return row ? {...JSON.parse(row.payload),reason:row.error} : null;
  }
  async resolvePending(id: string, seq: number, siteId: string, date?: string) {
    const job = this.row(id), saved = this.pendingDocument(id,seq);
    if (!job || job.state !== "complete" || !saved) throw new Error("This document is not ready for manual filing");
    let payload = saved;
    if (saved.source) {
      const source = structuredClone(saved.source);
      if (date) source.semantics.date = {value:date,precision:date.length === 10 ? "date" : "timestamp"};
      readBreakfastSemantics(source.semantics);
      const catalog = this.sql.exec<{mapping:string}>("SELECT mapping FROM breakfast_catalog WHERE job_id=? AND kind='template' AND source_id=?",id,source.templateId).toArray()[0];
      const mapped = mapRecord(source,catalog ? JSON.parse(catalog.mapping) as TemplateMapping : undefined,siteId,job.timezone);
      if (mapped.kind !== "record") throw new Error(String(mapped.payload.error ?? "Document requires further review"));
      payload = mapped.payload;
    } else {
      payload = {...saved,siteId};
      if (date) {
        if (payload.semantics) payload.semantics = {...payload.semantics,date:{value:date,precision:date.length === 10 ? "date" : "timestamp"}};
        else payload.performedAt=date;
      }
    }
    const result = (await fileImportRecords(this.env,job.team_id,{id:job.user_id,name:job.user_name},[payload],this.vault)).results[0]!;
    if (result.error) throw new Error(result.error);
    this.sql.exec("UPDATE breakfast_items SET outcome=?,error=NULL WHERE job_id=? AND seq=? AND outcome='pending'",result.duplicate ? "duplicate" : "filed",id,seq);
    const progress=this.get(id)!;
    this.update(id,"complete",`${progress.filed} filed, ${progress.duplicates} already present, ${progress.pending ?? 0} awaiting review, ${progress.rejected} rejected`,"filing",100);
    return result;
  }
  private update(id: string, state: ImportJob["state"], message: string, phase: string = state, percent?: number, delay = 2000) {
    this.sql.exec("UPDATE breakfast_jobs SET state = ?, phase = ?, message = ?, updated_at = ?, next_poll = ?, percent = COALESCE(?, percent) WHERE id = ?",
      state, phase, message, now(), Date.now() + delay, percent ?? null, id);
  }
  private async schedule() {
    const next = this.sql.exec<{ due: number | null }>(`SELECT MIN(next_poll) AS due FROM breakfast_jobs WHERE state IN (${ACTIVE})`).toArray()[0]?.due;
    if (next != null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
    else await this.ctx.storage.deleteAlarm();
  }
  async start(req: Request): Promise<Response> {
    try {
      const key = breakfastKey(this.env);
      if (!key) return json({ error: "Document import is not configured. Ask an administrator to connect it." }, 503);
      const headers = uploadHeaders(req), url = new URL(req.url);
      const id = req.headers.get("x-import-id") ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "A UUID X-Import-Id is required" }, 422);
      const team = url.searchParams.get("teamId")!, user = url.searchParams.get("userId")!, userName = url.searchParams.get("userName")!;
      const timezone = url.searchParams.get("timezone") ?? "";
      try { if (!timezone || timezone.length > 64) throw new Error(); new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
      catch { return json({ error: "Choose a valid paperwork timezone" }, 422); }
      const existing = this.row(id);
      if (existing) { await req.body?.cancel(); return json(this.view(existing), 202); } // never submit the same upload twice
      const name = (url.searchParams.get("name") || "Document import").slice(0, 160);
      this.sql.exec(`INSERT INTO breakfast_jobs (id,team_id,user_id,user_name,name,timezone,state,phase,message,created_at,updated_at,next_poll)
        VALUES (?,?,?,?,?,?,'uploading','uploading','Sending documents',?,?,?)`, id, team, user, userName, name, timezone, now(), now(), Date.now() + 180_000);
      await this.schedule(); // recovery alarm exists before any network side effect
      let submitted = false;
      try {
        const query = new URLSearchParams({ timezone, geocode: "true", semanticReview: "true", transmute: "false" });
        const body = await withSiteProfiles(this.env, team, headers, limitStream(req.body!, IMPORT_MAX_BYTES));
        submitted = true;
        const accepted = await breakfast(this.env, `/v1/pipeline/jobs?${query}`, { method: "POST", headers, body }, 120_000);
        if (typeof accepted.jobId !== "string" || !/^job-[A-Za-z0-9_-]+$/.test(accepted.jobId)) throw new Error("Missing upstream job ID");
        this.sql.exec("UPDATE breakfast_jobs SET upstream_id = ? WHERE id = ?", accepted.jobId, id);
        this.update(id, "processing", "Documents accepted", "queued", 0);
      } catch (e) {
        console.error("breakfast_upload_failed", { jobId: id, detail: (e instanceof Error ? e.message : "Unknown upload error").replaceAll(key, "[REDACTED]").slice(0, 300) });
        if (!submitted) {
          this.update(id, "failed", "Could not prepare existing sites for import. No documents were sent.");
          return json({ error: "Could not prepare existing sites for import", job: this.get(id) }, 500);
        }
        // A received 4xx is a rejected request. A timeout/5xx may have accepted it.
        const rejected = e instanceof BreakfastError && e.status >= 400 && e.status < 500;
        this.update(id, rejected ? "failed" : "uncertain", rejected ? e.message : "Upload confirmation was lost. This upload will not be automatically submitted again.");
        if (rejected) return json({ error: e.message, job: this.get(id) }, e.status, e.retryAfter ? { "retry-after": e.retryAfter } : {});
      } finally { await this.schedule(); }
      return json(this.get(id), 202);
    } catch (e) { return json({ error: e instanceof BreakfastError ? e.message : "Could not start the document import" }, e instanceof BreakfastError ? e.status : 500); }
  }
  async resume(id: string): Promise<ImportJob | null> {
    const job = this.get(id); if (!job?.resumable) return null;
    const transfer = this.needsTransfer(this.row(id)!);
    this.sql.exec("UPDATE breakfast_jobs SET attempts = 0 WHERE id = ?", id);
    this.update(id, transfer ? "processing" : "importing", transfer ? "Resuming result download" : "Resuming saved records", transfer ? "transfer" : "filing");
    await this.schedule(); return this.get(id);
  }
  async alarm(): Promise<void> {
    // Install the next alarm before awaiting D1/network work. A lost response is replay-safe.
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    const row = this.sql.exec<JobRow>(`SELECT * FROM breakfast_jobs WHERE state IN (${ACTIVE}) AND next_poll <= ? ORDER BY next_poll LIMIT 1`, Date.now()).toArray()[0];
    if (!row) { await this.schedule(); return; }
    try {
      if (row.state === "uploading") this.update(row.id, "uncertain", "Upload confirmation was lost. This upload will not be automatically submitted again.");
      else if (row.state === "processing") await this.poll(row);
      else await this.fileBatch(row);
      this.sql.exec("UPDATE breakfast_jobs SET attempts = 0 WHERE id = ?", row.id);
    } catch (e) {
      const attempts = row.attempts + 1;
      this.sql.exec("UPDATE breakfast_jobs SET attempts = ? WHERE id = ?", attempts, row.id);
      const permanent = e instanceof BreakfastError && [401, 403, 404, 413, 422].includes(e.status);
      if (permanent || ((row.state === "importing" || row.phase === "transfer") && attempts >= 6)) this.update(row.id, "failed", permanent ? e.message : "Import paused after repeated errors. Resume to continue from saved progress.", row.phase);
      else {
        const retry = e instanceof BreakfastError ? e.retryAfter : null;
        const hinted = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
        const delay = Math.max(Math.min(60_000, 2000 * 2 ** Math.min(attempts, 5)), Number.isFinite(hinted) ? hinted : 0);
        this.update(row.id, row.state, "Connection interrupted. Progress is saved; retrying shortly.", row.phase, undefined, delay);
      }
      // No raw provider bodies, document values, bearer keys or request headers in logs.
      console.error("breakfast_import_retry", { jobId: row.id, phase: row.phase, attempts, status: e instanceof BreakfastError ? e.status : 0 });
    } finally { await this.schedule(); }
  }
  private async poll(row: JobRow) {
    if (row.phase === "transfer") { await this.receivePage(row); return; }
    const path = `/v1/pipeline/jobs/${encodeURIComponent(row.upstream_id!)}`;
    const status = await breakfast(this.env, path);
    if (status.state === "failed") { this.update(row.id, "failed", typeof status.error === "string" ? status.error.slice(0, 500) : "Document processing failed"); return; }
    if (status.state !== "complete") {
      if (status.state !== "running" && status.state !== "queued") throw new BreakfastError("Invalid document processing status");
      const percent = typeof status.percent === "number" ? Math.max(0, Math.min(100, status.percent)) : row.percent;
      this.update(row.id, "processing", typeof status.message === "string" ? status.message.slice(0, 500) : "Processing documents", typeof status.phase === "string" ? status.phase.slice(0, 60) : "processing", percent);
      return;
    }
    row.phase = "transfer";
    this.update(row.id, "processing", "Receiving processed records", "transfer", 0);
    await this.receivePage(row);
  }
  private async receivePage(row: JobRow) {
    const previous = this.transfer(row.id);
    const path = `/v1/pipeline/jobs/${encodeURIComponent(row.upstream_id!)}/database`;
    let raw;
    try {
      const suffix = previous?.cursor ? `?cursor=${encodeURIComponent(previous.cursor)}` : "";
      try { raw = await breakfast(this.env,path + suffix,{},60_000); }
      catch(e) { if (!(e instanceof BreakfastError) || e.status !== 404) throw e; raw = await breakfast(this.env,path.replace(/\/database$/, "/import") + suffix,{},60_000); }
    }
    catch (e) {
      if (!(e instanceof BreakfastError) || e.status !== 409 || !previous) throw e;
      // Nothing files until every page is staged, so a changed source snapshot
      // can safely restart the download without mixing two versions or reuploading.
      this.ctx.storage.transactionSync(() => {
        const current = this.transfer(row.id);
        if (current?.next_seq !== previous.next_seq || current?.snapshot !== previous.snapshot || current?.complete) return;
        this.sql.exec("DELETE FROM breakfast_items WHERE job_id = ?", row.id);
        this.sql.exec("DELETE FROM breakfast_catalog WHERE job_id = ?", row.id);
        this.sql.exec("DELETE FROM breakfast_transfers WHERE job_id = ?", row.id);
        this.update(row.id, "processing", "Processed records changed; restarting download", "transfer", 0, 1000);
      });
      return;
    }
    let page, plan;
    try {
      page = readTransferPage(raw, row.upstream_id!, previous);
      plan = await planTransferPage(page, row.team_id, row.id, row.timezone, (kind, source) => {
        const item = this.sql.exec<{ mapping: string }>("SELECT mapping FROM breakfast_catalog WHERE job_id = ? AND kind = ? AND source_id = ?", row.id, kind, source).toArray()[0];
        return item ? JSON.parse(item.mapping) : undefined;
      }, importReconciler(this.env,row.team_id));
    } catch (e) { throw new BreakfastError(e instanceof Error ? e.message : "Invalid import page", 422); }
    const chunks = await Promise.all(plan.items.filter(item=>item.kind==="source_chunk").map(item=>readSourceChunk(item.payload)));
    this.ctx.storage.transactionSync(() => {
      const current = this.transfer(row.id);
      if ((current?.next_seq ?? 0) !== page.start || current?.snapshot !== previous?.snapshot) return;
      for(const {chunk,bytes} of chunks)this.pdfs.stage(chunk,bytes);
      for (const item of plan.catalog) this.sql.exec("INSERT INTO breakfast_catalog (job_id,kind,source_id,mapping) VALUES (?,?,?,?) ON CONFLICT(job_id,kind,source_id) DO UPDATE SET mapping=excluded.mapping",
        row.id, item.kind, item.source, JSON.stringify(item.mapping));
      for (const [offset, item] of plan.items.entries()) this.sql.exec("INSERT OR IGNORE INTO breakfast_items (job_id,seq,kind,payload,outcome,error) VALUES (?,?,?,?,?,?)",
        row.id, page.start + offset, item.kind, JSON.stringify(item.kind === "source_chunk" ? {...item.payload,data:undefined} : item.payload), item.kind === "source_chunk" ? "created" : item.kind === "pending" ? "pending" : item.kind === "rejected" ? "rejected" : null, ["pending","rejected"].includes(item.kind) ? String(item.payload.error) : null);
      const end = page.start + page.items.length, done = page.nextCursor === null;
      if (done) {
        const staged = this.sql.exec<{ total: number; records: number }>("SELECT COUNT(*) AS total, COALESCE(SUM(kind IN ('record','rejected','pending')),0) AS records FROM breakfast_items WHERE job_id = ?", row.id).toArray()[0]!;
        if (staged.total !== page.totalItems || staged.records !== page.totalRecords) throw new BreakfastError("Breakfast import record count does not match its manifest", 422);
      }
      this.sql.exec("INSERT INTO breakfast_transfers (job_id,cursor,snapshot,next_seq,total_items,total_records,complete) VALUES (?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET cursor=excluded.cursor,next_seq=excluded.next_seq,complete=excluded.complete",
        row.id, page.nextCursor, page.snapshot, end, page.totalItems, page.totalRecords, done ? 1 : 0);
      this.update(row.id, done ? "importing" : "processing", done ? "Filing records into your vault" : `Receiving processed records (${Math.round(100 * end / Math.max(1, page.totalItems))}%)`, done ? "filing" : "transfer", done ? 0 : Math.round(100 * end / Math.max(1, page.totalItems)), 1000);
    });
  }
  private async fileBatch(row: JobRow) {
    const items = this.sql.exec<{ seq: number; kind: ImportItem["kind"]; payload: string }>("SELECT seq,kind,payload FROM breakfast_items WHERE job_id = ? AND outcome IS NULL ORDER BY seq LIMIT 50", row.id).toArray();
    const records: Array<{seq:number;payload:Record<string,unknown>}> = [];
    for (const item of items) {
      const p = JSON.parse(item.payload) as Record<string, unknown>;
      let outcome = "created", problem: string | null = null;
      if (item.kind === "template") {
        const template = normalizeTemplate(p)!;
        await this.env.DB.prepare("INSERT INTO templates (id,team_id,name,version,doc,updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT(id) DO NOTHING")
          .bind(p.id, row.team_id, template.name, JSON.stringify({ tasks: template.tasks }), now()).run();
      } else if (item.kind === "site") {
        const place = normalizePlace(p.place);
        await this.env.DB.prepare("INSERT INTO sites (id,team_id,client_name,address,place,location_note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
          .bind(p.id, row.team_id, p.clientName, place?.formattedAddress ?? p.locationNote, place ? JSON.stringify(place) : null, p.locationNote, now(), now()).run();
      } else {
        records.push({seq:item.seq,payload:p}); continue;
      }
      this.sql.exec("UPDATE breakfast_items SET outcome = ?, error = ? WHERE job_id = ? AND seq = ?", outcome, problem, row.id, item.seq);
    }
    if (records.length) {
      const batch=await fileImportRecords(this.env,row.team_id,{id:row.user_id,name:row.user_name},records.map(r=>r.payload),this.vault);
      for (const result of batch.results) this.sql.exec("UPDATE breakfast_items SET outcome=?,error=? WHERE job_id=? AND seq=?",
        result.error ? "pending" : result.duplicate ? "duplicate" : "filed",result.error ?? null,row.id,records[result.index]!.seq);
    }
    const left = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM breakfast_items WHERE job_id = ? AND outcome IS NULL", row.id).toArray()[0]!.n;
    const progress = this.get(row.id)!;
    this.update(row.id, left ? "importing" : "complete", left ? "Filing records into your vault" : `${progress.filed} filed, ${progress.duplicates} already present, ${progress.pending ?? 0} awaiting review, ${progress.rejected} rejected`, "filing", left ? Math.round(100 * progress.processed / Math.max(1, progress.total)) : 100, 1000);
  }
}
