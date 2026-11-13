/**
 * Load the demo book into a Salesforce Developer Edition org, owned by the
 * logged in user.
 *
 *   node salesforce/seed/seed.ts --org apollo-demo            add the book
 *   node salesforce/seed/seed.ts --org apollo-demo --reset    remove what an earlier seed added, then add it again
 *
 * It refuses any org that is not a Developer Edition. A laptop that has
 * worked on real orgs still has them logged in to the `sf` CLI, and one
 * mistyped alias would otherwise put invented deals into a real CRM.
 *
 * Every seeded account carries MARK in its description; --reset deletes only
 * those, and Salesforce deletes their contacts, deals, cases, calls and
 * activities with them.
 */
import { parseArgs } from "node:util";
import { connect, q } from "../../.claude/skills/ae-daily-plan/scripts/lib/sf.ts";
import { SEED, atLocalHour } from "./data.ts";

const MARK = "Seeded by ae-daily-plan. Invented demo data, not a real customer record.";
const DAY = 86_400_000;

const { values: arg } = parseArgs({ options: { org: { type: "string" }, reset: { type: "boolean", default: false } } });
if (!arg.org) { console.error("STOPPED: name the org with --org <alias>"); process.exit(2); }
const sf = connect(arg.org);

const [org] = await sf.query<{ Name: string; OrganizationType: string; IsSandbox: boolean }>("SELECT Name, OrganizationType, IsSandbox FROM Organization");
if (!org || org.OrganizationType !== "Developer Edition" || org.IsSandbox) {
  console.error(`STOPPED: "${arg.org}" is ${org ? `a ${org.OrganizationType}${org.IsSandbox ? " sandbox" : ""} org (${org.Name})` : "unreadable"}. The seed only runs on a Developer Edition.`);
  process.exit(2);
}
const [me] = await sf.query<{ Id: string; Name: string; TimeZoneSidKey: string }>(`SELECT Id, Name, TimeZoneSidKey FROM User WHERE Username = ${q(sf.username)}`);
if (!me) { console.error("STOPPED: the logged in user could not be read"); process.exit(2); }
const timeZone = me.TimeZoneSidKey;
const now = new Date();
const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const day = (daysAgo: number): string => new Date(Date.parse(`${today}T12:00:00Z`) - daysAgo * DAY).toISOString().slice(0, 10);
const at = (daysAgo: number): string => new Date(now.getTime() - daysAgo * DAY).toISOString();

// Description is long text, which SOQL cannot filter on, so the marker is matched here.
const existing = (await sf.query<{ Id: string; Name: string; Description: string | null }>(`SELECT Id, Name, Description FROM Account WHERE OwnerId = ${q(me.Id)}`))
  .filter((a) => a.Description === MARK);
if (existing.length && !arg.reset) {
  console.error(`STOPPED: ${existing.length} seeded accounts are already here (${existing.map((a) => a.Name).join(", ")}). Run again with --reset to replace them.`);
  process.exit(2);
}
// Salesforce deletes an account's deals, contacts, tasks and calls with it, but refuses while a Case
// points at it ("associated with the following cases"); the first --reset stopped halfway on Box.
for (const a of existing) {
  for (const c of await sf.query<{ Id: string }>(`SELECT Id FROM Case WHERE AccountId = ${q(a.Id)}`)) await sf.remove("Case", c.Id);
  await sf.remove("Account", a.Id);
}
if (existing.length) console.log(`Removed ${existing.length} previously seeded accounts and everything under them.`);

let n = 0;
for (const s of SEED) {
  const accountId = await sf.create("Account", {
    Name: s.name, Website: s.website, Type: s.type, Description: MARK,
    Target_Account__c: s.target,
    Readiness__c: s.readiness?.letter ?? null,
    Last_Enriched_by_Apollo__c: s.readiness ? at(s.readiness.daysAgo) : null,
    Last_Sales_Activity__c: s.lastActivityDaysAgo === undefined ? null : day(s.lastActivityDaysAgo),
  });
  n++;
  let firstOpp: string | null = null;
  for (const o of s.opps ?? []) {
    const id = await sf.create("Opportunity", { AccountId: accountId, Name: o.name, Amount: o.amount, StageName: o.stage, CloseDate: day(-o.closeInDays), NextStep: o.nextStep ?? null, Next_Step_Updated__c: o.nextStepDaysAgo === undefined ? null : day(o.nextStepDaysAgo) });
    firstOpp ??= id; n++;
  }
  for (const c of s.contacts ?? []) {
    await sf.create("Contact", { AccountId: accountId, FirstName: c.first, LastName: c.last, Title: c.title, Email: c.email ?? null, Phone: c.phone ?? null, HasOptedOutOfEmail: !!c.optedOut, Left_Company__c: !!c.left, Priority_Contact__c: !!c.priority });
    n++;
  }
  for (const c of s.calls ?? []) { await sf.create("Gong_Call__c", { Account__c: accountId, Name: c.title, Call_Start__c: at(c.daysAgo), Call_Brief__c: c.brief, Next_Steps__c: c.nextSteps ?? null }); n++; }
  // CreatedDate cannot be set without the "Set Audit Fields" permission, so seeded cases read as opened today.
  for (const c of s.cases ?? []) { await sf.create("Case", { AccountId: accountId, Subject: c.subject, Priority: c.priority, Status: "New", Origin: "Phone" }); n++; }
  if (s.meetingToday) {
    const start = atLocalHour(now, timeZone, s.meetingToday.hour);
    await sf.create("Event", { WhatId: accountId, Subject: s.meetingToday.subject, StartDateTime: start.toISOString(), EndDateTime: new Date(start.getTime() + 45 * 60_000).toISOString() });
    n++;
  }
  if (s.overdueTask) { await sf.create("Task", { WhatId: firstOpp ?? accountId, Subject: s.overdueTask.subject, ActivityDate: day(s.overdueTask.daysAgo), Status: "Not Started", Priority: "High" }); n++; }
}
console.log(`Seeded ${SEED.length} accounts (${n} records) for ${me.Name} in ${org.Name}, time zone ${timeZone}.`);
console.log(`Next: node .claude/skills/ae-daily-plan/scripts/gather.ts --org ${arg.org}`);
