/// <reference types="@cloudflare/workers-types" />
// The vault: every report a team's crews have filed, append-only, in the
// team's own Durable Object (SQLite-backed). A report is the record; each
// filled block also becomes one typed fact row, which is what queries run
// over — a labelled block is a series across the whole stack.
import { DurableObject } from "cloudflare:workers";
import { QUERY_LIMITS, type BlockKind, type Filled, type Origin, type VaultQuery } from "../shared/model";
import type { Env } from "./index";
import type { BreakfastSemantics } from "../shared/breakfast";
import { BreakfastImports } from "./breakfast-imports";
import type { VaultCatalog, VaultPage } from "../shared/vault";
import { vaultCursor, vaultWhere, type VaultBrowse } from "./vault-browse";

export type ReportMeta = {
  semantics?: BreakfastSemantics | null;
  id: string;
  siteId: string;
  siteName: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  dispatchId: string;
  byUser: string;
  byName: string;
  performedAt: string;
  submittedAt: string;
  hash: string;
  facts: number;
  /** Null for a report filed in the field; the source document for an import. */
  origin: Origin | null;
};
export type Report = ReportMeta & { doc: Filled };
type Row = Omit<ReportMeta, "origin" | "semantics"> & { origin: string | null; semantics?: string | null };
const withOrigin = (r: Row): ReportMeta => ({ ...r, semantics: r.semantics ? JSON.parse(r.semantics) : null, origin: r.origin ? (JSON.parse(r.origin) as Origin) : null });
export type Fact = {
  seq: number;
  taskId: string;
  taskName: string;
  blockId: string;
  label: string;
  kind: BlockKind;
  unit: string;
  num: number | null;
  text: string | null;
};

/** One fact per filled block: numbers in num, text and the pressed key in text. */
export function factsOf(doc: Filled): Fact[] {
  const out: Fact[] = [];
  for (const task of doc.tasks)
    for (const b of task.blocks)
      out.push({
        seq: out.length,
        taskId: task.id,
        taskName: task.name,
        blockId: b.id,
        label: b.label,
        kind: b.kind,
        unit: b.unit,
        num: typeof b.value === "number" ? b.value : null,
        text: typeof b.value === "string" ? b.value : null,
      });
  return out;
}

const META = `r.id, r.site_id AS siteId, r.site_name AS siteName, r.template_id AS templateId, r.template_name AS templateName,
  r.template_version AS templateVersion, r.dispatch_id AS dispatchId, r.by_user AS byUser, r.by_name AS byName,
  r.performed_at AS performedAt, r.submitted_at AS submittedAt, r.hash, r.facts, r.origin, r.semantics`;

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * A query as parameterised SQL. Report-level filters narrow the stack; each
 * where clause must be met by some fact of the report; the select either
 * returns reports or aggregates one measure over their facts.
 */
export function compile(q: VaultQuery): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = [];
  const conds: string[] = ["1 = 1"];
  if (q.template) (conds.push("r.template_id = ?"), params.push(q.template));
  if (q.site) (conds.push("r.site_id = ?"), params.push(q.site));
  if (q.from) (conds.push("r.performed_at >= ?"), params.push(q.from));
  if (q.to) (conds.push("r.performed_at < ?"), params.push(q.to));
  const factConds = (c: { atom?: { template: string; block: string }; label?: string; kind?: string }, alias: string) => {
    const out: string[] = [];
    if (c.atom) (out.push(`${alias}.template_id = ? AND ${alias}.block_id = ?`), params.push(c.atom.template, c.atom.block));
    if (c.label) (out.push(`${alias}.label LIKE ? ESCAPE '\\'`), params.push(like(c.label)));
    if (c.kind) (out.push(`${alias}.kind = ?`), params.push(c.kind));
    return out;
  };
  for (const c of q.where) {
    const inner = factConds(c, "f");
    for (const [op, sym] of [["eq", "="], ["lt", "<"], ["lte", "<="], ["gt", ">"], ["gte", ">="]] as const) {
      const v = c.num?.[op];
      if (v !== undefined) (inner.push(`f.num ${sym} ?`), params.push(v));
    }
    if (c.text?.eq) (inner.push("f.text = ?"), params.push(c.text.eq));
    if (c.text?.contains) (inner.push("f.text LIKE ? ESCAPE '\\'"), params.push(like(c.text.contains)));
    conds.push(`EXISTS (SELECT 1 FROM facts f WHERE f.report_id = r.id${inner.map((x) => ` AND ${x}`).join("")})`);
  }
  const where = conds.join(" AND ");
  if ("rows" in q.select) {
    params.push(q.select.limit ?? 50);
    return { sql: `SELECT ${META} FROM reports r WHERE ${where} ORDER BY r.performed_at DESC LIMIT ?`, params };
  }
  const s = q.select;
  const measure = factConds(s, "m");
  const key =
    s.groupBy === "site" ? "r.site_id AS key, r.site_name AS name"
    : s.groupBy === "template" ? "r.template_id AS key, r.template_name AS name"
    : s.groupBy === "month" ? "substr(r.performed_at, 1, 7) AS key, substr(r.performed_at, 1, 7) AS name"
    : "'all' AS key, 'all' AS name";
  // count is of reports, or of the measured facts when there is a measure; the rest measure numbers
  const value = s.agg === "count" ? (measure.length ? "COUNT(*)" : "COUNT(DISTINCT r.id)") : `${s.agg.toUpperCase()}(m.num)`;
  const from = measure.length || s.agg !== "count" ? `facts m JOIN reports r ON r.id = m.report_id` : `reports r`;
  const mconds = measure.length ? ` AND ${measure.join(" AND ")}` : s.agg !== "count" ? " AND m.num IS NOT NULL" : "";
  params.push(QUERY_LIMITS.groups);
  return {
    sql: `SELECT ${key}, ${value} AS value, COUNT(*) AS n FROM ${from} WHERE ${where}${mconds} GROUP BY key ORDER BY key LIMIT ?`,
    params,
  };
}

