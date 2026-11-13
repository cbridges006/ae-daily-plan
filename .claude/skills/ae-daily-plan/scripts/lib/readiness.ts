/**
 * Readiness: A (act this month), B (act this quarter) or C (nurture), from
 * Apollo's company facts held against the ICP in references/icp.json.
 *
 * Rules, not a model and not a weighted score. A company that misses a must
 * have is C. One that meets them all is A with two or more timing signals
 * and B otherwise. Every letter carries the reasons that produced it, and a
 * fact Apollo did not return is reported as not checked rather than counted
 * as a miss, so a thin record lands on B with its gaps showing, not on C.
 */
import type { ApolloOrg } from "./apollo.ts";

export interface Icp {
  seller: string;
  sells: string;
  employees: { min: number; max: number };
  industries: string[];
  countries: string[];
  buyerTitles: string[];
  buyerSeniorities: string[];
  signals: { growth12mAtLeast: number; fundedWithinMonths: number; hiringWithinDays?: number; salesRolesAtLeast?: number; newsWithinDays?: number };
  salesRoleTitles?: string[];
}

export interface Scored {
  letter: "A" | "B" | "C";
  reasons: string[];
  notChecked: string[];
}

const pct = (f: number): string => `${Math.round(f * 100)}%`;
const monthsBetween = (from: Date, to: Date): number => (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());

/** Hiring counts from Apollo's job postings, when they were read. */
export interface Hiring { buyerRoles: number; salesRoles: number }

export function score(org: ApolloOrg, icp: Icp, now: Date, hiring?: Hiring): Scored {
  const reasons: string[] = [];
  const notChecked: string[] = [];
  let miss = false;

  if (org.employees === null) notChecked.push("employee count");
  else if (org.employees < icp.employees.min || org.employees > icp.employees.max) { miss = true; reasons.push(`${org.employees.toLocaleString("en-US")} employees, outside ${icp.employees.min.toLocaleString("en-US")} to ${icp.employees.max.toLocaleString("en-US")}`); }
  else reasons.push(`${org.employees.toLocaleString("en-US")} employees, in range`);

  if (org.industry === null) notChecked.push("industry");
  else if (!icp.industries.some((i) => org.industry!.toLowerCase().includes(i.toLowerCase()))) { miss = true; reasons.push(`industry "${org.industry}" is not in the ICP`); }
  else reasons.push(`industry "${org.industry}"`);

  if (org.country === null) notChecked.push("country");
  else if (!icp.countries.some((c) => c.toLowerCase() === org.country!.toLowerCase())) { miss = true; reasons.push(`based in ${org.country}, outside the ICP`); }

  if (miss) return { letter: "C", reasons, notChecked };

  let signals = 0;
  if (org.growth12m === null) notChecked.push("headcount growth");
  else if (org.growth12m >= icp.signals.growth12mAtLeast) { signals++; reasons.push(`headcount up ${pct(org.growth12m)} in twelve months`); }
  else reasons.push(`headcount ${Math.abs(org.growth12m) < 0.005 ? "flat" : `${org.growth12m >= 0 ? "up" : "down"} ${pct(Math.abs(org.growth12m))}`} over twelve months`);

  const funded = org.lastFundingDate ? new Date(org.lastFundingDate) : null;
  // Apollo reports an acquisition as the latest "funding stage" (Smartsheet, live). Being bought is not raising money.
  if (org.lastFundingStage && /merger|acquisition|acquired|ipo|private equity|buyout/i.test(org.lastFundingStage)) reasons.push(`last funding event was ${org.lastFundingStage}, not a raise`);
  else if (!funded || Number.isNaN(funded.getTime())) notChecked.push("recent funding");
  else if (monthsBetween(funded, now) <= icp.signals.fundedWithinMonths) { signals++; reasons.push(`raised ${org.lastFundingStage ?? "funding"} ${monthsBetween(funded, now)} months ago`); }

  if (!hiring) notChecked.push("hiring");
  else {
    if (hiring.buyerRoles > 0) { signals++; reasons.push(`hiring ${hiring.buyerRoles} buyer team role${hiring.buyerRoles === 1 ? "" : "s"}`); }
    if (hiring.salesRoles >= (icp.signals.salesRolesAtLeast ?? 3)) { signals++; reasons.push(`${hiring.salesRoles} open sales roles`); }
  }

  return { letter: signals >= 2 ? "A" : "B", reasons, notChecked };
}
