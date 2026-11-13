/**
 * The demo book: eleven accounts, each there to exercise one rule.
 *
 * EVERY CRM RECORD HERE IS INVENTED. The company names and domains are real
 * only so Apollo has something to resolve; the deals, calls, cases, tasks,
 * meetings and contact people are made up and say nothing true about those
 * companies. Contact emails use the reserved ".example" domain.
 *
 * Dates are offsets from "now", so the book reads the same on any day it is
 * seeded or run from fixtures.
 */
import type { ContactRow } from "../../.claude/skills/ae-daily-plan/scripts/lib/contacts.ts";
import type { Rows } from "../../.claude/skills/ae-daily-plan/scripts/lib/plan.ts";

export interface SeedAccount {
  ref: string;
  name: string;
  website: string;
  type: string;
  target: boolean;
  /** The rule this account is here to show. */
  shows: string;
  readiness?: { letter: "A" | "B" | "C"; daysAgo: number };
  lastActivityDaysAgo?: number;
  opps?: { name: string; amount: number; stage: string; closeInDays: number; nextStep?: string; nextStepDaysAgo?: number; lost?: boolean }[];
  contacts?: { first: string; last: string; title: string; email?: string; phone?: string; optedOut?: boolean; left?: boolean; priority?: boolean }[];
  calls?: { title: string; daysAgo: number; brief: string; nextSteps?: string }[];
  cases?: { subject: string; priority: "High" | "Medium" | "Low"; daysAgo: number }[];
  meetingToday?: { subject: string; hour: number };
  overdueTask?: { subject: string; daysAgo: number };
}

