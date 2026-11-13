import { readFileSync } from "node:fs";

/**
 * Apollo: the company facts readiness is scored on, and the people map.
 *
 * Two calls. `enrichOrg` spends a credit per company, so the caller only
 * asks for accounts whose readiness is blank or stale and caches a day.
 * `searchPeople` is Apollo's credit free search: it returns who holds a
 * title at a domain but no email address, which is why a person found here
 * is a call or a "reveal in Apollo" step, never an email, until a rep adds
 * the address.
 *
 * The mappers read each field through several spellings and return null for
 * anything absent. Readiness then says "Not checked" for that fact. A wrong
 * guess at a field name would otherwise read as "no growth" on every account.
 */

export interface ApolloOrg {
  id: string | null;
  name: string | null;
  domain: string;
  employees: number | null;
  industry: string | null;
  country: string | null;
  /** Headcount change over twelve months, as a fraction (0.12 is 12%). */
  growth12m: number | null;
  lastFundingDate: string | null;
  lastFundingStage: string | null;
}

export interface ApolloPerson {
  id: string;
  firstName: string;
  lastName: string;
  title: string | null;
  seniority: string | null;
  email: string | null;
  linkedinUrl: string | null;
}

/** An open role, from Apollo's job postings for a company. */
export interface ApolloJob { title: string; postedAt: string | null; url: string | null; location: string | null }
/** A news article Apollo has tied to a company. */
export interface ApolloNews { title: string; publishedAt: string | null; url: string | null; source: string | null }

export interface Apollo {
  enrichOrg(domain: string): Promise<ApolloOrg | null>;
  /** Up to ten domains in one call. Domains Apollo does not know are absent from the map. */
  bulkEnrich(domains: readonly string[]): Promise<Map<string, ApolloOrg>>;
  jobs(orgId: string): Promise<ApolloJob[]>;
  news(orgId: string): Promise<ApolloNews[]>;
  searchPeople(domain: string, titles: readonly string[], seniorities: readonly string[]): Promise<ApolloPerson[]>;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const first = (o: Raw, ...keys: string[]): unknown => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return null; };

export function mapOrg(domain: string, o: Raw): ApolloOrg {
  return {
    id: str(o.id),
    name: str(o.name),
    domain,
    employees: num(first(o, "estimated_num_employees", "num_employees", "employee_count")),
    industry: str(o.industry),
    country: str(first(o, "country", "hq_country")),
    growth12m: num(first(o, "organization_headcount_twelve_month_growth", "headcount_twelve_month_growth", "twelve_month_growth")),
    lastFundingDate: str(first(o, "latest_funding_round_date", "last_funding_date")),
    lastFundingStage: str(first(o, "latest_funding_stage", "last_funding_stage")),
  };
}

export function mapPerson(p: Raw): ApolloPerson | null {
  const id = str(p.id);
  if (!id) return null;
  return {
    id,
    firstName: str(p.first_name) ?? "",
    // The free search hides surnames behind an obfuscated field; keep what it gives and say so on the card.
    lastName: str(first(p, "last_name", "last_name_obfuscated")) ?? "",
    title: str(p.title),
    seniority: str(p.seniority),
    email: ((e) => (e && !/not_unlocked|email_not/i.test(e) ? e : null))(str(p.email)),
    linkedinUrl: str(p.linkedin_url),
  };
}

export function mapJob(j: Raw): ApolloJob | null {
  const title = str(j.title);
  if (!title) return null;
  return { title, postedAt: str(first(j, "posted_at", "created_at")), url: str(j.url), location: [str(j.city), str(j.state), str(j.country)].filter(Boolean).join(", ") || null };
}

export function mapNews(n: Raw): ApolloNews | null {
  const title = str(n.title);
  if (!title) return null;
  return { title, publishedAt: str(first(n, "published_at", "publish_date", "created_at")), url: str(n.url), source: str(n.domain) };
}

const BASE = "https://api.apollo.io/api/v1";

/** A real client. Errors are thrown with the status and Apollo's own words, never swallowed into an empty result. */
export function apollo(apiKey: string, fetchImpl: typeof fetch = fetch): Apollo {
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Raw> {
    const res = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: { "x-api-key": apiKey, "content-type": "application/json", "cache-control": "no-cache" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Apollo ${method} ${path.split("?")[0]} answered ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as Raw;
  }
  return {
    async enrichOrg(domain) {
      const r = await call("GET", `/organizations/enrich?domain=${encodeURIComponent(domain)}`);
      const o = r.organization as Raw | undefined;
      return o ? mapOrg(domain, o) : null;
    },
    async bulkEnrich(domains) {
      const r = await call("POST", "/organizations/bulk_enrich", { domains });
      const out = new Map<string, ApolloOrg>();
      for (const o of (r.organizations ?? []) as Raw[]) {
        const d = str(o.primary_domain)?.toLowerCase();
        // Apollo answers with each company's primary domain, which can differ from the one asked (about.gitlab.com).
        const asked = domains.find((x) => x === d || (d && (x.endsWith(`.${d}`) || d.endsWith(`.${x}`)))) ?? d;
        if (asked) out.set(asked, mapOrg(asked, o));
      }
      return out;
    },
    async jobs(orgId) {
      // The first page of 100 holds the newest postings; older ones are past the 60 day window anyway.
      const r = await call("GET", `/organizations/${encodeURIComponent(orgId)}/job_postings?per_page=100`);
      return ((r.organization_job_postings ?? []) as Raw[]).map(mapJob).filter((j): j is ApolloJob => !!j);
    },
    async news(orgId) {
      const r = await call("POST", "/news_articles/search", { organization_ids: [orgId], per_page: 10 });
      return ((r.news_articles ?? []) as Raw[]).map(mapNews).filter((n): n is ApolloNews => !!n);
    },
    async searchPeople(domain, titles, seniorities) {
      const r = await call("POST", "/mixed_people/api_search", {
        q_organization_domains_list: [domain], person_titles: titles, person_seniorities: seniorities, page: 1, per_page: 10,
      });
      const rows = (r.people ?? r.contacts ?? []) as Raw[];
      return rows.map(mapPerson).filter((p): p is ApolloPerson => !!p);
    },
  };
}

/** The bare domain of a website field: "https://www.acme.com/about" is "acme.com". Null when there is nothing usable. */
export function domainOf(website: string | null | undefined): string | null {
  if (!website) return null;
  const m = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/i.exec(website.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Today's people search results, by domain, as Claude wrote them from Apollo's
 * MCP server. Yesterday's file is ignored: who works where changes, and a
 * plan should say "not run yet" rather than reuse a stale search.
 */
export function readPeopleFile(path: string, day: string): Record<string, Record<string, unknown>[]> | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  const f = raw as { day?: string; byDomain?: Record<string, unknown> };
  if (f.day !== day || !f.byDomain || typeof f.byDomain !== "object") return null;
  return Object.fromEntries(Object.entries(f.byDomain).filter(([, v]) => Array.isArray(v))) as Record<string, Record<string, unknown>[]>;
}
