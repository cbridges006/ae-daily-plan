/**
 * Who to contact on an account, and how.
 *
 * A primary contact and up to two alternates. Nobody who has left, opted out
 * of email, or is outside the buying team named in the ICP. Only the office
 * phone is ever shown: `MobilePhone` is never queried, so it cannot leak.
 *
 * When the CRM has nobody safe, the plan used to stop at "research this
 * account". Here that gap is what Apollo fills: people found there are
 * proposed as new Contacts, and created only when the rep approves.
 *
 * Pure. Names are swapped for tokens before the model sees them (tokens.ts);
 * this file decides who, not how.
 */
import type { ApolloPerson } from "./apollo.ts";

export const ALTERNATES_MAX = 2;

/** The Contact fields the plan reads. `MobilePhone` is deliberately absent. */
export const CONTACT_FIELDS: readonly string[] = [
  "Id", "AccountId", "FirstName", "LastName", "Title", "Email", "Phone",
  "HasOptedOutOfEmail", "Left_Company__c", "Priority_Contact__c", "Apollo_Id__c", "LastActivityDate",
];

export interface ContactRow {
  Id: string;
  AccountId: string;
  FirstName?: string | null;
  LastName?: string | null;
  Title?: string | null;
  Email?: string | null;
  Phone?: string | null;
  HasOptedOutOfEmail?: boolean | null;
  Left_Company__c?: boolean | null;
  Priority_Contact__c?: boolean | null;
  Apollo_Id__c?: string | null;
  LastActivityDate?: string | null;
}

export interface PlanContact {
  /** Salesforce Contact id, or null for a person Apollo found who is not in the CRM yet. */
  id: string | null;
  apolloId: string | null;
  firstName: string;
  lastName: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  source: "salesforce" | "apollo";
}

/** A title is in the buying team when it contains any of the ICP's title keywords. */
export function inBuyingTeam(title: string | null | undefined, keywords: readonly string[]): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  return keywords.some((k) => t.includes(k.toLowerCase()));
}

/**
 * Safe to approach: still there, not opted out, in the buying team. Each
 * flag must be explicitly false; a missing flag is not taken as permission.
 */
export function safe(c: ContactRow, keywords: readonly string[]): boolean {
  return c.Left_Company__c === false && c.HasOptedOutOfEmail === false && inBuyingTeam(c.Title, keywords);
}

const fromCrm = (c: ContactRow): PlanContact => ({
  id: c.Id,
  apolloId: c.Apollo_Id__c ?? null,
  firstName: c.FirstName?.trim() || "",
  lastName: c.LastName?.trim() || "",
  title: c.Title?.trim() || null,
  email: c.Email?.trim() || null,
  phone: c.Phone?.trim() || null,
  source: "salesforce",
});

const fromApollo = (p: ApolloPerson): PlanContact => ({
  id: null, apolloId: p.id, firstName: p.firstName, lastName: p.lastName, title: p.title, email: p.email, phone: null, source: "apollo",
});

export type ContactPlan =
  | { kind: "contacts"; primary: PlanContact; alternates: PlanContact[]; channel: "email" | "call"; note: string | null }
  | { kind: "research"; why: string };

/**
 * The primary and up to two alternates on one account.
 *
 * CRM contacts come first: the flagged priority contact, then the most
 * recently worked. Apollo's people only fill the seats the CRM leaves empty,
 * and never anyone the CRM already holds (matched on Apollo id, then email,
 * then name), so an approved write cannot create a duplicate or bring back
 * somebody who opted out.
 */
export function contactPlan(contacts: readonly ContactRow[], found: readonly ApolloPerson[] | null, keywords: readonly string[]): ContactPlan {
  const at = (c: ContactRow): number => (c.LastActivityDate ? new Date(c.LastActivityDate).getTime() || 0 : 0);
  const ok = contacts.filter((c) => safe(c, keywords))
    .sort((a, b) => Number(!!b.Priority_Contact__c) - Number(!!a.Priority_Contact__c) || at(b) - at(a))
    .map(fromCrm);

  const known = (p: ApolloPerson): boolean => contacts.some((c) =>
    (!!c.Apollo_Id__c && c.Apollo_Id__c === p.id)
    || (!!c.Email && !!p.email && c.Email.toLowerCase() === p.email.toLowerCase())
    || (`${c.FirstName ?? ""} ${c.LastName ?? ""}`.trim().toLowerCase() === `${p.firstName} ${p.lastName}`.trim().toLowerCase()));
  const fresh = (found ?? []).filter((p) => !known(p) && inBuyingTeam(p.title, keywords)).map(fromApollo);

  const seats = [...ok, ...fresh].slice(0, 1 + ALTERNATES_MAX);
  if (seats.length === 0) {
    const base = contacts.length ? "nobody on record is safe to approach in the buying team" : "no contacts on record";
    return { kind: "research", why: found === null ? `${base}, and Apollo people search was not run` : `${base}, and Apollo found nobody in the buying team` };
  }
  const [primary, ...alternates] = seats;
  const fromApolloCount = seats.filter((s) => s.source === "apollo").length;
  return {
    kind: "contacts",
    primary: primary!,
    alternates,
    // No address on record means a call. An Apollo search result carries no email until it is revealed there.
    channel: primary!.email ? "email" : "call",
    note: fromApolloCount ? `${fromApolloCount} of these ${fromApolloCount === 1 ? "is" : "are"} from Apollo and not in Salesforce yet.` : null,
  };
}
