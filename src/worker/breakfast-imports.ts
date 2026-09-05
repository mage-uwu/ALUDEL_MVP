import { IMPORT_MAX_BYTES, type ImportJob } from "../shared/breakfast";
import { normalizePlace, normalizeTemplate } from "../shared/model";
import { breakfast, BreakfastError, limitStream, uploadHeaders } from "./breakfast-api";
import { planGraph, type ImportItem } from "./graph-import";
import { fileImportRecords, type ImportVault } from "./import-records";
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
  constructor(private ctx: DurableObjectState, private env: Env, private vault: ImportVault) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS breakfast_jobs (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL, user_id TEXT NOT NULL, user_name TEXT NOT NULL,
      name TEXT NOT NULL, timezone TEXT NOT NULL, upstream_id TEXT, state TEXT NOT NULL,
      phase TEXT NOT NULL, percent REAL NOT NULL DEFAULT 0, message TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_poll INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS breakfast_items (
      job_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
      outcome TEXT, error TEXT, PRIMARY KEY(job_id, seq)
    ); CREATE INDEX IF NOT EXISTS breakfast_pending ON breakfast_items(job_id, outcome, seq);`);
  }
  private row(id: string) { return this.sql.exec<JobRow>("SELECT * FROM breakfast_jobs WHERE id = ?", id).toArray()[0]; }
  private view(row: JobRow): ImportJob {
    const c = this.sql.exec<{ total: number; filed: number; duplicates: number; rejected: number; processed: number }>(`SELECT
      COUNT(*) AS total, COALESCE(SUM(outcome = 'filed'),0) AS filed, COALESCE(SUM(outcome = 'duplicate'),0) AS duplicates,
      COALESCE(SUM(outcome = 'rejected'),0) AS rejected, COUNT(outcome) AS processed
      FROM breakfast_items WHERE job_id = ? AND kind IN ('record','rejected')`, row.id).toArray()[0]!;
    return { id: row.id, name: row.name, state: row.state, phase: row.phase, percent: row.percent, message: row.message,
      createdAt: row.created_at, updatedAt: row.updated_at, ...c,
      resumable: row.state === "failed" && Boolean(row.upstream_id) && this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM breakfast_items WHERE job_id = ? AND outcome IS NULL", row.id).toArray()[0]!.n > 0 };
  }
  list(): ImportJob[] { return this.sql.exec<JobRow>("SELECT * FROM breakfast_jobs ORDER BY created_at DESC LIMIT 30").toArray().map(r => this.view(r)); }
  get(id: string): ImportJob | null {
    const row = this.row(id); if (!row) return null;
    return { ...this.view(row), errors: this.sql.exec<{ record: string; error: string }>(`SELECT
      COALESCE(json_extract(payload, '$.record'), json_extract(payload, '$.origin.externalId'), 'Record') AS record, error
      FROM breakfast_items WHERE job_id = ? AND error IS NOT NULL ORDER BY seq LIMIT 50`, id).toArray() };
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
      if (!this.env.BFAST_API_KEY) return json({ error: "Document import is not configured. Ask an administrator to connect it." }, 503);
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
      try {
        const query = new URLSearchParams({ timezone, geocode: "true", semanticReview: "true", transmute: "false" });
        const accepted = await breakfast(this.env, `/v1/pipeline/jobs?${query}`, { method: "POST", headers, body: limitStream(req.body!, IMPORT_MAX_BYTES) }, 120_000);
        if (typeof accepted.jobId !== "string" || !/^job-[A-Za-z0-9_-]+$/.test(accepted.jobId)) throw new Error("Missing upstream job ID");
        this.sql.exec("UPDATE breakfast_jobs SET upstream_id = ? WHERE id = ?", accepted.jobId, id);
        this.update(id, "processing", "Documents accepted", "queued", 0);
      } catch (e) {
        console.error("breakfast_upload_failed", { jobId: id, detail: (e instanceof Error ? e.message : "Unknown upload error").replaceAll(this.env.BFAST_API_KEY, "[REDACTED]").slice(0, 300) });
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
    this.sql.exec("UPDATE breakfast_jobs SET attempts = 0 WHERE id = ?", id);
    this.update(id, "importing", "Resuming saved records", "filing"); await this.schedule(); return this.get(id);
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
      if (permanent || (row.state === "importing" && attempts >= 6)) this.update(row.id, "failed", permanent ? e.message : "Filing paused after repeated errors. Resume to continue from the saved records.");
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
    const path = `/v1/pipeline/jobs/${encodeURIComponent(row.upstream_id!)}`;
    const status = await breakfast(this.env, path);
    if (status.state === "failed") { this.update(row.id, "failed", typeof status.error === "string" ? status.error.slice(0, 500) : "Document processing failed"); return; }
    if (status.state !== "complete") {
      if (status.state !== "running" && status.state !== "queued") throw new BreakfastError("Invalid document processing status");
      const percent = typeof status.percent === "number" ? Math.max(0, Math.min(100, status.percent)) : row.percent;
      this.update(row.id, "processing", typeof status.message === "string" ? status.message.slice(0, 500) : "Processing documents", typeof status.phase === "string" ? status.phase.slice(0, 60) : "processing", percent);
      return;
    }
    const graph = await breakfast(this.env, `${path}/graph`, {}, 60_000);
    let plan: ImportItem[];
    try { plan = await planGraph(graph, row.team_id, row.id, row.timezone); }
    catch (e) { throw new BreakfastError(e instanceof Error ? e.message : "Invalid import graph", 422); }
    this.ctx.storage.transactionSync(() => {
      for (const [seq, item] of plan.entries()) this.sql.exec("INSERT OR IGNORE INTO breakfast_items (job_id,seq,kind,payload,outcome,error) VALUES (?,?,?,?,?,?)",
        row.id, seq, item.kind, JSON.stringify(item.payload), item.kind === "rejected" ? "rejected" : null, item.kind === "rejected" ? String(item.payload.error) : null);
      this.update(row.id, "importing", "Filing records into your vault", "filing", 0);
    });
  }
  private async fileBatch(row: JobRow) {
    const items = this.sql.exec<{ seq: number; kind: ImportItem["kind"]; payload: string }>("SELECT seq,kind,payload FROM breakfast_items WHERE job_id = ? AND outcome IS NULL ORDER BY seq LIMIT 10", row.id).toArray();
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
          .bind(p.id, row.team_id, p.clientName, place?.formattedAddress ?? "", place ? JSON.stringify(place) : null, p.locationNote, now(), now()).run();
      } else {
        const result = (await fileImportRecords(this.env, row.team_id, { id: row.user_id, name: row.user_name }, [p], this.vault)).results[0]!;
        outcome = result.error ? "rejected" : result.duplicate ? "duplicate" : "filed"; problem = result.error ?? null;
      }
      this.sql.exec("UPDATE breakfast_items SET outcome = ?, error = ? WHERE job_id = ? AND seq = ?", outcome, problem, row.id, item.seq);
    }
    const left = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM breakfast_items WHERE job_id = ? AND outcome IS NULL", row.id).toArray()[0]!.n;
    const progress = this.get(row.id)!;
    this.update(row.id, left ? "importing" : "complete", left ? "Filing records into your vault" : `${progress.filed} filed, ${progress.duplicates} already present, ${progress.rejected} rejected`, "filing", left ? Math.round(100 * progress.processed / Math.max(1, progress.total)) : 100, 1000);
  }
}
