/**
 * What Apollo says is happening at a company, turned into facts a rep can
 * check: who they are hiring, how fast the sales team is growing, and what
 * was in the news. Pure, so every rule is a test.
 *
 * Buyer team hiring is the strongest signal this seller has: a company
 * posting a sales operations role is building the team that buys revenue
 * operations software, and the posting is a public, dated fact an email can
 * stand on. Measured on Braze, 11/12/2026: 298 postings, of which two were
 * "Sales Operations Systems and Data Lead" (Oct 23). A first filter on "gtm"
 * also caught a product marketing role, so only the ICP's own buyer titles
 * count.
 */
import type { ApolloJob, ApolloNews, ApolloOrg } from "./apollo.ts";
import { inBuyingTeam } from "./contacts.ts";
import type { Icp } from "./readiness.ts";

export interface Signals {
  company: ApolloOrg | null;
  /** Open roles in the buyer team, newest first, posted inside the window. */
  buyerRoles: ApolloJob[];
  /** Open sales roles posted inside the window. */
  salesRoles: number;
  news: ApolloNews[];
  /** False when job postings could not be read, so hiring is "not checked", never "none". */
  hiringRead: boolean;
}

const DAY = 86_400_000;
const within = (iso: string | null, now: Date, days: number): boolean => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && now.getTime() - t <= days * DAY && t <= now.getTime() + DAY;
};

const CITIES = ["New York City", "New York", "San Francisco", "Chicago", "London", "Toronto", "Berlin"];
/**
 * The role as a person would say it. Greenhouse postings reach Apollo with the board's suffix glued on:
 * "Sales Operations Systems and Data Lead Chicago", "Director, Sales Strategy & Operations New Atlanta",
 * "Americas Sales Business Partner Manager New Remote - US" (all from the live run on 11/13/2026).
 */
export function roleTitle(j: Pick<ApolloJob, "title" | "location">): string {
  let t = j.title.trim().replace(/\s+(New\s+)?Remote(\s*-\s*.*)?$/i, "");
  const city = j.location?.split(",")[0]?.trim();
  for (const c of [city, ...CITIES]) {
    if (c && t.toLowerCase().endsWith(` ${c.toLowerCase()}`)) { t = t.slice(0, -c.length - 1); break; }
  }
  return t.replace(/\s+New$/, "").replace(/\s*[-,]\s*$/, "").trim();
}

export function signalsFrom(company: ApolloOrg | null, jobs: readonly ApolloJob[] | null, news: readonly ApolloNews[], icp: Icp, now: Date): Signals {
  const days = icp.signals.hiringWithinDays ?? 60;
  const fresh = (jobs ?? []).filter((j) => within(j.postedAt, now, days)).map((j) => ({ ...j, title: roleTitle(j) }));
  // The same role is often posted once per city; one title is one role.
  const seen = new Set<string>();
  const buyerRoles = fresh
    .filter((j) => inBuyingTeam(j.title, icp.buyerTitles))
    .sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""))
    .filter((j) => { const k = j.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const salesRoles = fresh.filter((j) => inBuyingTeam(j.title, icp.salesRoleTitles ?? []) && !inBuyingTeam(j.title, icp.buyerTitles)).length;
  const titles = new Set<string>();
  // Apollo ties articles to a company loosely ("MCP's first data leaks" came back for Asana), so a headline
  // has to name the company to count.
  const name = company?.name?.toLowerCase().replace(/,?\s+(inc|corp|corporation|ltd|llc)\.?$/, "") ?? null;
  const recent = news
    .filter((n) => within(n.publishedAt, now, icp.signals.newsWithinDays ?? 60))
    .filter((n) => !name || n.title.toLowerCase().includes(name))
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .filter((n) => { const k = n.title.toLowerCase().slice(0, 60); if (titles.has(k)) return false; titles.add(k); return true; })
    .slice(0, 2);
  return { company, buyerRoles, salesRoles, news: recent, hiringRead: jobs !== null };
}

const day = (iso: string | null): string => (iso ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(iso)) : "date unknown");
const monthYear = (iso: string): string => new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
/** Under half a percent either way reads as flat; "down 0%" was what Asana got on the first live run. */
export const growthWords = (f: number): string => (Math.abs(f) < 0.005 ? "flat" : `${f >= 0 ? "up" : "down"} ${Math.abs(Math.round(f * 100))}%`);

/** One headline title per news article, cleaned of trademark marks and trailing ticker noise, never reworded. */
const headline = (t: string): string => t.replace(/\((r|tm|c)\)/gi, "").replace(/\s*\|\s*[A-Z]{2,5} stock news\.?$/i, "").replace(/\s+/g, " ").trim().slice(0, 120);

/** The facts a card shows, each labeled as Apollo's so a rep knows where it came from. */
export function signalFacts(s: Signals): string[] {
  const out: string[] = [];
  const c = s.company;
  if (c) {
    const parts = [
      c.employees !== null ? `${c.employees.toLocaleString("en-US")} employees` : null,
      c.growth12m !== null ? `headcount ${growthWords(c.growth12m)} over 12 months` : null,
      c.industry,
      c.lastFundingStage ? `last funding event: ${c.lastFundingStage}${c.lastFundingDate ? `, ${monthYear(c.lastFundingDate)}` : ""}` : null,
    ].filter(Boolean);
    if (parts.length) out.push(`Apollo company data: ${parts.join(", ")}`);
  }
  if (s.buyerRoles.length) {
    const [a, ...rest] = s.buyerRoles;
    out.push(`Apollo hiring: "${a!.title}", posted ${day(a!.postedAt)}${rest.length ? `, and ${rest.length} more buyer team role${rest.length === 1 ? "" : "s"}` : ""}`);
  }
  if (s.salesRoles) out.push(`Apollo hiring: ${s.salesRoles} open sales role${s.salesRoles === 1 ? "" : "s"} in the last 60 days`);
  for (const n of s.news) out.push(`Apollo news, ${day(n.publishedAt)}${n.source ? ` (${n.source})` : ""}: "${headline(n.title)}"`);
  return out;
}

/** The why now line a buyer team posting earns, or null. */
export function hiringWhy(s: Signals | undefined): string | null {
  const r = s?.buyerRoles[0];
  return r ? `they are hiring a ${r.title} (posted ${day(r.postedAt)})` : null;
}
