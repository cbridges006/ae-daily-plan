/**
 * The plan, built from rows already read. No network, no clock, no model.
 *
 * Two passes, because Apollo is asked only what the CRM cannot answer:
 * `needs` says which accounts want a readiness refresh or a people search,
 * the caller fetches those, and `build` turns everything into ranked cards,
 * the accounts left out with the reason, and the writes to propose.
 *
 * Everything a card says is a fact with its date. Nothing here writes prose
 * for the customer; that is the model's one job, done later, on these facts.
 */
import type { ApolloOrg, ApolloPerson } from "./apollo.ts";
import { domainOf } from "./apollo.ts";
import type { ContactPlan, ContactRow, PlanContact } from "./contacts.ts";
import { contactPlan, safe } from "./contacts.ts";
import type { Icp, Scored } from "./readiness.ts";
import type { Signals } from "./signals.ts";
import { hiringWhy, signalFacts } from "./signals.ts";
import { score } from "./readiness.ts";
import type { AccountRow, Item, Tier } from "./rank.ts";
import { QUIET_DAYS, daysBetween, notOutbound, rank, staleNextStep, storedReadiness } from "./rank.ts";

export interface OppRow { Id: string; AccountId: string; Name: string; Amount?: number | null; CloseDate?: string | null; StageName?: string | null; IsClosed: boolean; IsWon: boolean; NextStep?: string | null; Next_Step_Updated__c?: string | null }
export interface CallRow { Id: string; Account__c: string; Name: string; Call_Start__c: string; Call_Brief__c?: string | null; Next_Steps__c?: string | null }
export interface CaseRow { Id: string; AccountId: string; Subject?: string | null; Priority?: string | null; CreatedDate: string }
export interface EventRow { Id: string; AccountId: string; Subject?: string | null; StartDateTime: string }
export interface TaskRow { Id: string; AccountId: string; Subject?: string | null; ActivityDate: string }

export interface Rows {
  accounts: AccountRow[];
  opps: OppRow[];
  contacts: ContactRow[];
  calls: CallRow[];
  /** Open cases only. */
  cases: CaseRow[];
  /** Events in a window around today; `build` keeps the ones on the rep's own day. */
  events: EventRow[];
  /** Open tasks due before today. */
  overdueTasks: TaskRow[];
}

export interface Fetched {
  /** Company facts by account id. Absent means Apollo was not asked; null means it had nothing. */
  orgs: Map<string, ApolloOrg | null>;
  /** People found by account id. Absent means not asked. */
  people: Map<string, ApolloPerson[]>;
  /** Company data, hiring and news by account id. Absent means not read. */
  signals?: Map<string, Signals>;
}

export interface Card {
  key: string;
  account: string;
  tier: Tier;
  label: string;
  amount: number | null;
  why: string;
  facts: string[];
  contacts: ContactPlan;
  /** An open high priority support case: no pitch email while it stands. */
  hold: string | null;
  meeting: string | null;
  priorTouch: boolean;
  email: { allowed: boolean; why: string | null };
  url: string | null;
  oppId: string | null;
}

export interface Write {
  n: number;
  kind: "readiness" | "contact" | "task";
  account: string;
  summary: string;
  sobject: "Account" | "Contact" | "Task";
  /** Present for an update; absent for a create. */
  id?: string;
  fields: Record<string, unknown>;
}

export interface Plan {
  rep: string;
  day: string;
  cards: Card[];
  leftOut: { account: string; why: string }[];
  notChecked: string[];
  writes: Write[];
}

const LABEL: Readonly<Record<Tier, string>> = { pipeline: "Open pipeline", meeting: "Meeting today", reengage: "Reengage", outbound: "Outbound" };

/** A date only field ("2026-11-28") is a calendar day, not an instant; noon UTC keeps it on that day in every zone. */
const asDate = (s: string): Date => new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
export const shortDate = (s: string | Date, timeZone = "UTC"): string =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(typeof s === "string" ? asDate(s) : s);
export function money(n: number | null | undefined): string | null {
  if (typeof n !== "number") return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}
const localDay = (d: Date, timeZone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const localTime = (d: Date, timeZone: string): string => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(d);

const group = <T,>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); const have = m.get(k); if (have) have.push(r); else m.set(k, [r]); }
  return m;
};

/** Which accounts are worth a look at all today: an open deal, a meeting, or a target that is not a customer or partner. */
function inPlay(rows: Rows, now: Date, timeZone: string): AccountRow[] {
  const today = localDay(now, timeZone);
  const withOpp = new Set(rows.opps.filter((o) => !o.IsClosed).map((o) => o.AccountId));
  const withMeeting = new Set(rows.events.filter((e) => localDay(new Date(e.StartDateTime), timeZone) === today).map((e) => e.AccountId));
  return rows.accounts.filter((a) => withOpp.has(a.Id) || withMeeting.has(a.Id) || (a.Target_Account__c === true && !notOutbound(a.Type)));
}

