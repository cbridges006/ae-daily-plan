/**
 * Which accounts make the plan, and in what order.
 *
 * Ranking is a sort, not a score. The order is policy, and policy should be
 * the same every morning and explainable to a rep: "account three is above
 * account four because its next step is 21 days old". A model was never asked
 * to rank. The only thresholds are the three below.
 *
 * Pure: rows come in already read, so every rule is a test.
 */

export const STALE_NEXT_STEP_DAYS = 14;
export const QUIET_DAYS = 30;
/** A readiness letter older than this is not trusted. It is refreshed from Apollo, or the account says why it was not used. */
export const READINESS_FRESH_DAYS = 30;
/** At most ten outbound accounts. Urgent work is never capped. */
export const OUTBOUND_MAX = 10;

export type Tier = "pipeline" | "meeting" | "reengage" | "outbound";
/** Highest first. */
export const TIER_ORDER: readonly Tier[] = ["pipeline", "meeting", "reengage", "outbound"];
const URGENT: ReadonlySet<Tier> = new Set(["pipeline", "meeting"]);
export const isUrgent = (t: Tier): boolean => URGENT.has(t);

const DAY = 86_400_000;
export const daysBetween = (from: Date, to: Date): number => Math.floor((to.getTime() - from.getTime()) / DAY);

/**
 * Readiness by its leading letter. Matching the letter keeps a change of
 * wording ("A: act this month") from silently emptying the list. The letter
 * must stand alone, so "Active" is not an A.
 */
export function readinessLetter(v: unknown): "A" | "B" | "C" | null {
  if (typeof v !== "string") return null;
  const m = /^\s*([ABC])(?![A-Za-z])/i.exec(v);
  return m ? (m[1]!.toUpperCase() as "A" | "B" | "C") : null;
}

export interface AccountRow {
  Id: string;
  Name: string;
  Website?: string | null;
  Type?: string | null;
  Target_Account__c?: boolean | null;
  Readiness__c?: string | null;
  Last_Enriched_by_Apollo__c?: string | null;
  Last_Sales_Activity__c?: string | null;
}

/** Customers are not outbound (they can still be in the plan through an open expansion deal). Partners never are. */
export function notOutbound(type: string | null | undefined): string | null {
  if (!type) return null;
  if (/^customer/i.test(type)) return "already a customer";
  if (/partner|reseller/i.test(type)) return `a partner (${type})`;
  return null;
}

export type Readiness =
  | { usable: true; letter: "A" | "B" | "C"; ageDays: number }
  | { usable: false; why: string };

/**
 * Whether the letter on the record may be used as it stands. A blank or
 * stale one is said, never guessed: the caller refreshes it from Apollo, and
 * if that fails the account carries this reason.
 */
export function storedReadiness(a: AccountRow, now: Date): Readiness {
  const letter = readinessLetter(a.Readiness__c);
  if (!letter) return { usable: false, why: "Readiness isn't set for this account." };
  const at = a.Last_Enriched_by_Apollo__c ? new Date(a.Last_Enriched_by_Apollo__c) : null;
  if (!at || Number.isNaN(at.getTime())) return { usable: false, why: "Readiness wasn't used: it has no update date." };
  const age = daysBetween(at, now);
  if (age > READINESS_FRESH_DAYS) return { usable: false, why: `Readiness wasn't used: it was last updated ${age} days ago.` };
  return { usable: true, letter, ageDays: age };
}

/** A next step is stale when its last update is more than 14 days old. 14 is not stale; 15 is. */
export function staleNextStep(lastUpdate: string | null | undefined, now: Date): { stale: boolean; days: number | null } {
  if (!lastUpdate) return { stale: false, days: null };
  const d = new Date(lastUpdate);
  if (Number.isNaN(d.getTime())) return { stale: false, days: null };
  const days = daysBetween(d, now);
  return { stale: days > STALE_NEXT_STEP_DAYS, days };
}

/** One thing the plan could say about one account. */
export interface Item {
  accountId: string;
  accountName: string;
  tier: Tier;
  why: string;
  facts: string[];
  /** Sort keys inside a tier; absent means lowest. */
  keys?: {
    overdueTask?: boolean;
    staleNextStep?: boolean;
    amount?: number | null;
    closesThisMonth?: boolean;
    readiness?: "A" | "B" | null;
    daysQuiet?: number | null;
    at?: Date | null;
  };
}

/** One account in the plan: its highest tier, and everything said about it. */
export interface PlanAccount {
  accountId: string;
  accountName: string;
  tier: Tier;
  items: Item[];
}

const rankLetter = (v: "A" | "B" | null | undefined): number => (v === "A" ? 0 : v === "B" ? 1 : 2);

function compareInTier(a: Item, b: Item): number {
  const x = a.keys ?? {}, y = b.keys ?? {};
  switch (a.tier) {
    case "pipeline":
      return Number(!!y.overdueTask) - Number(!!x.overdueTask)
        || Number(!!y.staleNextStep) - Number(!!x.staleNextStep)
        || (y.amount ?? -1) - (x.amount ?? -1)
        || Number(!!y.closesThisMonth) - Number(!!x.closesThisMonth);
    case "reengage":
    case "outbound":
      return rankLetter(x.readiness) - rankLetter(y.readiness) || (y.daysQuiet ?? -1) - (x.daysQuiet ?? -1);
    default:
      // Meetings: soonest first.
      return (x.at?.getTime() ?? Infinity) - (y.at?.getTime() ?? Infinity);
  }
}

/**
 * The plan's order: items sorted by tier then by the tier's keys, grouped so
 * each account appears once at its highest tier. Urgent accounts first and
 * all of them, then at most ten of the rest. Ties keep the order the rows
 * came in, so the same data gives the same plan.
 */
export function rank(items: readonly Item[]): PlanAccount[] {
  const sorted = items
    .map((it, i) => ({ it, i }))
    .sort((p, q) => TIER_ORDER.indexOf(p.it.tier) - TIER_ORDER.indexOf(q.it.tier) || compareInTier(p.it, q.it) || p.i - q.i)
    .map((p) => p.it);
  const byAccount = new Map<string, PlanAccount>();
  for (const it of sorted) {
    const have = byAccount.get(it.accountId);
    if (have) have.items.push(it);
    else byAccount.set(it.accountId, { accountId: it.accountId, accountName: it.accountName, tier: it.tier, items: [it] });
  }
  const all = [...byAccount.values()];
  return [...all.filter((a) => URGENT.has(a.tier)), ...all.filter((a) => !URGENT.has(a.tier)).slice(0, OUTBOUND_MAX)];
}
