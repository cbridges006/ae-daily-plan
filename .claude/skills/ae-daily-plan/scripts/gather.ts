/**
 * Step 1: read the rep's book, ask Apollo only what the CRM cannot answer,
 * rank, and write what the model will be handed.
 *
 *   node scripts/gather.ts --org apollo-demo         live: Salesforce as the logged in user, Apollo with APOLLO_API_KEY
 *   node scripts/gather.ts --fixtures                no org, no key: the seeded book and recorded Apollo answers
 *
 * Writes, under ./out (git ignored, it holds names):
 *   plan.json         the ranked cards, every fact, the left out accounts and the proposed writes
 *   model-input.md    what the model writes from: one block per account, names as tokens
 *   tokens.json       token to name. The skill never opens it; check.ts does.
 *
 * Nothing is written to any system here.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Apollo, ApolloJob, ApolloNews, ApolloOrg, ApolloPerson } from "./lib/apollo.ts";
import { signalsFrom } from "./lib/signals.ts";
import { apollo, domainOf, mapJob, mapNews, mapOrg, mapPerson, readPeopleFile } from "./lib/apollo.ts";
import { CONTACT_FIELDS } from "./lib/contacts.ts";
import type { Card, Fetched, Plan, Rows } from "./lib/plan.ts";
import { build, needs } from "./lib/plan.ts";
import type { Icp } from "./lib/readiness.ts";
import { connect, q } from "./lib/sf.ts";
import { tokenize } from "./lib/tokens.ts";

// Keys live in a git ignored .env at the repository root, written once by the rep, so they never pass
// through a chat or a command line. Variables already set in the shell win.
try { process.loadEnvFile(new URL("../../../../.env", import.meta.url).pathname); } catch { /* no .env: use the shell */ }

const { values: arg } = parseArgs({
  options: {
    org: { type: "string" },
    fixtures: { type: "boolean", default: false },
    tz: { type: "string" },
    out: { type: "string", default: "out" },
    // Apollo people search is not on every plan (Basic has neither the API nor the MCP version), so it is off
    // unless asked for: "mcp" through Apollo's MCP server via Claude, "api" through the REST key.
    people: { type: "string", default: "off" },
  },
});

if (!["off", "mcp", "api"].includes(arg.people!)) { console.error(`STOPPED: --people takes off, mcp or api, not "${arg.people}"`); process.exit(2); }
const SKILL = new URL("..", import.meta.url).pathname;
const REPO = new URL("../../../../", import.meta.url).pathname;
const icp = JSON.parse(readFileSync(join(SKILL, "references/icp.json"), "utf8")) as Icp;
const now = new Date();

function stop(why: string): never {
  console.error(`STOPPED: ${why}`);
  process.exit(2);
}

/* ---------- Read the book ---------- */

let rows: Rows;
let rep: string;
let timeZone: string;
let instanceUrl: string | null = null;
let ask: Apollo | null = null;
const notChecked: string[] = [];