/** One team's stack of reports. */
export class Vault extends DurableObject<Env> {
  private sql: SqlStorage;
  private imports: BreakfastImports;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.imports = new BreakfastImports(ctx, env, this);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, site_id TEXT NOT NULL, site_name TEXT NOT NULL,
        template_id TEXT NOT NULL, template_name TEXT NOT NULL, template_version INTEGER NOT NULL,
        dispatch_id TEXT NOT NULL, by_user TEXT NOT NULL, by_name TEXT NOT NULL,
        performed_at TEXT NOT NULL, submitted_at TEXT NOT NULL, hash TEXT NOT NULL, facts INTEGER NOT NULL,
        doc TEXT NOT NULL, origin TEXT, origin_key TEXT
      );
      CREATE INDEX IF NOT EXISTS reports_site ON reports(site_id, performed_at);
      CREATE INDEX IF NOT EXISTS reports_template ON reports(template_id, performed_at);
      CREATE INDEX IF NOT EXISTS reports_when ON reports(performed_at);
      CREATE INDEX IF NOT EXISTS reports_browse ON reports(performed_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS reports_stack ON reports(site_id, template_id, performed_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS facts (
        report_id TEXT NOT NULL, seq INTEGER NOT NULL, site_id TEXT NOT NULL, template_id TEXT NOT NULL,
        task_id TEXT NOT NULL, task_name TEXT NOT NULL, block_id TEXT NOT NULL, label TEXT NOT NULL,
        kind TEXT NOT NULL, unit TEXT NOT NULL, num REAL, text TEXT, performed_at TEXT NOT NULL,
        PRIMARY KEY (report_id, seq)
      );
      CREATE INDEX IF NOT EXISTS facts_atom ON facts(template_id, block_id, performed_at);
      CREATE INDEX IF NOT EXISTS facts_atom_num ON facts(template_id, block_id, num);
      CREATE INDEX IF NOT EXISTS facts_label ON facts(label, kind, performed_at);
      CREATE INDEX IF NOT EXISTS facts_site ON facts(site_id, performed_at);
    `);
    // vaults made before provenance existed still need the columns
    for (const sql of ["ALTER TABLE reports ADD COLUMN semantics TEXT", "ALTER TABLE reports ADD COLUMN origin TEXT", "ALTER TABLE reports ADD COLUMN origin_key TEXT"]) {
      try {
        this.sql.exec(sql);
      } catch {
        /* already there */
      }
    }
    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS reports_origin ON reports(origin_key)");
  }

  // Only the authenticated Worker can reach this object; its namespace is per team.
  fetch(req: Request): Promise<Response> { return this.imports.start(req); }
  alarm(): Promise<void> { return this.imports.alarm(); }
  importJobs() { return this.imports.list(); }
  importJob(id: string) { return this.imports.get(id); }
  resumeImport(id: string) { return this.imports.resume(id); }
  pendingImports(id: string, after: number) { return this.imports.pending(id,after); }
  pendingImport(id: string, seq: number): string | null { const doc=this.imports.pendingDocument(id,seq); return doc ? JSON.stringify(doc) : null; }
  resolvePendingImport(id: string, seq: number, siteId: string, date?: string) { return this.imports.resolvePending(id,seq,siteId,date); }

  /** No await between the duplicate lookup and insert: atomic in one DO turn. */
  addImported(meta: Omit<ReportMeta, "facts">, doc: Filled, key: string | null): { id: string; duplicate?: true } {
    const seen = key ? this.byOrigin(key) : null;
    if (seen) return { id: seen, duplicate: true };
    return { id: this.add(meta, doc, key).id };
  }

  /** The report already filed from this document, if any. */
  byOrigin(key: string): string | null {
    return this.sql.exec<{ id: string }>("SELECT id FROM reports WHERE origin_key = ?", key).toArray()[0]?.id ?? null;
  }

  /** Append a report and its facts, all or nothing. */
  add(meta: Omit<ReportMeta, "facts">, doc: Filled, originKey: string | null = null): ReportMeta {
    const facts = factsOf(doc);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO reports (id, site_id, site_name, template_id, template_name, template_version, dispatch_id, by_user, by_name,
                              performed_at, submitted_at, hash, facts, doc, origin, origin_key, semantics)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        meta.id, meta.siteId, meta.siteName, meta.templateId, meta.templateName, meta.templateVersion, meta.dispatchId,
        meta.byUser, meta.byName, meta.performedAt, meta.submittedAt, meta.hash, facts.length, JSON.stringify(doc),
        meta.origin ? JSON.stringify(meta.origin) : null, originKey, meta.semantics ? JSON.stringify(meta.semantics) : null
      );
      for (const f of facts)
        this.sql.exec(
          `INSERT INTO facts (report_id, seq, site_id, template_id, task_id, task_name, block_id, label, kind, unit, num, text, performed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          meta.id, f.seq, meta.siteId, meta.templateId, f.taskId, f.taskName, f.blockId, f.label, f.kind, f.unit, f.num, f.text, meta.performedAt
        );
    });
    return { ...meta, facts: facts.length };
  }

  list(filter: { site?: string; template?: string; limit: number }): ReportMeta[] {
    const q: VaultQuery = { where: [], select: { rows: true, limit: filter.limit } };
    if (filter.site) q.site = filter.site;
    if (filter.template) q.template = filter.template;
    const { sql, params } = compile(q);
    return this.sql.exec<Row>(sql, ...params).toArray().map(withOrigin);
  }

  /** Options come from saved submissions, including deleted live objects. */
  catalog(): VaultCatalog {
    const options = (column: "template" | "site") => this.sql.exec<{ id: string; name: string; reports: number }>(`
      SELECT r.${column}_id AS id, COUNT(*) AS reports,
        (SELECT s.${column}_name FROM reports s WHERE s.${column}_id = r.${column}_id
         ORDER BY s.submitted_at DESC, s.id DESC LIMIT 1) AS name
      FROM reports r GROUP BY r.${column}_id ORDER BY name COLLATE NOCASE, id
    `).toArray();
    return { templates: options("template"), sites: options("site") };
  }

  browse(q: VaultBrowse): VaultPage<ReportMeta> {
    const all = vaultWhere(q), page = vaultWhere(q, true);
    const total = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM reports r WHERE ${all.sql}`, ...all.params).toArray()[0]!.n;
    const rows = this.sql.exec<Row>(`SELECT ${META} FROM reports r WHERE ${page.sql}
      ORDER BY r.performed_at DESC, r.id DESC LIMIT ?`, ...page.params, q.limit + 1).toArray();
    const reports = rows.slice(0, q.limit).map(withOrigin);
    return { reports, total, nextCursor: rows.length > q.limit ? vaultCursor(q, reports.at(-1)!) : null };
  }

  get(id: string): Report | null {
    const row = this.sql.exec<Row & { doc: string }>(`SELECT ${META}, r.doc FROM reports r WHERE r.id = ?`, id).toArray()[0];
    return row ? { ...withOrigin(row), doc: JSON.parse(row.doc) as Filled } : null;
  }

  query(q: VaultQuery): { rows: ReportMeta[] } | { groups: { key: string; name: string; value: number | null; n: number }[] } {
    const { sql, params } = compile(q);
    if ("rows" in q.select) return { rows: this.sql.exec<Row>(sql, ...params).toArray().map(withOrigin) };
    return { groups: this.sql.exec<{ key: string; name: string; value: number | null; n: number }>(sql, ...params).toArray() };
  }
}

export const vaultFor = (env: Env, teamId: string) => env.VAULT.get(env.VAULT.idFromName(teamId));
