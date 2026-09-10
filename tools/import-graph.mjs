#!/usr/bin/env node
// Files a sidecar graph export into a team's vault through the import gate.
//
//   node tools/import-graph.mjs graph.json --team <id> --token aludel_… [--base https://…]
//                               [--map map.json] [--tz America/New_York] [--dry] [--keep-constants] [--form-labels]
//
// The graph is the sidecar's own shape: record → fact → block → template, plus
// site and employee. Only that spine is read; classifier nodes are ignored. A
// templates, blocks, and sites must already be mapped to objects prepared by a
// team member. The import credential cannot create or inspect ordinary team data.
// Identity is the record's externalId, so a rerun never files twice.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1] ?? fallback;
};
const has = (name) => args.includes(`--${name}`);
const VALUE_FLAGS = new Set(["base", "team", "token", "map", "tz"]);
const formLabels = has("form-labels");
const graphPath = args.find((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(args[i - 1].replace(/^--/, ""))));
const base = (flag("base", "http://localhost:8787") ?? "").replace(/\/$/, "");
const team = flag("team");
const token = flag("token", process.env.ALUDEL_TOKEN);
const mapPath = flag("map", "aludel-map.json");
const dry = has("dry");
const keepConstants = has("keep-constants");
if (!graphPath || !team || (!token && !dry)) {
  console.error("usage: import-graph.mjs graph.json --team <id> --token aludel_… [--base url] [--map file] [--tz zone] [--dry]");
  process.exit(2);
}

// ——— the graph, indexed ———
const g = JSON.parse(readFileSync(graphPath, "utf8"));
const tz = flag("tz", g.timezone ?? "America/New_York");
const node = new Map(g.nodes.map((n) => [n.id, n]));
const out = new Map(); // source id → edges by kind
for (const e of g.edges) {
  if (!out.has(e.source)) out.set(e.source, new Map());
  const byKind = out.get(e.source);
  if (!byKind.has(e.kind)) byKind.set(e.kind, []);
  byKind.get(e.kind).push(e);
}
const targets = (id, kind) => (out.get(id)?.get(kind) ?? []).map((e) => node.get(e.target)).filter(Boolean);
const first = (id, kind) => targets(id, kind)[0] ?? null;

const records = g.nodes.filter((n) => n.kind === "record");
const props = (n) => n?.properties ?? {};
const resolved = new Map(records.map(rec => {
  const s = props(rec).semantics;
  if (s !== undefined && (!s || s.schemaVersion !== 1)) throw new Error("Unsupported Breakfast semantics contract");
  return [rec.id, s];
}));

// facts of a record, keyed by labelId and by block id
const factsOf = (rec) => targets(rec.id, "has_fact");
const blockOf = (fact) => first(fact.id, "uses_block");
const byLabel = (rec, labelId) => factsOf(rec).find((f) => props(f).labelId === labelId) ?? null;

// ——— block kinds: declared by the export, else inferred from every value the corpus filed under the block ———
const DECLARED = { number: "number", identifier: "text", choice: "buttons", text: "text", image: "photo", date: "text", time: "text", constant: "chrome" };
const IMAGE = /\.(jpe?g|png|gif|heic|webp)$/i;
const clean = (v) => (typeof v === "string" ? v.replace(/^[•\s]+/, "").trim() : v);
const usage = new Map(); // block id → { values: [], records: Set }
for (const rec of records)
  for (const f of factsOf(rec)) {
    const b = blockOf(f);
    if (!b) continue;
    if (!usage.has(b.id)) usage.set(b.id, { values: [], records: new Set() });
    const u = usage.get(b.id);
    u.values.push(clean(props(f).value));
    u.records.add(rec.id);
  }
