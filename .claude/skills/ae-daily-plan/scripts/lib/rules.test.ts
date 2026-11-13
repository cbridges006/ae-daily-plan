/**
 * The rules that decide the plan. Each test was broken on purpose once and
 * watched fail before it was trusted; the README lists which and how.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApolloPerson } from "./apollo.ts";
import { domainOf, mapOrg, mapPerson, readPeopleFile } from "./apollo.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContactRow } from "./contacts.ts";
import { CONTACT_FIELDS, contactPlan } from "./contacts.ts";
import { problems } from "./guidance.ts";
import type { Item } from "./rank.ts";
import { OUTBOUND_MAX, rank, readinessLetter, staleNextStep, storedReadiness } from "./rank.ts";
import type { Icp } from "./readiness.ts";
import { score } from "./readiness.ts";
import { reveal, tokenize } from "./tokens.ts";
import { hiringWhy, roleTitle, signalFacts, signalsFrom } from "./signals.ts";
import { readFileSync } from "node:fs";

const NOW = new Date("2026-11-12T20:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const BUYERS = ["revenue operations", "sales operations"];

describe("rank", () => {
  it("a next step 14 days old is not stale; 15 is", () => {
    assert.equal(staleNextStep(daysAgo(14), NOW).stale, false);
    assert.equal(staleNextStep(daysAgo(15), NOW).stale, true);
  });

  it("readiness is read by its leading letter, and Active is not an A", () => {
    assert.equal(readinessLetter("A: act this month"), "A");
    assert.equal(readinessLetter(" b"), "B");
    assert.equal(readinessLetter("Active"), null);
  });

  it("a readiness letter older than 30 days is not used, and says why", () => {
    const r = storedReadiness({ Id: "1", Name: "X", Readiness__c: "A", Last_Enriched_by_Apollo__c: daysAgo(31) }, NOW);
    assert.equal(r.usable, false);
    assert.match(!r.usable ? r.why : "", /31 days ago/);
    assert.equal(storedReadiness({ Id: "1", Name: "X", Readiness__c: "A", Last_Enriched_by_Apollo__c: daysAgo(30) }, NOW).usable, true);
  });

  it("an open deal outranks outbound, an overdue task outranks a bigger deal, and each account appears once", () => {
    const items: Item[] = [
      { accountId: "o", accountName: "Out", tier: "outbound", why: "", facts: [], keys: { readiness: "A" } },
      { accountId: "big", accountName: "Big", tier: "pipeline", why: "", facts: [], keys: { amount: 500_000 } },
      { accountId: "late", accountName: "Late", tier: "pipeline", why: "", facts: [], keys: { amount: 10_000, overdueTask: true } },
      { accountId: "big", accountName: "Big", tier: "meeting", why: "", facts: [], keys: {} },
    ];
    const r = rank(items);
    assert.deepEqual(r.map((a) => a.accountId), ["late", "big", "o"]);
    assert.equal(r.find((a) => a.accountId === "big")!.items.length, 2);
  });

  it("outbound is capped at ten; urgent work is not", () => {
    const items: Item[] = [
      ...Array.from({ length: 12 }, (_, i): Item => ({ accountId: `p${i}`, accountName: "", tier: "pipeline", why: "", facts: [] })),
      ...Array.from({ length: 15 }, (_, i): Item => ({ accountId: `o${i}`, accountName: "", tier: "outbound", why: "", facts: [] })),
    ];
    const r = rank(items);
    assert.equal(r.filter((a) => a.tier === "pipeline").length, 12);
    assert.equal(r.filter((a) => a.tier === "outbound").length, OUTBOUND_MAX);
  });
});

describe("contacts", () => {
  const c = (over: Partial<ContactRow>): ContactRow => ({ Id: "003", AccountId: "001", FirstName: "Ana", LastName: "Diaz", Title: "VP Revenue Operations", Email: "ana@x.example", HasOptedOutOfEmail: false, Left_Company__c: false, ...over });

  it("nobody who opted out, left, or sits outside the buying team is ever a contact", () => {
    for (const bad of [{ HasOptedOutOfEmail: true }, { Left_Company__c: true }, { Title: "Software Engineer" }]) {
      assert.equal(contactPlan([c(bad)], [], BUYERS).kind, "research", JSON.stringify(bad));
    }
  });

  it("a missing opt out flag is not permission", () => {
    assert.equal(contactPlan([c({ HasOptedOutOfEmail: null })], [], BUYERS).kind, "research");
  });

  it("Apollo never brings back somebody the CRM already holds, matched by name, email or Apollo id", () => {
    const optedOut = c({ HasOptedOutOfEmail: true, Apollo_Id__c: "ap1" });
    const again: ApolloPerson[] = [
      { id: "ap2", firstName: "Ana", lastName: "Diaz", title: "VP Revenue Operations", seniority: "vp", email: null, linkedinUrl: null },
      { id: "ap1", firstName: "A.", lastName: "D.", title: "VP Revenue Operations", seniority: "vp", email: null, linkedinUrl: null },
    ];
    assert.equal(contactPlan([optedOut], again, BUYERS).kind, "research");
  });

  it("CRM contacts come first and Apollo fills the empty seats", () => {
    const found: ApolloPerson[] = [{ id: "ap9", firstName: "Lee", lastName: "Fox", title: "Director of Sales Operations", seniority: "director", email: null, linkedinUrl: null }];
    const p = contactPlan([c({})], found, BUYERS);
    assert.equal(p.kind, "contacts");
    if (p.kind !== "contacts") return;
    assert.equal(p.primary.source, "salesforce");
    assert.equal(p.alternates[0]!.source, "apollo");
  });

  it("with nobody safe and Apollo not asked, the plan says people search was not run", () => {
    const p = contactPlan([], null, BUYERS);
    assert.match(p.kind === "research" ? p.why : "", /Apollo people search was not run/);
  });

  it("MobilePhone is never queried, so it cannot reach a card", () => {
    assert.ok(!CONTACT_FIELDS.includes("MobilePhone"));
  });
});

describe("email checks", () => {
  const body = (words: number, extra = "") => `Hi Ana,\n\nAcme ${"word ".repeat(words - 3).trim()}. ${extra}Would a short call help?`;
  const ok = { subject: "Acme forecast", body: body(60) };

  it("a good email passes", () => {
    assert.deepEqual(problems(ok, { accountName: "Acme", priorTouch: false }), []);
  });

  it("over 125 words, two links, or two questions is dropped", () => {
    assert.ok(problems({ ...ok, body: body(140) }, { accountName: "Acme", priorTouch: false }).some((p) => /words/.test(p)));
    assert.ok(problems({ ...ok, body: body(60, "See https://a.example and https://b.example. ") }, { accountName: "Acme", priorTouch: false }).some((p) => /links/.test(p)));
    assert.ok(problems({ ...ok, body: body(60, "Is it working? ") }, { accountName: "Acme", priorTouch: false }).some((p) => /questions/.test(p)));
  });

  it("claiming a conversation that is not on record is dropped, and allowed when one is", () => {
    const claim = { ...ok, body: body(60, "As we discussed, the board wants this. ") };
    assert.ok(problems(claim, { accountName: "Acme", priorTouch: false }).some((p) => /prior conversation/.test(p)));
    assert.ok(!problems(claim, { accountName: "Acme", priorTouch: true }).some((p) => /prior conversation/.test(p)));
  });

  it("an unrevealed name token is dropped as an unfilled merge token", () => {
    assert.ok(problems({ ...ok, body: ok.body.replace("Ana", "[[P7]]") }, { accountName: "Acme", priorTouch: false }).some((p) => /merge token/.test(p)));
  });

  it("a body that opens with Thanks is a sentence, not a sign off; a short closing line is", () => {
    // Found on the first live run: "Thanks for reviewing the proposal..." was read as a sign off, the
    // whole body was discarded, and a good four sentence email was dropped for having zero sentences.
    const opensWithThanks = { subject: "Acme pricing", body: "Hi Ana,\n\nThanks for reviewing the Acme proposal with us on Nov 6. You asked for pricing at 300 seats rather than 250 before it goes to finance. I am finalizing the revised numbers today so the finance review is not held up. Would a short side by side of the two seat counts help?" };
    assert.deepEqual(problems(opensWithThanks, { accountName: "Acme", priorTouch: true }), []);
    assert.deepEqual(problems({ ...opensWithThanks, body: `${opensWithThanks.body}\n\nThanks,\nDana` }, { accountName: "Acme", priorTouch: true }), []);
  });

  it("the account name must be in the subject and the body", () => {
    assert.ok(problems({ ...ok, subject: "Quick question" }, { accountName: "Acme", priorTouch: false }).some((p) => /subject/.test(p)));
  });
});

describe("readiness from Apollo", () => {
  const icp: Icp = { seller: "S", sells: "s", employees: { min: 200, max: 5000 }, industries: ["software"], countries: ["United States"], buyerTitles: [], buyerSeniorities: [], signals: { growth12mAtLeast: 0.1, fundedWithinMonths: 12 } };
  const org = { id: null, name: "X", domain: "x.com", employees: 800, industry: "computer software", country: "United States", growth12m: 0.2, lastFundingDate: "2026-06-01", lastFundingStage: "Series C" };

  it("two timing signals make an A, one makes a B, a missed must have makes a C", () => {
    assert.equal(score(org, icp, NOW).letter, "A");
    assert.equal(score({ ...org, lastFundingDate: "2024-01-01" }, icp, NOW).letter, "B");
    assert.equal(score({ ...org, employees: 9000 }, icp, NOW).letter, "C");
  });

  it("a fact Apollo did not return is not checked, never counted as a miss", () => {
    const s = score({ ...org, employees: null, industry: null, growth12m: null, lastFundingDate: null }, icp, NOW);
    assert.equal(s.letter, "B");
    assert.deepEqual(s.notChecked.sort(), ["employee count", "headcount growth", "hiring", "industry", "recent funding"]);
  });

  it("buyer team hiring counts as a timing signal; hiring not read is not checked, not zero", () => {
    const slow = { ...org, growth12m: 0.01, lastFundingDate: "2024-01-01" };
    assert.equal(score(slow, icp, NOW, { buyerRoles: 1, salesRoles: 5 }).letter, "A");
    assert.equal(score(slow, icp, NOW, { buyerRoles: 0, salesRoles: 0 }).letter, "B");
    assert.ok(score(slow, icp, NOW).notChecked.includes("hiring"));
  });

  it("maps Apollo's field names, and a locked email is no email", () => {
    assert.equal(mapOrg("x.com", { estimated_num_employees: "740", organization_headcount_twelve_month_growth: 0.12 }).employees, 740);
    assert.equal(mapPerson({ id: "1", first_name: "A", last_name: "B", email: "email_not_unlocked@domain.com" })!.email, null);
    assert.equal(domainOf("https://www.Twilio.com/about"), "twilio.com");
  });
});

describe("signals from Apollo job postings and news", () => {
  const icp2 = { ...JSON.parse(readFileSync(new URL("../../references/icp.json", import.meta.url), "utf8")) } as Icp;
  const job = (title: string, daysOld: number) => ({ title, postedAt: daysAgo(daysOld), url: null, location: null });

  it("only the ICP's buyer titles count as buyer team hiring, deduped across cities, inside 60 days", () => {
    const s = signalsFrom(null, [
      job("Sales Operations Systems and Data Lead Chicago", 20),
      job("Sales Operations Systems and Data Lead New York City", 20),
      job("Senior Director, GTM Product Marketing", 21),
      job("Revenue Operations Manager", 90),
      job("Account Executive, Mid Market", 5), job("Sales Development Representative", 6), job("Enterprise Account Executive", 7),
    ], [], icp2, NOW);
    assert.deepEqual(s.buyerRoles.map((r) => r.title), ["Sales Operations Systems and Data Lead"]);
    assert.equal(s.salesRoles, 3);
    assert.match(hiringWhy(s)!, /^they are hiring a Sales Operations Systems and Data Lead \(posted /);
  });

  it("a posting's board suffix (city, New, Remote) is cut from the role, and a real title is left alone", () => {
    const t = (title: string, location: string | null = null) => roleTitle({ title, location });
    assert.equal(t("Director, Sales Strategy & Operations New Atlanta", "Atlanta, Georgia, United States"), "Director, Sales Strategy & Operations");
    assert.equal(t("Americas Sales Business Partner Manager New Remote - US", "United States"), "Americas Sales Business Partner Manager");
    assert.equal(t("GTM Operations Manager, Lead Operations", "Toronto, Ontario, Canada"), "GTM Operations Manager, Lead Operations");
    assert.equal(t("Head of Revenue Operations"), "Head of Revenue Operations");
    assert.equal(t("Remote Sales Operations Lead"), "Remote Sales Operations Lead");
  });

  it("job postings that could not be read leave hiring not checked", () => {
    assert.equal(signalsFrom(null, null, [], icp2, NOW).hiringRead, false);
  });

  it("a headline that does not name the company is dropped", () => {
    const n = (title: string) => ({ title, publishedAt: daysAgo(2), url: null, source: null });
    const s = signalsFrom({ id: "1", name: "Asana", domain: "asana.com", employees: null, industry: null, country: null, growth12m: null, lastFundingDate: null, lastFundingStage: null }, [], [n("Asana names a partner of the year"), n("MCP's first data leaks")], icp2, NOW);
    assert.deepEqual(s.news.map((x) => x.title), ["Asana names a partner of the year"]);
  });

  it("an email built on bad news is dropped", () => {
    const body = "Hi Ana,\n\nI saw the security flaw Acme disclosed was exploited this week, which must make planning hard for your revenue operations team right now. We help teams keep forecasts steady when the quarter gets disrupted by events like this one. Would a short call this week be useful for you?";
    assert.ok(problems({ subject: "Acme forecast", body }, { accountName: "Acme", priorTouch: false }).some((p) => /bad news/.test(p)));
  });

  it("an acquisition is not a raise, and tiny growth reads as flat", () => {
    const acquired = { id: null, name: "X", domain: "x.com", employees: 800, industry: "computer software", country: "United States", growth12m: -0.0005, lastFundingDate: daysAgo(60), lastFundingStage: "Merger / Acquisition" };
    const s = score(acquired, icp2, NOW, { buyerRoles: 0, salesRoles: 0 });
    assert.equal(s.letter, "B");
    assert.ok(s.reasons.some((r) => /not a raise/.test(r)));
    assert.ok(s.reasons.some((r) => /headcount flat/.test(r)));
  });

  it("news keeps two recent headlines, cleaned but never reworded, and drops old ones", () => {
    const n = (title: string, d: number) => ({ title, publishedAt: daysAgo(d), url: null, source: "example.com" });
    const s = signalsFrom(null, [], [n("Acme named a leader in the gartner(r) magic quadrant(tm) | ACME stock news.", 3), n("Acme opens London office", 10), n("Acme old news", 200), n("Third item", 12)], icp2, NOW);
    const facts = signalFacts(s);
    assert.equal(facts.length, 2);
    assert.match(facts[0]!, /"Acme named a leader in the gartner magic quadrant"$/);
  });
});

describe("people found through Apollo's MCP", () => {
  const file = (body: unknown) => { const p = join(mkdtempSync(join(tmpdir(), "ae-")), "apollo-people.json"); writeFileSync(p, JSON.stringify(body)); return p; };

  it("today's search is read by domain", () => {
    const r = readPeopleFile(file({ day: "2026-11-12", byDomain: { "braze.com": [{ id: "1", first_name: "A" }] } }), "2026-11-12");
    assert.equal(r!["braze.com"]!.length, 1);
  });

  it("yesterday's search is ignored, so the plan says not run instead of reusing it", () => {
    assert.equal(readPeopleFile(file({ day: "2026-11-11", byDomain: { "braze.com": [] } }), "2026-11-12"), null);
  });

  it("a missing or malformed file is no search, not an error", () => {
    assert.equal(readPeopleFile("/nonexistent/apollo-people.json", "2026-11-12"), null);
    assert.equal(readPeopleFile(file({ day: "2026-11-12", byDomain: "braze.com" }), "2026-11-12"), null);
  });
});

describe("names never reach the model", () => {
  it("contacts become tokens, free text is scrubbed, and only reveal puts names back", () => {
    const card = { key: "001", contacts: { kind: "contacts", primary: { firstName: "Priya", lastName: "Raman" }, alternates: [{ firstName: "Ines", lastName: "Castro" }] } } as never;
    const t = tokenize([card]);
    assert.equal(t.tokenOf("001"), "P1");
    const scrubbed = t.scrub("Priya Raman asked Ines about pricing.");
    assert.ok(!/Priya|Raman|Ines/.test(scrubbed), scrubbed);
    assert.equal(reveal("Hi [[P1]],", t.map), "Hi Priya,");
  });
});
