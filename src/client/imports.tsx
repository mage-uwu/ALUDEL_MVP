import { useEffect, useRef, useState } from "react";
import { IMPORT_EXTENSIONS, IMPORT_MAX_BYTES, type ImportJob } from "../shared/breakfast";

/** Requests stay on ALUDEL's origin; no Breakfast key or review token enters the browser. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, signal: AbortSignal.timeout(init.method === "POST" ? 150_000 : 20_000) });
  const value = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    throw new Error((value?.error || `Request failed (${response.status})`) + (retry ? ` Retry after ${retry} seconds.` : ""));
  }
  return value as T;
}

export function Imports({ teamId, head }: { teamId: string; head: React.ReactNode }) {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState("");
  const [details, setDetails] = useState<ImportJob | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const base = `/api/teams/${teamId}/breakfast/jobs`;
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    alive.current = true;
    const poll = async () => {
      let delay = 2500;
      try {
        const response = await request<{ configured: boolean; jobs: ImportJob[] }>(base);
        if (stopped) return;
        setJobs(response.jobs); setConfigured(response.configured); setConnection("");
        delay = document.hidden ? 15_000 : response.jobs.some(j => ["uploading", "processing", "importing"].includes(j.state)) ? 2500 : 10_000;
      } catch (e) { if (!stopped) setConnection(`Could not refresh progress. ${(e as Error).message}`); delay = 10_000; }
      if (!stopped) timer = setTimeout(poll, delay);
    };
    void poll();
    return () => { stopped = true; alive.current = false; clearTimeout(timer); };
  }, [base]);

  async function upload() {
    if (busy || !files.length) return;
    if (files.some(f => !IMPORT_EXTENSIONS.test(f.name))) { setError("Choose ZIP, CSV, TSV, JSON, JSONL, text or Markdown files. Extract PDFs and scanned documents first."); return; }
    // Reserve room for multipart headers as well as file bytes.
    if (files.reduce((n, f) => n + f.size + 1024, 1024) > IMPORT_MAX_BYTES) { setError("These files exceed the 64 MiB upload limit. Split them into smaller uploads."); return; }
    setError(""); setBusy(true);
    const body = new FormData(); for (const file of files) body.append("files", file, file.name);
    const query = new URLSearchParams({ timezone, name: files.length === 1 ? files[0]!.name : `${files[0]!.name} + ${files.length - 1} files` });
    try {
      const job = await request<ImportJob>(`${base}?${query}`, { method: "POST", headers: { "x-import-id": crypto.randomUUID() }, body });
      if (!alive.current) return;
      setJobs(previous => [job, ...previous.filter(j => j.id !== job.id)]);
      if (job.state === "uncertain") setError(job.message);
    } catch (e) {
      if (alive.current) setError(`${(e as Error).message} Check recent imports before submitting again.`);
    } finally {
      if (alive.current) { setBusy(false); setFiles([]); if (input.current) input.current.value = ""; }
    }
  }
  async function inspect(job: ImportJob) {
    try { const result = await request<ImportJob>(`${base}/${job.id}`); if (alive.current) setDetails(result); }
    catch (e) { if (alive.current) setError((e as Error).message); }
  }
  async function resume(job: ImportJob) {
    try {
      const updated = await request<ImportJob>(`${base}/${job.id}/resume`, { method: "POST" });
      if (alive.current) setJobs(previous => previous.map(j => j.id === updated.id ? updated : j));
    } catch (e) { if (alive.current) setError((e as Error).message); }
  }
  return <div className="shell">
    {head}
    <section className="card glass-frosted import-panel">
      <h2>Import documents</h2>
      <p className="muted">Turn old paperwork into templates, sites and filed reports for this team.</p>
      {configured === false ? <p role="status">Document import isn’t connected yet. Ask an administrator to finish setup.</p> : <>
        <label className="import-label">Documents
          <input ref={input} type="file" multiple accept=".zip,.csv,.tsv,.json,.jsonl,.ndjson,.txt,.text,.md,.markdown" disabled={busy || configured === null} onChange={e => setFiles(Array.from(e.target.files ?? []))} />
        </label>
        <p className="template-meta">ZIP, CSV, TSV, JSON, text or Markdown · up to 64 MiB. Extract PDFs and scans first.</p>
        <label className="import-label">Paperwork timezone
          <input value={timezone} onChange={e => setTimezone(e.target.value)} disabled={busy} placeholder="America/New_York" />
        </label>
        <button className="big-btn primary" onClick={upload} disabled={busy || !files.length || !configured}>{busy ? "Sending documents…" : "Import documents"}</button>
        <p className="template-meta">After upload, processing and filing continue even if you leave this page.</p>
      </>}
    </section>
    {error && <p className="error" role="alert">{error}</p>}
    {connection && <p className="muted" role="status">{connection}</p>}
    <p className="section-label">Recent imports</p>
    {configured === null && !connection && <p className="muted">Loading…</p>}
    {configured !== null && jobs.length === 0 && <p className="muted">Your imported documents will appear here.</p>}
    {jobs.map(job => <section key={job.id} className="card glass-frosted import-panel">
      <div className="import-title"><strong>{job.name}</strong><span className="template-meta">{job.state}</span></div>
      <p className="template-meta">{new Date(job.createdAt).toLocaleString()}</p>
      {["processing", "importing"].includes(job.state) && <progress aria-label={job.state === "importing" ? "Filing records" : "Processing documents"} max={100} value={job.percent} />}
      <p role="status">{job.message}</p>
      {job.total > 0 && <p className="template-meta">{job.processed}/{job.total} records · {job.filed} filed · {job.duplicates} already present · {job.rejected} rejected</p>}
      {job.rejected > 0 && <button className="big-btn" onClick={() => inspect(job)}>View rejected records</button>}
      {job.resumable && <button className="big-btn" onClick={() => resume(job)}>Resume import</button>}
    </section>)}
    {details && <section className="card glass-frosted import-panel" aria-label="Rejected records">
      <div className="import-title"><strong>Rejected records</strong><button onClick={() => setDetails(null)} aria-label="Close rejected records">Close</button></div>
      <p className="template-meta">Showing up to 50 records. Correct these in the source and upload again; previously filed records will be recognized.</p>
      {details.errors?.map((e, i) => <p key={i}><strong>{e.record}</strong><br />{e.error}</p>)}
    </section>}
  </div>;
}