export const SEED: readonly SeedAccount[] = [
  {
    ref: "twilio", name: "Twilio", website: "https://www.twilio.com", type: "Prospect", target: true,
    shows: "An overdue task puts a deal at the top of the plan.",
    lastActivityDaysAgo: 6,
    opps: [{ name: "Twilio: forecasting rollout", amount: 140000, stage: "Proposal/Price Quote", closeInDays: 40, nextStep: "Send revised pricing for 300 seats", nextStepDaysAgo: 6 }],
    contacts: [{ first: "Marcus", last: "Bell", title: "VP Sales Operations", email: "marcus.bell@twilio.example", phone: "(415) 555-0142", priority: true }, { first: "Ines", last: "Castro", title: "Senior Manager, Revenue Operations", email: "ines.castro@twilio.example" }],
    calls: [{ title: "Pricing review", daysAgo: 6, brief: "Reviewed the proposal with sales operations. They want pricing at 300 seats rather than 250 before it goes to finance.", nextSteps: "We send revised pricing for 300 seats." }],
    overdueTask: { subject: "Send revised pricing for 300 seats", daysAgo: 4 },
  },
  {
    ref: "asana", name: "Asana", website: "https://asana.com", type: "Prospect", target: true,
    shows: "A next step older than 14 days is stale.",
    lastActivityDaysAgo: 21,
    opps: [{ name: "Asana: RevOps platform", amount: 84000, stage: "Negotiation/Review", closeInDays: 9, nextStep: "Send security questionnaire answers", nextStepDaysAgo: 21 }],
    contacts: [{ first: "Priya", last: "Raman", title: "Director of Revenue Operations", email: "priya.raman@asana.example", phone: "(415) 555-0117", priority: true }],
    calls: [{ title: "Technical review", daysAgo: 21, brief: "Walked revenue operations through the forecasting module. They asked how it handles multiple currencies and single sign on.", nextSteps: "We send the security questionnaire answers; they bring in IT." }],
  },
  {
    ref: "box", name: "Box", website: "https://www.box.com", type: "Customer - Direct", target: false,
    shows: "An open high priority support case holds the pitch email.",
    lastActivityDaysAgo: 12,
    opps: [{ name: "Box: territory planning add on", amount: 60000, stage: "Value Proposition", closeInDays: 33, nextStep: "Share territory planning demo recording", nextStepDaysAgo: 12 }],
    contacts: [{ first: "Elena", last: "Ruiz", title: "Senior Manager, Revenue Operations", email: "elena.ruiz@box.example", phone: "(650) 555-0190", priority: true }],
    calls: [{ title: "Expansion discovery", daysAgo: 12, brief: "Discussed territory planning for next fiscal year. They are interested but said the nightly forecast sync has to be reliable first." }],
    cases: [{ subject: "Nightly forecast sync failing", priority: "High", daysAgo: 9 }, { subject: "Report export shows wrong currency", priority: "Low", daysAgo: 3 }],
  },
  {
    ref: "gitlab", name: "GitLab", website: "https://about.gitlab.com", type: "Prospect", target: true,
    shows: "A meeting today is urgent work, with a short briefing.",
    lastActivityDaysAgo: 12,
    readiness: { letter: "A", daysAgo: 8 },
    contacts: [{ first: "Tom", last: "Okafor", title: "Head of Revenue Operations", email: "tom.okafor@gitlab.example", priority: true }],
    calls: [{ title: "Intro call", daysAgo: 12, brief: "Intro call. Forecast accuracy was called out as a board level concern, and they run forecasts in spreadsheets today.", nextSteps: "Discovery with the wider revenue operations team." }],
    meetingToday: { subject: "Discovery with revenue operations", hour: 14 },
  },
  {
    ref: "pagerduty", name: "PagerDuty", website: "https://www.pagerduty.com", type: "Prospect", target: true,
    shows: "A lost deal that has been quiet for 30 days or more is worth reopening.",
    lastActivityDaysAgo: 64,
    readiness: { letter: "B", daysAgo: 10 },
    opps: [{ name: "PagerDuty: forecasting", amount: 70000, stage: "Closed Lost", closeInDays: -150, lost: true }],
    contacts: [{ first: "Dana", last: "Whitfield", title: "Director, Sales Operations", email: "dana.whitfield@pagerduty.example", priority: true }],
    calls: [{ title: "Loss review", daysAgo: 150, brief: "They chose to stay on spreadsheets through the fiscal year and asked us to come back at planning time." }],
  },
  {
    ref: "braze", name: "Braze", website: "https://www.braze.com", type: "Prospect", target: true,
    shows: "No contacts on record: Apollo supplies the people to reach.",
    readiness: { letter: "A", daysAgo: 5 },
  },
  {
    ref: "amplitude", name: "Amplitude", website: "https://amplitude.com", type: "Prospect", target: true,
    shows: "A readiness letter older than 30 days is not trusted; it is refreshed from Apollo.",
    readiness: { letter: "A", daysAgo: 45 },
    contacts: [{ first: "Sam", last: "Lee", title: "Revenue Operations Manager", email: "sam.lee@amplitude.example" }],
  },
  {
    ref: "smartsheet", name: "Smartsheet", website: "https://www.smartsheet.com", type: "Prospect", target: true,
    shows: "The only contact opted out, so nobody on record is safe; Apollo finds others and never the one who opted out.",
    contacts: [{ first: "Noor", last: "Haddad", title: "VP Revenue Operations", email: "noor.haddad@smartsheet.example", optedOut: true }],
  },
  {
    ref: "docusign", name: "DocuSign", website: "https://www.docusign.com", type: "Prospect", target: true,
    shows: "Worked 20 days ago, so it is left out and the plan says why.",
    lastActivityDaysAgo: 20,
    readiness: { letter: "B", daysAgo: 12 },
    contacts: [{ first: "Ravi", last: "Menon", title: "Sales Operations Lead", email: "ravi.menon@docusign.example" }, { first: "Jo", last: "Park", title: "Director, Sales Operations", email: "jo.park@docusign.example", left: true }],
    calls: [{ title: "Intro call", daysAgo: 20, brief: "Short intro. They asked us to follow up after their kickoff." }],
  },
  {
    ref: "okta", name: "Okta", website: "https://www.okta.com", type: "Prospect", target: true,
    shows: "Outside the ICP on size: Apollo scores it C and it is left out with the reason.",
  },
  {
    ref: "dropbox", name: "Dropbox", website: "https://www.dropbox.com", type: "Technology Partner", target: true,
    shows: "A partner is never outbound, whatever its flags say.",
  },
];

