/// <reference types="@cloudflare/workers-types" />
// The vault: every report a team's crews have filed, append-only, in the
// team's own Durable Object (SQLite-backed). A report is the record; each
// filled block also becomes one typed fact row, which is what queries run
// over — a labelled block is a series across the whole stack.
import { DurableObject } from "cloudflare:workers";
import { QUERY_LIMITS, type BlockKind, type Filled, type VaultQuery } from "../shared/model";
import type { Env } from "./index";

export type ReportMeta = {
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
};
export type Report = ReportMeta & { doc: Filled };
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
  r.performed_at AS performedAt, r.submitted_at AS submittedAt, r.hash, r.facts`;

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
  const value = s.agg === "count" && !measure.length ? "COUNT(DISTINCT r.id)" : `${s.agg.toUpperCase()}(m.num)`;
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, site_id TEXT NOT NULL, site_name TEXT NOT NULL,
        template_id TEXT NOT NULL, template_name TEXT NOT NULL, template_version INTEGER NOT NULL,
        dispatch_id TEXT NOT NULL, by_user TEXT NOT NULL, by_name TEXT NOT NULL,
        performed_at TEXT NOT NULL, submitted_at TEXT NOT NULL, hash TEXT NOT NULL, facts INTEGER NOT NULL,
        doc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reports_site ON reports(site_id, performed_at);
      CREATE INDEX IF NOT EXISTS reports_template ON reports(template_id, performed_at);
      CREATE INDEX IF NOT EXISTS reports_when ON reports(performed_at);
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
  }

  /** Append a report and its facts, all or nothing. */
  add(meta: Omit<ReportMeta, "facts">, doc: Filled): ReportMeta {
    const facts = factsOf(doc);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO reports (id, site_id, site_name, template_id, template_name, template_version, dispatch_id, by_user, by_name,
                              performed_at, submitted_at, hash, facts, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        meta.id, meta.siteId, meta.siteName, meta.templateId, meta.templateName, meta.templateVersion, meta.dispatchId,
        meta.byUser, meta.byName, meta.performedAt, meta.submittedAt, meta.hash, facts.length, JSON.stringify(doc)
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
    return this.sql.exec<ReportMeta>(sql, ...params).toArray();
  }

  get(id: string): Report | null {
    const row = this.sql.exec<ReportMeta & { doc: string }>(`SELECT ${META}, r.doc FROM reports r WHERE r.id = ?`, id).toArray()[0];
    return row ? { ...row, doc: JSON.parse(row.doc) as Filled } : null;
  }

  query(q: VaultQuery): { rows: ReportMeta[] } | { groups: { key: string; name: string; value: number | null; n: number }[] } {
    const { sql, params } = compile(q);
    if ("rows" in q.select) return { rows: this.sql.exec<ReportMeta>(sql, ...params).toArray() };
    return { groups: this.sql.exec<{ key: string; name: string; value: number | null; n: number }>(sql, ...params).toArray() };
  }
}

export const vaultFor = (env: Env, teamId: string) => env.VAULT.get(env.VAULT.idFromName(teamId));
