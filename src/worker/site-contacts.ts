import { contactEmails, contactKey, contactPhones, storedContacts, type SiteContactDetails } from "../shared/site-contacts";
import { normalizePlace } from "../shared/model";
import type { Env } from "./index";

type Row = { id: string; client_name: string; address: string; location_note: string; place: string | null;
  emails: string; phones: string; imported_contacts: string | null };
const text = (v: unknown) => typeof v === "string" ? v.trim() : "";

/** Fill missing details and extend contacts we previously imported. A user-edited
 * contact list differs from our saved baseline and stays entirely authoritative. */
export async function enrichSite(env: Env, teamId: string, siteId: string, details: SiteContactDetails): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await env.DB.prepare("SELECT id,client_name,address,location_note,place,emails,phones,imported_contacts FROM sites WHERE team_id=? AND id=?")
      .bind(teamId, siteId).first<Row>();
    if (!row) return false; // Deleted or belongs to another tenant; never recreate it.
    const old = storedContacts(row.imported_contacts) as { emails?: string[]; phones?: string[] };
    const emails = contactEmails(storedContacts(row.emails)), phones = contactPhones(storedContacts(row.phones));
    const managedEmails = old?.emails !== undefined ? JSON.stringify(emails) === JSON.stringify(contactEmails(old.emails)) : emails.length === 0;
    const managedPhones = old?.phones !== undefined ? JSON.stringify(phones) === JSON.stringify(contactPhones(old.phones)) : phones.length === 0;
    const nextEmails = managedEmails ? contactEmails([...emails, ...details.emails]) : emails;
    const nextPhones = managedPhones ? contactPhones([...phones, ...details.phones]) : phones;
    const address = row.address || normalizePlace(storedContacts(row.place))?.formattedAddress || details.address.slice(0, 240);
    const placeholder = !row.client_name.trim() || ["imported site", "new site", row.address, row.location_note, details.address].some(v => v && contactKey(v) === contactKey(row.client_name));
    const name = placeholder && details.clientName ? details.clientName.slice(0, 80) : row.client_name;
    const baseline = JSON.stringify({ ...(old && !Array.isArray(old) ? old : {}),
      ...(managedEmails ? { emails: nextEmails } : {}), ...(managedPhones ? { phones: nextPhones } : {}) });
    const next = [name, address, JSON.stringify(nextEmails), JSON.stringify(nextPhones), baseline];
    if (JSON.stringify(next) === JSON.stringify([row.client_name, row.address, row.emails, row.phones, row.imported_contacts])) return false;
    const result = await env.DB.prepare(`UPDATE sites SET client_name=?,address=?,emails=?,phones=?,imported_contacts=?,updated_at=?
      WHERE team_id=? AND id=? AND client_name=? AND address=? AND emails=? AND phones=? AND imported_contacts IS ?`)
      .bind(...next, new Date().toISOString(), teamId, siteId, row.client_name, row.address, row.emails, row.phones, row.imported_contacts).run();
    if (result.meta.changes) return name !== row.client_name || address !== row.address || next[2] !== row.emails || next[3] !== row.phones;
  }
  throw new Error("Site details changed while importing. Retry to use the latest saved site.");
}

export async function saveImportedSite(env: Env, teamId: string, payload: Record<string, unknown>) {
  const id = text(payload.id), place = normalizePlace(payload.place);
  const address = place?.formattedAddress || text(payload.address) || text(payload.locationNote);
  const details = { clientName: text(payload.clientName), address,
    emails: contactEmails(payload.emails), phones: contactPhones(payload.phones) };
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO sites(id,team_id,client_name,address,place,location_note,emails,phones,imported_contacts,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(id, teamId, details.clientName || address || "Imported site", address, place ? JSON.stringify(place) : null,
      text(payload.locationNote), JSON.stringify(details.emails), JSON.stringify(details.phones),
      JSON.stringify({ emails: details.emails, phones: details.phones }), now, now).run();
  await enrichSite(env, teamId, id, details);
}