const DAY = 86_400_000;
const iso = (d: Date): string => d.toISOString();

/** The same book as query results, with made up ids, so the whole plan runs with no org. `seed.ts` writes these same records to Salesforce. */
export function toRows(now: Date, timeZone: string): Rows {
  const rows: Rows = { accounts: [], opps: [], contacts: [], calls: [], cases: [], events: [], overdueTasks: [] };
  const ago = (days: number): Date => new Date(now.getTime() - days * DAY);
  // Date only values count back from the rep's own today, the same calendar the plan reads them on.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const day = (daysAgo: number): string => new Date(Date.parse(`${today}T12:00:00Z`) - daysAgo * DAY).toISOString().slice(0, 10);
  let n = 0;
  const id = (prefix: string): string => `${prefix}FIX${String(++n).padStart(9, "0")}`;
  for (const s of SEED) {
    const a = id("001");
    rows.accounts.push({
      Id: a, Name: s.name, Website: s.website, Type: s.type, Target_Account__c: s.target,
      Readiness__c: s.readiness?.letter ?? null,
      Last_Enriched_by_Apollo__c: s.readiness ? iso(ago(s.readiness.daysAgo)) : null,
      Last_Sales_Activity__c: s.lastActivityDaysAgo === undefined ? null : day(s.lastActivityDaysAgo),
    });
    for (const o of s.opps ?? []) rows.opps.push({ Id: id("006"), AccountId: a, Name: o.name, Amount: o.amount, StageName: o.stage, CloseDate: day(-o.closeInDays), IsClosed: !!o.lost, IsWon: false, NextStep: o.nextStep ?? null, Next_Step_Updated__c: o.nextStepDaysAgo === undefined ? null : day(o.nextStepDaysAgo) });
    for (const c of s.contacts ?? []) rows.contacts.push({ Id: id("003"), AccountId: a, FirstName: c.first, LastName: c.last, Title: c.title, Email: c.email ?? null, Phone: c.phone ?? null, HasOptedOutOfEmail: !!c.optedOut, Left_Company__c: !!c.left, Priority_Contact__c: !!c.priority, Apollo_Id__c: null, LastActivityDate: null } satisfies ContactRow);
    for (const c of s.calls ?? []) rows.calls.push({ Id: id("a00"), Account__c: a, Name: c.title, Call_Start__c: iso(ago(c.daysAgo)), Call_Brief__c: c.brief, Next_Steps__c: c.nextSteps ?? null });
    for (const c of s.cases ?? []) rows.cases.push({ Id: id("500"), AccountId: a, Subject: c.subject, Priority: c.priority, CreatedDate: iso(ago(c.daysAgo)) });
    if (s.meetingToday) rows.events.push({ Id: id("00U"), AccountId: a, Subject: s.meetingToday.subject, StartDateTime: iso(atLocalHour(now, timeZone, s.meetingToday.hour)) });
    if (s.overdueTask) rows.overdueTasks.push({ Id: id("00T"), AccountId: a, Subject: s.overdueTask.subject, ActivityDate: day(s.overdueTask.daysAgo) });
  }
  return rows;
}

/** The instant that reads as `hour`:00 today on the wall clock in `timeZone`. */
export function atLocalHour(now: Date, timeZone: string, hour: number): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false, minute: "numeric" }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  const m = Number(parts.find((p) => p.type === "minute")!.value);
  return new Date(now.getTime() + ((hour - h) * 60 - m) * 60_000);
}
