import { contactEmails, contactKey, contactPhones, type SiteContactDetails } from "../shared/site-contacts";

/** Recover approved site assignments from saved semantics, never raw report labels.
 * Bound the number of sites/returned values; aggregation runs in the Vault's SQLite. */
export function savedSiteContacts(sql: SqlStorage, after: string) {
  const sites = sql.exec<{ site_id: string }>(`SELECT DISTINCT site_id FROM reports
    WHERE site_id>? AND origin IS NOT NULL AND semantics IS NOT NULL ORDER BY site_id LIMIT 26`, after).toArray();
  const profiles = sites.slice(0, 25).map(({ site_id }) => {
    const values = (path: string) => sql.exec<{ value: string; n: number }>(`SELECT j.value,COUNT(*) AS n
      FROM reports r,json_each(CASE WHEN json_valid(r.semantics) THEN r.semantics ELSE '{}' END,?) j
      WHERE r.site_id=? AND r.origin IS NOT NULL AND j.type='text' AND trim(j.value)<>''
      GROUP BY trim(j.value) COLLATE NOCASE ORDER BY n DESC,j.value LIMIT 100`, path, site_id).toArray();
    const names = values("$.client.name"), addresses = new Map(values("$.serviceAddresses").map(v => [contactKey(v.value), v.value]));
    const details: SiteContactDetails = {
      clientName: names[0] && names[0].n !== names[1]?.n ? names[0].value : "",
      address: addresses.size === 1 ? [...addresses.values()][0]! : "",
      emails: contactEmails(values("$.client.emails").map(v => v.value)),
      phones: contactPhones(values("$.client.phones").map(v => v.value)),
    };
    return { siteId: site_id, details };
  });
  return { profiles, nextCursor: sites.length > 25 ? profiles.at(-1)!.siteId : null };
}
