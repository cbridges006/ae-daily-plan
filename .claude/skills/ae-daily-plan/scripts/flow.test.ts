/**
 * The whole plan on the seeded book, with recorded Apollo answers: what is
 * in it, in what order, what is left out and why, and what may be written.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { toRows } from "../../../../salesforce/seed/data.ts";
import { mapJob, mapOrg, mapPerson } from "./lib/apollo.ts";
import { signalsFrom } from "./lib/signals.ts";
import type { ApolloPerson } from "./lib/apollo.ts";
import type { Fetched } from "./lib/plan.ts";
import { build, needs } from "./lib/plan.ts";
import type { Icp } from "./lib/readiness.ts";
import { refused } from "./apply.ts";
import { parseApproval } from "./lib/slack.ts";
import { schema, split } from "./write.ts";

const TZ = "America/Los_Angeles";
const NOW = new Date("2026-11-12T18:00:00Z");
const icp = JSON.parse(readFileSync(new URL("../references/icp.json", import.meta.url), "utf8")) as Icp;
const fx = JSON.parse(readFileSync(new URL("../../../../salesforce/seed/apollo-fixtures.json", import.meta.url), "utf8"));

function planFor(apollo: boolean) {
  const rows = toRows(NOW, TZ);
  const want = needs(rows, icp, NOW, TZ);
  const got: Fetched = { orgs: new Map(), people: new Map() };
  const domain = (id: string) => new URL(rows.accounts.find((a) => a.Id === id)!.Website!).hostname.replace(/^www\./, "");
  if (apollo) {
    got.signals = new Map();
    const ago = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
    for (const a of want.enrich) {
      const o = fx.organizations[domain(a.Id)];
      if (!o) continue;
      const org = mapOrg(domain(a.Id), { ...o, latest_funding_round_date: "2026-04-01" });
      got.orgs.set(a.Id, org);
      const jobs = (fx.jobs?.[domain(a.Id)] ?? []).map((j: Record<string, unknown>) => mapJob({ ...j, posted_at: ago(Number(String(j.posted_at).match(/\d+/)![0])) }));
      got.signals.set(a.Id, signalsFrom(org, jobs, [], icp, NOW));
    }
    for (const a of want.people) got.people.set(a.Id, (fx.people[domain(a.Id)] ?? []).map(mapPerson).filter(Boolean) as ApolloPerson[]);
  }
  return { want, plan: build(rows, got, icp, { now: NOW, timeZone: TZ, rep: "Test AE", instanceUrl: "https://example.my.salesforce.com", apolloChecked: apollo }) };
}

describe("the seeded book", () => {
  const { want, plan } = planFor(true);
  const names = plan.cards.map((c) => c.account);

  it("orders urgent work first: overdue task, stale next step, open deal, meeting, then reengage and outbound", () => {
    assert.deepEqual(names, ["Twilio", "Asana", "Box", "GitLab", "PagerDuty", "Braze", "Amplitude", "Smartsheet"]);
  });

  it("asks Apollo about every account in play, never a partner, and rescores only stale or blank readiness", () => {
    assert.ok(!want.enrich.some((a) => a.Name === "Dropbox"));
    assert.ok(want.enrich.some((a) => a.Name === "Twilio"));
    assert.deepEqual(want.rescore.map((a) => a.Name).sort(), ["Amplitude", "Okta", "Smartsheet"]);
  });

  it("a buyer team job posting becomes the why now and a dated Apollo fact", () => {
    const braze = plan.cards.find((c) => c.account === "Braze")!;
    assert.match(braze.why, /hiring a Sales Operations Systems and Data Lead \(posted /);
    assert.ok(braze.facts.some((f) => /^Apollo hiring: "Sales Operations Systems and Data Lead/.test(f)));
  });

  it("leaves out the partner, the account worked inside 30 days, and the C, each with its reason", () => {
    const why = Object.fromEntries(plan.leftOut.map((l) => [l.account, l.why]));
    assert.match(why.Dropbox!, /partner/);
    assert.match(why.DocuSign!, /quiet period/);
    assert.match(why.Okta!, /readiness C/);
  });

  it("holds the pitch email while a high priority case is open", () => {
    const box = plan.cards.find((c) => c.account === "Box")!;
    assert.equal(box.email.allowed, false);
    assert.match(box.email.why!, /support case/);
  });

  it("fills Braze from Apollo and never re-adds Smartsheet's opted out contact", () => {
    const adds = plan.writes.filter((w) => w.kind === "contact").map((w) => `${w.fields.FirstName} ${w.fields.LastName}`);
    assert.deepEqual(adds, ["Avery Stone", "Jordan Vale", "Riley Marsh"]);
  });

  it("every proposed write is one the apply script allows", () => {
    for (const w of plan.writes) assert.equal(refused(w), null, w.summary);
  });
});

describe("without Apollo", () => {
  const { plan } = planFor(false);
  it("still plans the CRM's own work, and says Apollo was not checked instead of guessing", () => {
    assert.ok(plan.cards.some((c) => c.account === "Twilio"));
    assert.ok(!plan.cards.some((c) => c.account === "Smartsheet"));
    assert.ok(plan.leftOut.some((l) => l.account === "Smartsheet" && /Apollo was not checked/.test(l.why)));
  });
});

describe("writes", () => {
  it("refuses an object or field outside the allow list, and an update with no record", () => {
    assert.match(refused({ n: 1, kind: "readiness", account: "X", summary: "", sobject: "Account", id: "001", fields: { AnnualRevenue: 1 } })!, /not allowed/);
    assert.match(refused({ n: 1, kind: "task", account: "X", summary: "", sobject: "Opportunity" as never, fields: {} })!, /not an object/);
    assert.match(refused({ n: 1, kind: "readiness", account: "X", summary: "", sobject: "Account", fields: {} })!, /named record/);
  });

  it("reads an approval reply, and nothing else counts as one", () => {
    assert.deepEqual(parseApproval("approve 3, 1", 5), [1, 3]);
    assert.deepEqual(parseApproval("Approve all", 3), [1, 2, 3]);
    assert.equal(parseApproval("approve 9", 5), null);
    assert.equal(parseApproval("looks good, approve when ready", 5), null);
  });
});

describe("what Claude is handed and may return", () => {
  it("splits the model input into rules and one block per key", () => {
    const s = split("rules here\n\nKEY a1\nAccount: A\n\nKEY b2\nAccount: B\n");
    assert.deepEqual(s.blocks.map((b) => b.key), ["a1", "b2"]);
    assert.equal(s.rules, "rules here");
  });

  it("the response schema only accepts this batch's keys", () => {
    const sc = schema(["a1", "b2"]) as { properties: { accounts: { items: { properties: { key: { enum: string[] } } } } } };
    assert.deepEqual(sc.properties.accounts.items.properties.key.enum, ["a1", "b2"]);
  });
});
