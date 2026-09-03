#!/usr/bin/env node
// Files a sidecar graph export into a team's vault through the import gate.
//
//   node tools/import-graph.mjs graph.json --team <id> --token aludel_… [--base https://…]
//                               [--map map.json] [--tz America/New_York] [--dry] [--keep-constants]
//
// The graph is the sidecar's own shape: record → fact → block → template, plus
// site and employee. Only that spine is read; classifier nodes are ignored. A
// template the map has never seen is created from its blocks, a site from its
// address (the place is left for the picker), and both are remembered in the
// map file so a rerun reuses them. Identity is the record's own id, so a rerun
// never files twice.
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1] ?? fallback;
};
const has = (name) => args.includes(`--${name}`);
const VALUE_FLAGS = new Set(["base", "team", "token", "map", "tz"]);
const graphPath = args.find((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(args[i - 1].replace(/^--/, ""))));
const base = (flag("base", "http://localhost:8787") ?? "").replace(/\/$/, "");
const team = flag("team");
const token = flag("token", process.env.ALUDEL_TOKEN);
const mapPath = flag("map", "aludel-map.json");
const tz = flag("tz", "America/New_York");
const dry = has("dry");
const keepConstants = has("keep-constants");
if (!graphPath || !team || (!token && !dry)) {
  console.error("usage: import-graph.mjs graph.json --team <id> --token aludel_… [--base url] [--map file] [--tz zone] [--dry]");
  process.exit(2);
}

// ——— the graph, indexed ———
const g = JSON.parse(readFileSync(graphPath, "utf8"));
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

// facts of a record, keyed by labelId and by block id
const factsOf = (rec) => targets(rec.id, "has_fact");
const blockOf = (fact) => first(fact.id, "uses_block");
const byLabel = (rec, labelId) => factsOf(rec).find((f) => props(f).labelId === labelId) ?? null;

// ——— block kinds, inferred from every value the corpus filed under the block ———
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
const kindOf = (blockId) => {
  const u = usage.get(blockId) ?? { values: [], records: new Set() };
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
const save = () => !dry && writeFileSync(mapPath, JSON.stringify(map, null, 2) + "\n");

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
  const plan = blocks.map((b) => ({ graphId: b.id, label: (props(b).displayName || props(b).labelId || "Field").slice(0, 60), ...kindOf(b.id) }));
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
  // one task per 20 blocks, in the form's own order; ids minted here so the map can keep them
  const ids = Object.fromEntries(kept.map((b) => [b.graphId, crypto.randomUUID()]));
  const tasks = [];
  for (let k = 0; k < kept.length; k += 20)
    tasks.push({
      name: tasks.length ? `${name} (${tasks.length + 1})`.slice(0, 80) : name,
      blocks: kept.slice(k, k + 20).map((b) => ({ id: ids[b.graphId], kind: b.kind, label: b.label, unit: "", options: b.options ?? [] })),
    });
  const { id } = await api("/templates", { method: "POST", body: JSON.stringify({ name }) });
  await api(`/templates/${id}`, { method: "PUT", body: JSON.stringify({ name, tasks, version: 1 }) });
  map.templates[t.id] = { id, blocks: ids, kinds: Object.fromEntries(kept.map((b) => [b.graphId, b.kind])) };
  save();
  console.log(`  created ${id}`);
}

// ——— sites ———
const nameOf = (rec) => {
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
  const { id } = await api("/sites", { method: "POST", body: JSON.stringify({ clientName, locationNote: address.slice(0, 240) }) });
  map.sites[s.id] = id;
  save();
  console.log(`  created ${id}; pick its place in the app`);
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
  const date = clean(props(byLabel(rec, "date_of_service")).value);
  const time = clean(props(byLabel(rec, "time_of_service") ?? byLabel(rec, "start_time")).value);
  const submitted = clean(props(byLabel(rec, "submitted_on")).value);
  const us = /^(\d{2})-(\d{2})-(\d{4})(?:\s+(.+))?$/;
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
  // a dry run has not created anything yet, so an unmapped template or site is one that would be
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
  const who = props(first(rec.id, "performed_by")).name;
  payload.push({
    siteId,
    templateId: tm.id,
    performedAt: when,
    ...(who ? { byName: String(who).split("@")[0].slice(0, 80) } : {}),
    values,
    origin: { file: props(rec).sourcePath ?? props(rec).archiveFolder ?? "graph", externalId: props(rec).reportId ?? rec.id },
  });
}
for (const s of skipped) console.log(`skip ${s.id}: ${s.reason}`);
console.log(`${payload.length} records ready${skipped.length ? `, ${skipped.length} skipped` : ""}`);
if (dry) process.exit(0);

let filed = 0, duplicate = 0, failed = 0;
for (let i = 0; i < payload.length; i += 200) {
  const { results } = await api("/import", { method: "POST", body: JSON.stringify({ records: payload.slice(i, i + 200) }) });
  for (const r of results) {
    if (r.error) (failed++, console.log(`  ! ${payload[i + r.index].origin.externalId}: ${r.error}`));
    else if (r.duplicate) duplicate++;
    else filed++;
  }
}
console.log(`filed ${filed}, already there ${duplicate}, failed ${failed}`);
process.exit(failed ? 1 : 0);
