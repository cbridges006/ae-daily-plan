/**
 * Step 4: put the plan where the rep works.
 *
 *   node scripts/deliver.ts
 *
 * With SLACK_BOT_TOKEN and SLACK_CHANNEL set: one briefing message, each
 * account card as a reply in its thread, and a last reply listing the
 * proposed writes with how to approve them. The thread is the plan; a channel
 * holding ten loose messages a morning is a channel nobody reads.
 *
 * Without them, prints out/plan.md and says Slack was not used.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { money } from "./lib/plan.ts";
import type { Final, FinalCard } from "./lib/render.ts";
import { approvalBlocks, esc, slack } from "./lib/slack.ts";

// Keys live in a git ignored .env at the repository root, written once by the rep, so they never pass
// through a chat or a command line. Variables already set in the shell win.
try { process.loadEnvFile(new URL("../../../../.env", import.meta.url).pathname); } catch { /* no .env: use the shell */ }

const { values: arg } = parseArgs({ options: { out: { type: "string", default: "out" } } });
const out = join(process.cwd(), arg.out!);
const f = JSON.parse(readFileSync(join(out, "final.json"), "utf8")) as Final;
const token = process.env.SLACK_BOT_TOKEN;
const channel = process.env.SLACK_CHANNEL;

if (!token || !channel) {
  console.log(readFileSync(join(out, "plan.md"), "utf8"));
  console.log(`(Slack not used: ${!token ? "SLACK_BOT_TOKEN" : "SLACK_CHANNEL"} is not set. The plan above is out/plan.md.)`);
  process.exit(0);
}

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } });
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text: text.slice(0, 2900) }] });

const urgent = f.cards.filter((c) => c.tier === "pipeline" || c.tier === "meeting");
const briefing = [
  { type: "header", text: { type: "plain_text", text: `Your plan for ${new Date(`${f.day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}` } },
  section([
    `*Urgent:* ${urgent.length ? urgent.map((c) => esc(c.account)).join(", ") : "nothing"}`,
    `*Meetings today:* ${f.cards.filter((c) => c.meeting).map((c) => `${esc(c.account)}, ${esc(c.meeting!)}`).join("; ") || "none"}`,
    `*Outbound focus:* ${f.cards.filter((c) => c.tier === "outbound" || c.tier === "reengage").map((c) => esc(c.account)).join(", ") || "none"}`,
    `*Start with:* ${f.cards.slice(0, 3).map((c) => esc(c.account)).join(", ") || "nothing today"}`,
  ].join("\n")),
  context(`${f.cards.length} accounts in the thread · ${f.leftOut.length} left out · ${f.writes.length} proposed writes · Not checked: ${esc(f.notChecked.join("; ") || "nothing")}`),
];

function card(c: FinalCard, i: number): unknown[] {
  const people = c.contacts.kind === "contacts" ? [c.contacts.primary, ...c.contacts.alternates] : [];
  const who = c.contacts.kind === "contacts"
    ? people.map((p, j) => `${j ? "alt: " : ""}${esc(`${p.firstName} ${p.lastName}`.trim())}${p.title ? `, ${esc(p.title)}` : ""}${p.phone ? `, ${esc(p.phone)}` : ""}${p.source === "apollo" ? " _(Apollo)_" : ""}`).join("\n")
    : `_Research needed: ${esc(c.contacts.why)}_`;
  return [
    section(`*${i}. ${esc(c.account)}* · ${c.label}${money(c.amount) ? ` · ${money(c.amount)}` : ""}\n*Why now:* ${esc(c.why)}`),
    section(c.facts.map((x) => `• ${esc(x)}`).join("\n")),
    section(`*Contact*\n${who}`),
    section(`*Call opener:* ${c.call ? esc(c.call) : "_not written this run_"}`),
    ...(c.meetingPrep ? [section(`*Meeting prep*\nOpener: ${esc(c.meetingPrep.opener)}\nQuestions: ${c.meetingPrep.questions.map(esc).join(" · ")}\nObjections: ${c.meetingPrep.objections.map(esc).join(" · ")}`)] : []),
    section(c.email.allowed && c.email.body ? `*Email:* _${esc(c.email.subject!)}_\n>${esc(c.email.body).replace(/\n+/g, "\n>")}` : `*Email:* none, ${esc(c.email.why ?? "")}`),
    section(`*Next step:* ${c.next ? esc(c.next) : "_not written this run_"}`),
    ...(c.url ? [context(`<${c.url}|Open in Salesforce>`)] : []),
  ];
}

const s = slack(token);
const top = await s.post(channel, `Your plan for ${f.day}`, briefing);
for (const [i, c] of f.cards.entries()) await s.post(top.channel, `${i + 1}. ${c.account}`, card(c, i + 1), top.ts);
if (f.leftOut.length) await s.post(top.channel, "Left out today", [section(`*Left out today*\n${f.leftOut.map((l) => `• ${esc(l.account)}: ${esc(l.why)}`).join("\n")}`)], top.ts);
// Checkboxes and a button only when the Slack listener started this run (bot/listen.ts sets AE_PLAN_BUTTONS):
// a button with nothing listening fails with an error the rep cannot act on.
let writesTs: string | null = null;
if (f.writes.length) {
  const blocks = process.env.AE_PLAN_BUTTONS === "1"
    ? approvalBlocks(f.writes, top.ts)
    : [
      section(`*Proposed writes.* Nothing is written until you approve.\n${f.writes.map((w) => `${w.n}. ${esc(w.summary)}`).join("\n")}`),
      context("Reply in this thread with `approve 1 3` or `approve all`. Then run apply.ts."),
    ];
  writesTs = (await s.post(top.channel, "Proposed writes", blocks, top.ts)).ts;
}
writeFileSync(join(out, "slack.json"), JSON.stringify({ channel: top.channel, ts: top.ts, day: f.day, writesTs }, null, 2));
console.log(`Posted the plan to Slack: 1 briefing and ${f.cards.length} cards in its thread${f.writes.length ? `, plus ${f.writes.length} proposed writes to approve` : ""}.`);