const kindOf = (block) => {
  const declared = DECLARED[props(block).valueKind];
  if (declared === "buttons") {
    // a choice block's keys, most frequent first; a key too long for a button leaves the block as text
    const options = (props(block).choiceOptions ?? []).map((k) => String(clean(k))).filter(Boolean).slice(0, 6);
    return options.length && options.every((k) => k.length <= 24) ? { kind: "buttons", options } : { kind: "text" };
  }
  if (declared) return { kind: declared };
  const u = usage.get(block.id) ?? { values: [], records: new Set() };
  const vals = u.values.filter((v) => v !== "" && v !== null && v !== undefined);
  if (!vals.length) return { kind: "text" };
  if (vals.every((v) => typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)))) return { kind: "number" };
  if (vals.every((v) => typeof v === "string" && IMAGE.test(v))) return { kind: "photo" };
  const distinct = [...new Set(vals.map(String))];
  // the same paragraph on every record is the form's own text, not a finding
  if (distinct.length === 1 && u.records.size >= 3 && distinct[0].length > 40) return { kind: "chrome" };
  if (distinct.length >= 2 && distinct.length <= 6 && distinct.every((v) => v.length <= 24)) return { kind: "buttons", options: distinct };
  return { kind: "text" };
};

// ——— the map: graph ids → Aludel ids, kept across runs ———
let map = { templates: {}, sites: {} };
try {
  map = { ...map, ...JSON.parse(readFileSync(mapPath, "utf8")) };
} catch {
  /* first run */
}

const api = async (path, init = {}) => {
  const res = await fetch(`${base}/api/teams/${team}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${body?.error ?? ""}`.trim());
  return body;
};

// ——— templates ———
const mostCommon = (xs) => {
  const n = new Map();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};
const templates = g.nodes.filter((n) => n.kind === "template");
for (const [i, t] of templates.entries()) {
  const blocks = targets(t.id, "defines_block");
  const mine = records.filter((r) => first(r.id, "instance_of")?.id === t.id);
  const name = (mostCommon(mine.map((r) => props(byLabel(r, "form_name")).value).filter(Boolean)) ?? `Imported template ${i + 1}`).slice(0, 80);
  // the concept's name lines a series up across forms; --form-labels keeps each form's own wording
  const labelOf = (b) => ((formLabels ? props(b).displayName : props(b).conceptDisplayName || props(b).displayName) || props(b).labelId || "Field").slice(0, 60);
  const plan = blocks.map((b) => ({ graphId: b.id, label: labelOf(b), ...kindOf(b) }));
  const chrome = plan.filter((b) => b.kind === "chrome" && !keepConstants);
  const kept = plan.filter((b) => !chrome.includes(b)).map((b) => (b.kind === "chrome" ? { ...b, kind: "text" } : b));
  console.log(`template ${t.id} → "${name}": ${kept.length} blocks (${mine.length} records)${chrome.length ? `, ${chrome.length} constant paragraphs left on the form` : ""}`);
  for (const b of kept) console.log(`  ${b.kind.padEnd(7)} ${b.label}${b.options ? ` [${b.options.join(" | ")}]` : ""}`);
  for (const b of chrome) console.log(`  chrome  ${b.label}`);

  const known = map.templates[t.id];
  if (known) {
    const missing = kept.filter((b) => !known.blocks[b.graphId]);
    if (missing.length) console.log(`  ! ${missing.length} blocks not in the map from the last run; they will be dropped: ${missing.map((b) => b.label).join(", ")}`);
    continue;
  }
  if (dry) continue;
  throw new Error(`Template ${t.id} is not mapped; create it in ALUDEL and add its template and block IDs to ${mapPath}`);
}

// ——— sites ———
const nameOf = (rec) => {
  if (resolved.has(rec.id) && resolved.get(rec.id)) return resolved.get(rec.id).client.name || "";
  const v = (label) => clean(props(byLabel(rec, label)).value) || "";
  const person = [v("account_name_first") || v("customer_name_first"), v("account_name_last") || v("customer_name_last")].filter(Boolean).join(" ");
  return person;
};
for (const s of g.nodes.filter((n) => n.kind === "site")) {
  if (map.sites[s.id]) continue;
  const mine = records.filter((r) => first(r.id, "at_site")?.id === s.id);
  const address = (props(s).address ?? "").trim();
  const clientName = (mostCommon(mine.map(nameOf).filter(Boolean)) || address || "Imported site").slice(0, 80);
  console.log(`site ${s.id} → "${clientName}" · ${address || "no address"} (${mine.length} records)`);
  if (dry) continue;
  throw new Error(`Site ${s.id} is not mapped; create it in ALUDEL and add its ID to ${mapPath}`);
}

