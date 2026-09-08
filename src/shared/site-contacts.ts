import { EMAIL_RE } from "./model";
import type { BreakfastPerson, BreakfastSemantics } from "./breakfast";

export const contactKey = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();
export const contactEmails = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string")
    .flatMap(v => v.split(/[;,\n]/)).map(v => v.trim().toLowerCase())
    .filter(v => v.length <= 160 && EMAIL_RE.test(v)))].slice(0, 10);
};
export function phoneKey(value: string): string | null {
  const match = value.trim().match(/^(.*?)(?:\s*(?:ext\.?|extension|x|#)\s*(\d{1,8}))?$/i);
  if (!match || !/^[+\d\s()./-]+$/.test(match[1]!)) return null;
  let digits = match[1]!.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits + (match[2] ? `x${match[2]}` : "");
}
export function contactPhones(value: unknown): string[] {
  const unique = new Map<string, string>();
  for (const raw of Array.isArray(value) ? value : []) {
    if (typeof raw !== "string") continue;
    for (const part of raw.split(/[;,\n]/)) {
      const phone = part.trim(), key = phone.length <= 80 ? phoneKey(phone) : null;
      if (key && !unique.has(key)) unique.set(key, phone);
    }
  }
  return [...unique.values()].slice(0, 10);
}
export const storedContacts = (raw: unknown): unknown => {
  try { return JSON.parse(typeof raw === "string" ? raw : "[]"); } catch { return []; }
};

/** The same ownership contract used on records, now also present on site rows. */
export function siteClient(value: unknown): BreakfastPerson | null {
  if (value === undefined || value === null) return null;
  const p = value as BreakfastPerson;
  if (!p || ![p.name, p.firstName, p.lastName].every(v => v === null || typeof v === "string")
    || !Array.isArray(p.emails) || !Array.isArray(p.phones) || ![...p.emails, ...p.phones].every(v => typeof v === "string")) {
    throw new Error("Invalid Breakfast site client contract");
  }
  return { ...p, emails: contactEmails(p.emails), phones: contactPhones(p.phones) };
}

export interface SiteContactDetails { clientName: string; address: string; emails: string[]; phones: string[] }
export interface SiteContactRecovery { processedSites: number; updatedSites: number; nextCursor: string | null }

/** Aggregate only approved, site-bound client semantics. Names need a unique winner. */
export class SiteContacts {
  private names = new Map<string, { value: string; count: number }>();
  private addresses = new Map<string, string>();
  private emails: string[] = [];
  private phones: string[] = [];
  add(semantics: BreakfastSemantics) {
    const name = semantics.client.name?.trim();
    if (name) {
      const key = contactKey(name), old = this.names.get(key);
      this.names.set(key, { value: old?.value ?? name, count: (old?.count ?? 0) + 1 });
    }
    for (const address of semantics.serviceAddresses) if (address.trim()) this.addresses.set(contactKey(address), address.trim());
    this.emails = contactEmails([...this.emails, ...semantics.client.emails]);
    this.phones = contactPhones([...this.phones, ...semantics.client.phones]);
  }
  details(): SiteContactDetails {
    const ranked = [...this.names.values()].sort((a, b) => b.count - a.count);
    return { clientName: ranked[0] && ranked[0].count !== ranked[1]?.count ? ranked[0].value : "",
      address: this.addresses.size === 1 ? [...this.addresses.values()][0]! : "", emails: this.emails, phones: this.phones };
  }
}