/**
 * What Apollo should be asked. Every account in play gets company data,
 * hiring and news, since a card is only as good as its why now: a few
 * credits a day for a book of this size, cached for the day. Partners and
 * accounts with no website are never looked up. People search is only for
 * an account in play with nobody safe on record.
 */
export function needs(rows: Rows, icp: Icp, now: Date, timeZone: string): { enrich: AccountRow[]; rescore: AccountRow[]; people: AccountRow[] } {
  const play = inPlay(rows, now, timeZone).filter((a) => domainOf(a.Website));
  const contacts = group(rows.contacts, (c) => c.AccountId);
  const today = localDay(now, timeZone);
  // An account with an open deal or a meeting today is in the plan for that, never weighed on readiness, so it costs no credit.
  const busy = new Set([...rows.opps.filter((o) => !o.IsClosed).map((o) => o.AccountId), ...rows.events.filter((e) => localDay(new Date(e.StartDateTime), timeZone) === today).map((e) => e.AccountId)]);
  return {
    enrich: play,
    /** The subset whose readiness is rescored today; the rest keep a fresh stored letter. */
    rescore: play.filter((a) => a.Target_Account__c === true && !busy.has(a.Id) && !notOutbound(a.Type) && !storedReadiness(a, now).usable),
    people: play.filter((a) => !(contacts.get(a.Id) ?? []).some((c) => safe(c, icp.buyerTitles))),
  };
}