// ——— when the work was done: the form's date and time, in the shop's zone ———
const toUtc = (y, m, d, hh, mm) => {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(guess));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess - (local - guess)).toISOString();
};
const clock = (s) => {
  const m = /^(\d{1,2}):(\d{2})\s*([AP]M)?$/i.exec(s ?? "");
  if (!m) return null;
  let h = +m[1] % 12;
  if (/pm/i.test(m[3] ?? "")) h += 12;
  return [h, +m[2]];
};
const performedAt = (rec) => {
  if (resolved.get(rec.id)) return resolved.get(rec.id).date?.value || null;
  const date = clean(props(byLabel(rec, "date_of_service")).value);
  const time = clean(props(byLabel(rec, "time_of_service") ?? byLabel(rec, "start_time")).value);
  const submitted = clean(props(byLabel(rec, "submitted_on")).value);
  const us = /^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(.+))?$/;
  let m = us.exec(date ?? "");
  if (m) {
    const [h, mi] = clock(time) ?? clock(m[4]) ?? [12, 0];
    return toUtc(+m[3], +m[1], +m[2], h, mi);
  }
  m = us.exec(submitted ?? "");
  if (m) {
    const [h, mi] = clock(m[4]) ?? [12, 0];
    return toUtc(+m[3], +m[1], +m[2], h, mi);
  }
  const iso = Date.parse(date ?? submitted ?? "");
  return Number.isNaN(iso) ? null : new Date(iso).toISOString();
};

// ——— the records ———
const payload = [];
const skipped = [];
for (const rec of records) {
  const t = first(rec.id, "instance_of"), s = first(rec.id, "at_site");
  const tm = t && map.templates[t.id], siteId = s && map.sites[s.id];
  const when = performedAt(rec);
  // A dry run can describe unmapped input; a live run rejects it before filing.
  const reason = !t ? "no template" : !s ? "no site" : !when ? "no date of service" : !tm && !dry ? "template not mapped" : !siteId && !dry ? "site not mapped" : null;
  if (reason) {
    skipped.push({ id: rec.id, reason });
    continue;
  }
  if (!tm || !siteId) {
    payload.push(rec.id);
    continue;
  }
  const values = {};
  for (const f of factsOf(rec)) {
    const b = blockOf(f);
    const id = b && tm.blocks[b.id];
    if (!id || tm.kinds[b.id] === "photo") continue;
    const v = clean(props(f).value);
    if (v === "" || v === null || v === undefined) continue;
    values[id] = tm.kinds[b.id] === "number" ? Number(v) : String(v);
  }
  const semantic = resolved.get(rec.id);
  const who = semantic ? semantic.employee.name : props(first(rec.id, "performed_by")).name;
  payload.push({
    siteId,
    templateId: tm.id,
    performedAt: when,
    ...(semantic ? {semantics:semantic, byName:who || ""} : who ? {byName:String(who).split("@")[0].slice(0,80)} : {}),
    values,
    origin: { file: (props(rec).sourcePath ?? props(rec).archiveFolder ?? "graph").slice(0, 200), externalId: props(rec).externalId ?? props(rec).reportId ?? rec.id },
  });
}
for (const s of skipped) console.log(`skip ${s.id}: ${s.reason}`);
console.log(`${payload.length} records ready${skipped.length ? `, ${skipped.length} skipped` : ""}`);
if (dry) process.exit(0);

// Keep requests comfortably below the gate's 1 MiB limit.
const BATCH = 200, BYTES = 120 * 1024;
let filed = 0, duplicate = 0, failed = 0;
for (let i = 0; i < payload.length; ) {
  let j = i, size = 0;
  while (j < payload.length && j - i < BATCH && (j === i || size + JSON.stringify(payload[j]).length < BYTES)) size += JSON.stringify(payload[j++]).length;
  const { results } = await api("/import", { method: "POST", body: JSON.stringify({ records: payload.slice(i, j) }) });
  for (const r of results) {
    if (r.error) (failed++, console.log(`  ! ${payload[i + r.index].origin.externalId}: ${r.error}`));
    else if (r.duplicate) duplicate++;
    else filed++;
  }
  i = j;
}
console.log(`filed ${filed}, already there ${duplicate}, failed ${failed}`);
process.exit(failed ? 1 : 0);