if (arg.fixtures) {
  timeZone = arg.tz ?? "America/Los_Angeles";
  rep = "Demo AE (fixtures)";
  const { toRows } = await import(join(REPO, "salesforce/seed/data.ts"));
  rows = toRows(now, timeZone);
  ask = fixtureApollo(JSON.parse(readFileSync(join(REPO, "salesforce/seed/apollo-fixtures.json"), "utf8")));
} else {
  if (!arg.org) stop("name the Salesforce org with --org <alias>, or use --fixtures");
  const sf = connect(arg.org);
  instanceUrl = sf.instanceUrl;
  const [user] = await sf.query<{ Id: string; Name: string; IsActive: boolean; TimeZoneSidKey: string | null }>(
    `SELECT Id, Name, IsActive, TimeZoneSidKey FROM User WHERE Username = ${q(sf.username)}`);
  // The gate. Fails closed: an unknown is a stop with its reason, never a guess.
  if (!user) stop(`no Salesforce user for ${sf.username}`);
  if (!user.IsActive) stop(`${user.Name} is not an active Salesforce user`);
  timeZone = arg.tz ?? user.TimeZoneSidKey ?? stop(`${user.Name} has no time zone in Salesforce, so "today" cannot be placed`);
  rep = user.Name;
  const owner = q(user.Id);
  const from = new Date(now.getTime() - 36 * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const to = new Date(now.getTime() + 36 * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const read = async <T,>(what: string, soql: string): Promise<T[]> => {
    try { return await sf.query<T>(soql); }
    catch (e) {
      // The book itself is required; everything else is "Not checked" and the plan goes on without it.
      if (what === "accounts") stop(`the book could not be read: ${(e as Error).message}`);
      notChecked.push(`Salesforce ${what} (${(e as Error).message.slice(0, 140)})`);
      return [];
    }
  };
  const [accounts, opps, contacts, calls, cases, events, overdueTasks] = await Promise.all([
    read<Rows["accounts"][number]>("accounts", `SELECT Id, Name, Website, Type, Target_Account__c, Readiness__c, Last_Enriched_by_Apollo__c, Last_Sales_Activity__c FROM Account WHERE OwnerId = ${owner}`),
    read<Rows["opps"][number]>("opportunities", `SELECT Id, AccountId, Name, Amount, CloseDate, StageName, IsClosed, IsWon, NextStep, Next_Step_Updated__c FROM Opportunity WHERE Account.OwnerId = ${owner}`),
    // MobilePhone is not in CONTACT_FIELDS, so it is never read and cannot reach a card.
    read<Rows["contacts"][number]>("contacts", `SELECT ${CONTACT_FIELDS.join(", ")} FROM Contact WHERE Account.OwnerId = ${owner}`),
    read<Rows["calls"][number]>("calls", `SELECT Id, Account__c, Name, Call_Start__c, Call_Brief__c, Next_Steps__c FROM Gong_Call__c WHERE Account__r.OwnerId = ${owner} ORDER BY Call_Start__c DESC`),
    read<Rows["cases"][number]>("support cases", `SELECT Id, AccountId, Subject, Priority, CreatedDate FROM Case WHERE IsClosed = false AND Account.OwnerId = ${owner}`),
    read<Rows["events"][number]>("meetings", `SELECT Id, AccountId, Subject, StartDateTime FROM Event WHERE OwnerId = ${owner} AND AccountId != null AND StartDateTime >= ${from} AND StartDateTime <= ${to}`),
    read<Rows["overdueTasks"][number]>("tasks", `SELECT Id, AccountId, Subject, ActivityDate FROM Task WHERE OwnerId = ${owner} AND IsClosed = false AND AccountId != null AND ActivityDate < TODAY`),
  ]);
  rows = { accounts, opps, contacts, calls, cases, events, overdueTasks };
  if (!accounts.length) stop(`${rep} owns no accounts in this org. Seed it with: node salesforce/seed/seed.ts --org ${arg.org}`);
  const key = process.env.APOLLO_API_KEY;
  if (key) ask = apollo(key);
  else notChecked.push("Apollo company data (APOLLO_API_KEY is not set)");
}

/* ---------- Ask Apollo only what the CRM cannot answer ---------- */

// Two routes, because Apollo's free plan splits them. Company enrichment goes
// through the REST API with a key. People search is paid on the REST API but
// free on Apollo's MCP server, which Claude calls while running the skill
// (OAuth as the rep, no credits) and hands back in out/apollo-people.json.
const want = needs(rows, icp, now, timeZone);
const got: Fetched = { orgs: new Map(), people: new Map() };
const outDir = join(process.cwd(), arg.out!);
mkdirSync(outDir, { recursive: true });
const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

// Each kind of Apollo call can be refused on its own (a plan may allow company
// data but not job postings), so a refusal stops that kind only and is said once.
const refusedKinds = new Map<string, string>();
const tryApollo = async <T,>(kind: string, label: string, f: () => Promise<T>): Promise<T | undefined> => {
  if (refusedKinds.has(kind)) return undefined;
  try { return await f(); }
  catch (e) {
    const msg = (e as Error).message;
    // A rep reads this line in Slack, so the reason is said in words; the full answer goes to the log.
    // Seen 11/13/2026: a key made without the news endpoint ticked put Apollo's raw JSON in the briefing.
    const why = /answered 401/.test(msg) ? "the API key was rejected" : /answered 403/.test(msg) ? "this API key is not allowed to call it" : "Apollo refused the request";
    if (/answered (401|403|422)/.test(msg)) { refusedKinds.set(kind, msg); notChecked.push(`Apollo ${kind} (${why})`); console.error(`Apollo ${kind}: ${msg.slice(0, 300)}`); }
    else notChecked.push(`Apollo ${kind} for ${label} (${msg.slice(0, 120)})`);
    return undefined;
  }
};

// A day cache: rerunning today's plan does not spend Apollo credits twice.
interface Cache { day: string; orgs: Record<string, ApolloOrg | null>; jobs: Record<string, ApolloJob[]>; news: Record<string, ApolloNews[]> }
const cachePath = join(outDir, "apollo-cache.json");
let cache: Cache = { day: today, orgs: {}, jobs: {}, news: {} };
if (!arg.fixtures) try { const c = JSON.parse(readFileSync(cachePath, "utf8")) as Cache; if (c.day === today) cache = c; } catch { /* no cache yet */ }
got.signals = new Map();

if (ask) {
  const todo = [...new Set(want.enrich.map((a) => domainOf(a.Website)!))].filter((d) => !(d in cache.orgs));
  for (let i = 0; i < todo.length; i += 10) {
    const chunk = todo.slice(i, i + 10);
    const r = await tryApollo("company data", chunk.join(", "), () => ask!.bulkEnrich(chunk));
    if (r) for (const d of chunk) cache.orgs[d] = r.get(d) ?? null;
  }
  for (const a of want.enrich) {
    const org = cache.orgs[domainOf(a.Website)!];
    if (!org) continue;
    got.orgs.set(a.Id, org);
    if (org.id) {
      const id = org.id;
      if (!(id in cache.jobs)) { const j = await tryApollo("job postings", a.Name, () => ask!.jobs(id)); if (j) cache.jobs[id] = j; }
      if (!(id in cache.news)) { const n = await tryApollo("news", a.Name, () => ask!.news(id)); if (n) cache.news[id] = n; }
    }
    got.signals.set(a.Id, signalsFrom(org, org.id && cache.jobs[org.id] ? cache.jobs[org.id]! : null, org.id ? cache.news[org.id] ?? [] : [], icp, now));
  }
  if (!arg.fixtures) writeFileSync(cachePath, JSON.stringify(cache));
}
const orgsChecked = !!ask && !refusedKinds.has("company data");

let peopleNeeded: { account: string; domain: string }[] = [];
if (arg.fixtures) {
  for (const a of want.people) got.people.set(a.Id, await ask!.searchPeople(domainOf(a.Website)!, icp.buyerTitles, icp.buyerSeniorities));
} else if (arg.people === "off") {
  if (want.people.length) notChecked.push(`Apollo people search (off: not in this Apollo plan) for ${want.people.map((a) => a.Name).join(", ")}`);
} else if (arg.people === "api" && ask) {
  for (const a of want.people) {
    const r = await tryApollo("people search", a.Name, () => ask!.searchPeople(domainOf(a.Website)!, icp.buyerTitles, icp.buyerSeniorities));
    if (r !== undefined) got.people.set(a.Id, r);
  }
} else {
  const found = readPeopleFile(join(outDir, "apollo-people.json"), today);
  for (const a of want.people) {
    const domain = domainOf(a.Website)!;
    const list = found?.[domain];
    if (list) got.people.set(a.Id, list.map(mapPerson).filter((p): p is ApolloPerson => !!p));
    else peopleNeeded.push({ account: a.Name, domain });
  }
  writeFileSync(join(outDir, "apollo-needed.json"), JSON.stringify({
    day: today, titles: icp.buyerTitles, seniorities: icp.buyerSeniorities, accounts: peopleNeeded,
  }, null, 2));
}

const plan: Plan = build(rows, got, icp, { now, timeZone, rep, instanceUrl, apolloChecked: orgsChecked });
// Replace the plan's generic Apollo lines with ones that say what to do about them.
const noKey = notChecked.some((n) => n.includes("APOLLO_API_KEY"));
if (peopleNeeded.length) notChecked.push(`Apollo people search, not run yet for ${peopleNeeded.map((p) => p.account).join(", ")}`);
const peopleOff = arg.people === "off" && !arg.fixtures;
plan.notChecked = [...new Set([...notChecked, ...plan.notChecked.filter((n) => !(n === "Apollo (people)" && (peopleNeeded.length || peopleOff)) && !(n === "Apollo (readiness)" && (noKey || refusedKinds.has("company data"))))])];

/* ---------- What the model is handed ---------- */

const tk = tokenize(plan.cards);
const contactLine = (c: Card): string => {
  if (c.contacts.kind !== "contacts") return "none to approach";
  const t = tk.tokenOf(c.key)!;
  return `[[${t}]]${c.contacts.primary.title ? `, ${c.contacts.primary.title}` : ""}${c.contacts.primary.source === "apollo" ? " (found in Apollo, not yet in Salesforce)" : ""}`;
};
const blocks = plan.cards.map((c) => [
  `KEY ${c.key}`,
  `Account: ${c.account}`,
  `Category: ${c.label}`,
  `Why now: ${tk.scrub(c.why)}`,
  `Contact: ${contactLine(c)}`,
  `Email: ${c.email.allowed ? "yes" : `no (${c.email.why})`}`,
  ...(c.meeting ? [`Meeting today: ${c.meeting}`] : []),
  `Prior conversation on record: ${c.priorTouch ? "yes" : "no"}`,
  "Facts:",
  ...c.facts.map((f) => `- ${tk.scrub(f)}`),
].join("\n"));

const input = `# What to write

You are writing the words in today's plan for ${icp.seller}, which sells ${icp.sells}.
The ranking, the contacts and the facts below are already decided. Do not change, add or reorder accounts.

Write one JSON array to out/written.json, with exactly one object per KEY below, in this shape:

\`\`\`json
{ "key": "<the KEY, exactly>", "call": "...", "next": "...", "email": { "subject": "...", "body": "..." } }
\`\`\`

- **call**: one or two spoken sentences to open a phone call, built on the why now.
- **next**: one concrete thing the rep does today. If a support case is open, the next step deals with the case first.
- **email**: only where the block says \`Email: yes\`. Otherwise \`"email": null\`.
  50 to 125 words, 2 to 4 sentences, no links. Start "Hi [[P#]]," with the contact's token exactly as given.
  Subject of at most 4 words containing the account name; the account name in the body too.
  Say why they are hearing from us and tie it to a business problem; about them, not about ${icp.seller}; no feature list.
  End with exactly one question as a low effort next step. No sign off.
- Where a block names a meeting, add **"meeting": { "opener": "...", "questions": ["...","...","..."], "objections": ["...","..."] }**.

Rules for every field:
- Use only the facts given. Never invent news, funding, numbers, names, titles, or a conversation that is not in the facts.
- Lines starting "Apollo" are company data, job postings and news from Apollo. A buyer team job posting is the best hook there is:
  name the role and when it was posted. Never build an email on bad news (a breach, a security flaw, a lawsuit, an investigation,
  layoffs); those are for the rep to know, not to pitch on.
  If "Prior conversation on record" is no, do not imply one.
- People appear only as tokens like [[P1]]. Write the token; never guess or invent a name.
- Do not quote field names or Salesforce ids to the customer.

${blocks.join("\n\n")}
`;

const out = outDir;
writeFileSync(join(out, "plan.json"), JSON.stringify(plan, null, 2));
writeFileSync(join(out, "tokens.json"), JSON.stringify(tk.map, null, 2));
writeFileSync(join(out, "model-input.md"), input);
// A written.json left from an earlier run would be checked against this plan; start it empty.
writeFileSync(join(out, "written.json"), "[]");

const s = (n: number, w: string, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;
console.log(`Plan for ${rep}, ${plan.day} (${timeZone})`);
console.log(`  ${s(plan.cards.length, "account")} in the plan: ${plan.cards.map((c) => `${c.account} (${c.label})`).join(", ") || "none"}`);
console.log(`  ${s(plan.leftOut.length, "account")} left out, each with its reason`);
const hiringSeen = [...got.signals.values()].filter((x) => x.buyerRoles.length).length;
console.log(`  Apollo: company data for ${s(got.orgs.size, "account")}${orgsChecked ? "" : " (not checked)"}, buyer team hiring at ${s(hiringSeen, "account")}, people found for ${s(got.people.size, "account")}`);
console.log(`  ${s(plan.writes.length, "write")} proposed so far (nothing written)`);
console.log(`  Not checked: ${plan.notChecked.join("; ") || "nothing"}`);
if (peopleNeeded.length) {
  console.log(`APOLLO PEOPLE SEARCH NEEDED for ${peopleNeeded.map((p) => `${p.account} (${p.domain})`).join(", ")}.`);
  console.log(`  Search each with Apollo's MCP server as ${arg.out}/apollo-needed.json describes, write ${arg.out}/apollo-people.json, then run gather.ts again.`);
} else console.log(`Next: write ${arg.out}/written.json from ${arg.out}/model-input.md, then run check.ts`);

/* ---------- Recorded Apollo answers, for --fixtures ---------- */

function fixtureApollo(f: { organizations: Record<string, Record<string, unknown>>; people: Record<string, Record<string, unknown>[]>; jobs?: Record<string, Record<string, unknown>[]>; news?: Record<string, Record<string, unknown>[]> }): Apollo {
  // Relative dates in the fixture ({{months_ago:7}}, {{days_ago:9}}) keep it reading the same on any day.
  const rel = (v: unknown): unknown => {
    const m = typeof v === "string" ? /^\{\{(months|days)_ago:(\d+)\}\}$/.exec(v) : null;
    if (!m) return v;
    const d = new Date(now);
    if (m[1] === "months") d.setMonth(d.getMonth() - Number(m[2])); else d.setDate(d.getDate() - Number(m[2]));
    return d.toISOString();
  };
  const fix = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, rel(v)]));
  const byId = (id: string) => Object.entries(f.organizations).find(([, o]) => o.id === id)?.[0] ?? "";
  return {
    async enrichOrg(domain): Promise<ApolloOrg | null> {
      const o = f.organizations[domain];
      return o ? mapOrg(domain, fix(o)) : null;
    },
    async bulkEnrich(domains) {
      return new Map(domains.filter((d) => f.organizations[d]).map((d) => [d, mapOrg(d, fix(f.organizations[d]!))]));
    },
    async jobs(orgId) { return (f.jobs?.[byId(orgId)] ?? []).map((j) => mapJob(fix(j))).filter((j): j is ApolloJob => !!j); },
    async news(orgId) { return (f.news?.[byId(orgId)] ?? []).map((n) => mapNews(fix(n))).filter((n): n is ApolloNews => !!n); },
    async searchPeople(domain): Promise<ApolloPerson[]> {
      return (f.people[domain] ?? []).map(mapPerson).filter((p): p is ApolloPerson => !!p);
    },
  };
}