export function build(rows: Rows, got: Fetched, icp: Icp, o: { now: Date; timeZone: string; rep: string; instanceUrl: string | null; apolloChecked: boolean }): Plan {
  const { now, timeZone } = o;
  const today = localDay(now, timeZone);
  // Date only fields are calendar days. Counting them against noon of the rep's own today keeps "6 days ago" right at 11 PM
  // in the rep's zone, when UTC is already tomorrow.
  const anchor = new Date(`${today}T12:00:00Z`);
  const opps = group(rows.opps, (r) => r.AccountId);
  const contacts = group(rows.contacts, (r) => r.AccountId);
  const calls = group(rows.calls, (r) => r.Account__c);
  const cases = group(rows.cases, (r) => r.AccountId);
  const events = group(rows.events.filter((e) => localDay(new Date(e.StartDateTime), timeZone) === today), (r) => r.AccountId);
  const tasks = group(rows.overdueTasks, (r) => r.AccountId);

  const items: Item[] = [];
  const leftOut: Plan["leftOut"] = [];
  const notChecked = new Set<string>();
  const writes: Omit<Write, "n">[] = [];
  const scoredNow = new Map<string, Scored>();
  const meta = new Map<string, { amount: number | null; oppId: string | null; meeting: string | null; priorTouch: boolean }>();

  for (const a of rows.accounts) {
    const open = (opps.get(a.Id) ?? []).filter((x) => !x.IsClosed).sort((x, y) => (y.Amount ?? 0) - (x.Amount ?? 0));
    const lost = (opps.get(a.Id) ?? []).filter((x) => x.IsClosed && !x.IsWon).sort((x, y) => (y.CloseDate ?? "").localeCompare(x.CloseDate ?? ""));
    const heard = [...(calls.get(a.Id) ?? [])].sort((x, y) => y.Call_Start__c.localeCompare(x.Call_Start__c));
    const priorTouch = heard.length > 0 || lost.length > 0;
    const daysQuiet = a.Last_Sales_Activity__c ? daysBetween(asDate(a.Last_Sales_Activity__c), anchor) : null;
    const m = { amount: open[0]?.Amount ?? null, oppId: open[0]?.Id ?? null, meeting: null as string | null, priorTouch };
    meta.set(a.Id, m);

    for (const d of open) {
      const overdue = (tasks.get(a.Id) ?? []).sort((x, y) => x.ActivityDate.localeCompare(y.ActivityDate));
      const stale = staleNextStep(d.Next_Step_Updated__c, anchor);
      const closes = d.CloseDate ? asDate(d.CloseDate) : null;
      const closesThisMonth = !!closes && closes.getUTCFullYear() === anchor.getUTCFullYear() && closes.getUTCMonth() === anchor.getUTCMonth();
      const facts = [
        `Open deal "${d.Name}"${money(d.Amount) ? `, ${money(d.Amount)}` : ""}${d.StageName ? `, stage ${d.StageName}` : ""}${closes ? `, closes ${shortDate(d.CloseDate!)}` : ""}`,
        d.NextStep ? `Next step on record: "${d.NextStep}"${stale.days !== null ? ` (last changed ${shortDate(d.Next_Step_Updated__c!)}, ${stale.days} days ago)` : ""}` : "No next step on record",
        ...overdue.map((t) => `Overdue task: "${t.Subject ?? "untitled"}", due ${shortDate(t.ActivityDate)}`),
      ];
      const why = overdue.length ? `A task on this deal has been overdue since ${shortDate(overdue[0]!.ActivityDate)}.`
        : stale.stale ? `The next step hasn't changed in ${stale.days} days.`
        : closesThisMonth ? `It closes ${shortDate(d.CloseDate!)}.`
        : `Open deal${money(d.Amount) ? ` worth ${money(d.Amount)}` : ""}.`;
      items.push({ accountId: a.Id, accountName: a.Name, tier: "pipeline", why, facts, keys: { overdueTask: overdue.length > 0, staleNextStep: stale.stale, amount: d.Amount ?? null, closesThisMonth } });
    }

    for (const e of events.get(a.Id) ?? []) {
      const at = new Date(e.StartDateTime);
      m.meeting = `${e.Subject ?? "Meeting"} at ${localTime(at, timeZone)}`;
      items.push({ accountId: a.Id, accountName: a.Name, tier: "meeting", why: `You meet them today at ${localTime(at, timeZone)}.`, facts: [`Meeting today: ${m.meeting}`], keys: { at } });
    }

    // An account already in the plan for a deal or a meeting is not also weighed as outbound.
    if (a.Target_Account__c !== true || open.length > 0 || (events.get(a.Id) ?? []).length > 0) continue;
    const no = notOutbound(a.Type);
    if (no) { leftOut.push({ account: a.Name, why: no }); continue; }

    /* Readiness: the stored letter if it is fresh, else Apollo's facts scored now, else the reason it could not be used. */
    const stored = storedReadiness(a, now);
    let letter: "A" | "B" | "C" | null = null;
    let readinessFact: string;
    if (stored.usable) {
      letter = stored.letter;
      readinessFact = `Readiness ${letter} (updated ${shortDate(a.Last_Enriched_by_Apollo__c!)})`;
    } else if (got.orgs.get(a.Id)) {
      const sig = got.signals?.get(a.Id);
      const s = score(got.orgs.get(a.Id)!, icp, now, sig?.hiringRead ? { buyerRoles: sig.buyerRoles.length, salesRoles: sig.salesRoles } : undefined);
      scoredNow.set(a.Id, s);
      letter = s.letter;
      readinessFact = `Readiness ${letter} (Apollo, today): ${s.reasons.join("; ")}${s.notChecked.length ? `. Not checked: ${s.notChecked.join(", ")}` : ""}`;
      writes.push({ kind: "readiness", account: a.Name, sobject: "Account", id: a.Id, summary: `Set readiness to ${letter} on ${a.Name} (was ${a.Readiness__c || "blank"})`, fields: { Readiness__c: letter, Readiness_Reasons__c: s.reasons.join("; "), Last_Enriched_by_Apollo__c: now.toISOString() } });
    } else {
      const apolloWhy = !domainOf(a.Website) ? "it has no website to look up" : !o.apolloChecked ? "Apollo was not checked" : got.orgs.has(a.Id) ? "Apollo has no record of it" : "Apollo was not asked";
      leftOut.push({ account: a.Name, why: `${stored.why} It could not be refreshed: ${apolloWhy}.` });
      if (!o.apolloChecked) notChecked.add("Apollo (readiness)");
      continue;
    }
    if (letter === "C") { leftOut.push({ account: a.Name, why: `readiness C, nurture${scoredNow.get(a.Id) ? ` (${scoredNow.get(a.Id)!.reasons.join("; ")})` : ""}` }); continue; }

    const quiet = daysQuiet === null ? "No sales activity on record" : `No sales activity in ${daysQuiet} days (last on ${shortDate(a.Last_Sales_Activity__c!)})`;
    if (priorTouch) {
      if (daysQuiet !== null && daysQuiet < QUIET_DAYS) { leftOut.push({ account: a.Name, why: `worked ${daysQuiet} days ago, inside the ${QUIET_DAYS} day quiet period` }); continue; }
      const past = lost[0] ? `a deal lost on ${shortDate(lost[0].CloseDate!)}` : `a call on ${shortDate(heard[0]!.Call_Start__c, timeZone)}`;
      const hiring = hiringWhy(got.signals?.get(a.Id));
      items.push({ accountId: a.Id, accountName: a.Name, tier: "reengage", why: `Readiness ${letter}, quiet${daysQuiet !== null ? ` for ${daysQuiet} days` : ""} since ${past}${hiring ? `, and ${hiring}` : ""}.`, facts: [readinessFact, quiet, ...(lost[0] ? [`Lost deal "${lost[0].Name}", closed ${shortDate(lost[0].CloseDate!)}`] : [])], keys: { readiness: letter, daysQuiet } });
    } else {
      const hiring = hiringWhy(got.signals?.get(a.Id));
      items.push({ accountId: a.Id, accountName: a.Name, tier: "outbound", why: hiring ? `Readiness ${letter}, and ${hiring}.` : `Readiness ${letter}, and nobody has worked it yet.`, facts: [readinessFact, quiet], keys: { readiness: letter, daysQuiet } });
    }
  }

  const byId = new Map(rows.accounts.map((a) => [a.Id, a]));
  const cards: Card[] = rank(items).map((p) => {
    const a = byId.get(p.accountId)!;
    const m = meta.get(a.Id)!;
    const heard = [...(calls.get(a.Id) ?? [])].sort((x, y) => y.Call_Start__c.localeCompare(x.Call_Start__c));
    const openCases = [...(cases.get(a.Id) ?? [])].sort((x, y) => x.CreatedDate.localeCompare(y.CreatedDate));
    const high = openCases.find((c) => /high|critical|urgent/i.test(c.Priority ?? ""));
    const hold = high ? `Open ${high.Priority!.toLowerCase()} priority support case since ${shortDate(high.CreatedDate, timeZone)}: "${high.Subject ?? "no subject"}"` : null;

    // null means Apollo was not asked about this account's people, which the card then says.
    const plan = contactPlan(contacts.get(a.Id) ?? [], got.people.get(a.Id) ?? null, icp.buyerTitles);
    if (plan.kind === "research" && !got.people.has(a.Id)) notChecked.add("Apollo (people)");
    if (plan.kind === "contacts") {
      for (const c of [plan.primary, ...plan.alternates].filter((c): c is PlanContact => c.source === "apollo")) {
        // Salesforce will not save a Contact without a surname, and the free search can hide it.
        if (!c.lastName || /\*/.test(c.lastName)) continue;
        writes.push({ kind: "contact", account: a.Name, sobject: "Contact", summary: `Add ${c.firstName} ${c.lastName}${c.title ? `, ${c.title}` : ""} to ${a.Name} (from Apollo)`, fields: { AccountId: a.Id, FirstName: c.firstName, LastName: c.lastName, Title: c.title, Apollo_Id__c: c.apolloId, LeadSource: "Apollo" } });
      }
    }

    const facts = [
      ...p.items.flatMap((i) => i.facts),
      ...(got.signals?.get(a.Id) ? signalFacts(got.signals.get(a.Id)!) : []),
      ...(a.Type ? [`Account type: ${a.Type}`] : []),
      ...(heard[0] ? [`Last call ${shortDate(heard[0].Call_Start__c, timeZone)}: ${heard[0].Call_Brief__c ?? heard[0].Name}${heard[0].Next_Steps__c ? ` Promised then: ${heard[0].Next_Steps__c}` : ""}`] : ["No calls on record"]),
      ...(hold ? [hold] : []),
      ...(openCases.length ? [`${openCases.length} open support case${openCases.length === 1 ? "" : "s"}, oldest opened ${shortDate(openCases[0]!.CreatedDate, timeZone)}`] : []),
    ];
    const email = plan.kind !== "contacts" ? { allowed: false, why: `no email: ${plan.why}` }
      : hold ? { allowed: false, why: "no email while a high priority support case is open: lead with the case, by phone" }
      : !plan.primary.email ? { allowed: false, why: "no email: no address on record for the primary contact" }
      : { allowed: true, why: null };

    return {
      key: a.Id, account: a.Name, tier: p.tier, label: LABEL[p.tier], amount: m.amount,
      why: p.items[0]!.why, facts: [...new Set(facts)], contacts: plan, hold, meeting: m.meeting, priorTouch: m.priorTouch, email,
      url: o.instanceUrl ? `${o.instanceUrl}/${m.oppId ?? a.Id}` : null, oppId: m.oppId,
    };
  });

  // Only writes for accounts that made the plan, plus every readiness refresh: a C written back is a credit not spent tomorrow.
  const inPlan = new Set(cards.map((c) => c.account));
  const kept = writes.filter((w) => w.kind === "readiness" || inPlan.has(w.account));
  return { rep: o.rep, day: today, cards, leftOut, notChecked: [...notChecked], writes: kept.map((w, i) => ({ n: i + 1, ...w })) };
}
