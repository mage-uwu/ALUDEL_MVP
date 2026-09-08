import { normalizeTemplate, parsePlace } from "../shared/model";
import type { Env } from "./index";
import type { SourceSite, SourceTemplate } from "./import-plan";
import { mapSite, mapTemplate } from "./import-plan";
import { contactEmails, contactPhones, storedContacts } from "../shared/site-contacts";

const key = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** Existing objects stay authoritative: reuse their IDs, tasks, units, options,
 * and locations. A display name alone never establishes schema compatibility. */
export function importReconciler(env: Env, teamId: string) {
  return {
    async template(source: SourceTemplate, proposed: Awaited<ReturnType<typeof mapTemplate>>) {
      if (!source.blocks.every(b => b.identity) || source.sortStatus === "provisional") return proposed;
      const rows = await env.DB.prepare("SELECT id,name,version,doc FROM templates WHERE team_id = ? AND (id = ? OR name = ? COLLATE NOCASE)")
        .bind(teamId, proposed.mapping.id, source.name).all<{ id: string; name: string; version: number; doc: string }>();
      const matches = [];
      for (const row of rows.results) {
        const template = normalizeTemplate({ ...JSON.parse(row.doc), name: row.name })!;
        const blocks = template.tasks.flatMap(t => t.blocks), mapping: typeof proposed.mapping.blocks = Object.create(null);
        if (row.id !== proposed.mapping.id && blocks.some(b=>b.fieldIdentity)) continue;
        const used = new Set<string>();
        for (const b of source.blocks) {
          const expected = proposed.mapping.blocks[b.id];
          if (!expected) continue;
          const candidates = blocks.filter(c => (c.fieldIdentity ?? key(c.label)) === b.identity && c.kind === expected.kind
            && c.unit === (b.unit ?? "") && (!c.semanticRole || !b.semanticRole || c.semanticRole === b.semanticRole)
            && (c.kind !== "buttons" || b.options.every(o => c.options.includes(String(o)))));
          if (candidates.length !== 1 || used.has(candidates[0]!.id)) break;
          const target = candidates[0]!; used.add(target.id); mapping[b.id] = { id: target.id, kind: target.kind, label:target.label };
        }
        if (Object.keys(mapping).length === Object.keys(proposed.mapping.blocks).length) matches.push({
          item: { kind: "template" as const, payload: { id: row.id, ...template } }, mapping: { id: row.id, blocks: mapping }
        });
      }
      const exact = matches.find(m => m.mapping.id === proposed.mapping.id);
      if (exact) return exact;
      if (matches.length === 1) return matches[0]!;
      // A user edited the deterministic imported template incompatibly: keep
      // their template intact and create a distinct version for this schema.
      if (rows.results.some(r => r.id === proposed.mapping.id)) {
        const versioned = await mapTemplate({ ...source, sortStatus: "provisional" }, teamId, `schema:${JSON.stringify(rows.results.map(r => [r.id,r.version]))}`);
        return versioned;
      }
      return proposed;
    },
    async site(source: SourceSite, proposed: Awaited<ReturnType<typeof mapSite>>) {
      if (source.sourceAddress === undefined) return proposed;
      const row = await env.DB.prepare("SELECT id FROM sites WHERE team_id = ? AND id = ?").bind(teamId, source.id).first<{ id: string }>();
      return row ? { id: row.id, item: { ...proposed.item, payload: { ...proposed.item.payload, id: row.id } } } : proposed;
    }
  };
}

/** Prepend a server-owned profile part while streaming the original multipart
 * body unchanged. Tenant site IDs let the existing binder reconcile new imports. */
export async function withSiteProfiles(env: Env, teamId: string, headers: Headers, body: ReadableStream<Uint8Array>) {
  const type = headers.get("content-type") ?? "", match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) throw new Error("Invalid multipart boundary");
  const rows = await env.DB.prepare("SELECT id,client_name,address,location_note,place,emails,phones FROM sites WHERE team_id = ? ORDER BY id")
    .bind(teamId).all<{ id: string; client_name: string; address: string; location_note: string; place: string | null; emails: string; phones: string }>();
  if (!rows.results.length) return body;
  const sites = rows.results.map(s => {
    const place = parsePlace(s.place), address = place?.formattedAddress || s.address || s.location_note;
    return { siteId: s.id, observations: [{ recordId: `aludel:${s.id}`, anchor: true, fields: {
      service_address: address ? [address] : [], client_name: s.client_name ? [s.client_name] : [],
      client_email: contactEmails(storedContacts(s.emails)),
      client_phone: contactPhones(storedContacts(s.phones)),
    } }] };
  });
  const encoded = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, sites }));
  if (encoded.byteLength > 16 * 1024 * 1024) throw new Error("Existing site directory exceeds the binding profile limit");
  const prefix = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="breakfast-site-profiles.json"\r\nContent-Type: application/json\r\n\r\n`);
  const reader = body.getReader(); let first = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first) { first = false; controller.enqueue(prefix); controller.enqueue(encoded); controller.enqueue(new TextEncoder().encode("\r\n")); return; }
      const next = await reader.read(); if (next.done) { controller.close(); reader.releaseLock(); } else controller.enqueue(next.value);
    }, async cancel(reason) { await reader.cancel(reason); reader.releaseLock(); }
  });
}
