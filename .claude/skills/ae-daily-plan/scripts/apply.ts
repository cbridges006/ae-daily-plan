/**
 * Step 5: make the writes a person approved, and only those.
 *
 *   node scripts/apply.ts --org apollo-demo --approve 1,3     the numbers the rep approved in chat
 *   node scripts/apply.ts --org apollo-demo --from-slack      the latest "approve ..." reply in the plan's thread
 *   add --dry-run to print what would be written
 *
 * A write is refused, not attempted, when its object or a field is not on
 * the allow list below, so a plan that was edited by hand or by a model
 * cannot widen what this script changes. A Contact is checked against
 * Salesforce again right before it is created, because the plan may be
 * hours old. Every write is logged with its before and after in
 * out/applied.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Write } from "./lib/plan.ts";
import type { Final } from "./lib/render.ts";
import { connect, q } from "./lib/sf.ts";
import type { Sf } from "./lib/sf.ts";
import { parseApproval, slack } from "./lib/slack.ts";

// Keys live in a git ignored .env at the repository root, written once by the rep, so they never pass
// through a chat or a command line. Variables already set in the shell win.
try { process.loadEnvFile(new URL("../../../../.env", import.meta.url).pathname); } catch { /* no .env: use the shell */ }

/** Every object and field this skill may ever write. Nothing else, whatever the plan file says. */
export const ALLOWED: Readonly<Record<Write["sobject"], { op: "update" | "create"; fields: readonly string[] }>> = {
  Account: { op: "update", fields: ["Readiness__c", "Readiness_Reasons__c", "Last_Enriched_by_Apollo__c"] },
  Contact: { op: "create", fields: ["AccountId", "FirstName", "LastName", "Title", "Apollo_Id__c", "LeadSource"] },
  Task: { op: "create", fields: ["WhatId", "Subject", "ActivityDate", "Status", "Priority", "Description"] },
};

/** Why a write may not be made, or null. */
export function refused(w: Write): string | null {
  const rule = ALLOWED[w.sobject];
  if (!rule) return `${w.sobject} is not an object this skill writes`;
  if (rule.op === "update" && !w.id) return `an ${w.sobject} write must update a named record`;
  if (rule.op === "create" && w.id) return `${w.sobject} records are only created, never updated`;
  const extra = Object.keys(w.fields).filter((k) => !rule.fields.includes(k));
  return extra.length ? `fields not allowed on ${w.sobject}: ${extra.join(", ")}` : null;
}

if (process.argv[1]?.endsWith("apply.ts")) await main();

async function main(): Promise<void> {
  const { values: arg } = parseArgs({
    options: { org: { type: "string" }, approve: { type: "string" }, "approved-by": { type: "string" }, "from-slack": { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false }, out: { type: "string", default: "out" } },
  });
  const out = join(process.cwd(), arg.out!);
  const f = JSON.parse(readFileSync(join(out, "final.json"), "utf8")) as Final;
  if (!f.writes.length) { console.log("No writes were proposed."); return; }

  let approved: number[] | null = null;
  // The Slack listener passes who pressed Apply, so the log names a person, not "chat".
  let approver = arg["approved-by"] ?? "the rep, in chat";
  if (arg.approve) {
    approved = parseApproval(`approve ${arg.approve}`, f.writes.length);
    if (!approved) stop(`--approve takes write numbers from 1 to ${f.writes.length}, or "all"`);
  } else if (arg["from-slack"]) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) stop("SLACK_BOT_TOKEN is not set");
    const where = JSON.parse(readFileSync(join(out, "slack.json"), "utf8")) as { channel: string; ts: string };
    const replies = await slack(token).replies(where.channel, where.ts);
    // Latest human reply wins: a rep who approves 1 3 and then says "approve 1" means 1.
    const human = replies.filter((r) => r.user && !r.bot_id && r.ts !== where.ts).reverse();
    const hit = human.map((r) => ({ r, ns: parseApproval(r.text, f.writes.length) })).find((x) => x.ns);
    if (!hit) stop('no "approve ..." reply in the plan\'s Slack thread yet');
    approved = hit.ns;
    approver = `Slack user ${hit.r.user}`;
  } else stop("say what was approved: --approve 1,3 or --from-slack");

  const chosen = f.writes.filter((w) => approved!.includes(w.n));
  const sf = arg["dry-run"] ? null : connect(arg.org ?? stop("name the Salesforce org with --org <alias>"));
  const log: unknown[] = [];
  for (const w of chosen) {
    const no = refused(w);
    if (no) { log.push({ n: w.n, result: "refused", why: no }); console.log(`  ${w.n}. REFUSED: ${no}`); continue; }
    if (!sf) { log.push({ n: w.n, result: "dry run", fields: w.fields }); console.log(`  ${w.n}. would ${w.summary}`); continue; }
    try {
      const r = await make(sf, w);
      // The record the rep would open to see the change: the account that was rescored, or the task or contact made.
      const url = r.id ? `${sf.instanceUrl}/${r.id}` : null;
      log.push({ n: w.n, ...r, url, approvedBy: approver, at: new Date().toISOString() });
      console.log(`  ${w.n}. ${r.result === "skipped" ? `SKIPPED: ${r.why}` : `done: ${w.summary}`}`);
    } catch (e) {
      log.push({ n: w.n, result: "failed", why: (e as Error).message });
      console.log(`  ${w.n}. FAILED: ${(e as Error).message}`);
    }
  }
  writeFileSync(join(out, "applied.json"), JSON.stringify({ approvedBy: approver, approved, log }, null, 2));
  const failed = log.filter((l) => (l as { result: string }).result === "failed" || (l as { result: string }).result === "refused").length;
  console.log(`${chosen.length} approved, ${failed} failed or refused. Log: ${arg.out}/applied.json`);
  if (failed) process.exitCode = 1;
}

async function make(sf: Sf, w: Write): Promise<{ result: "updated" | "created" | "skipped"; id?: string; before?: unknown; after?: unknown; why?: string }> {
  if (w.sobject === "Account") {
    const fields = Object.keys(w.fields);
    const [before] = await sf.query<Record<string, unknown>>(`SELECT ${fields.join(", ")} FROM Account WHERE Id = ${q(w.id!)}`);
    if (!before) return { result: "skipped", why: "the account no longer exists" };
    delete before.attributes;
    await sf.update("Account", w.id!, w.fields);
    return { result: "updated", id: w.id, before, after: w.fields };
  }
  if (w.sobject === "Contact") {
    const f = w.fields as { AccountId: string; FirstName: string; LastName: string; Apollo_Id__c?: string };
    const dupes = await sf.query<{ Id: string }>(`SELECT Id FROM Contact WHERE AccountId = ${q(f.AccountId)} AND (${f.Apollo_Id__c ? `Apollo_Id__c = ${q(f.Apollo_Id__c)} OR ` : ""}(FirstName = ${q(f.FirstName)} AND LastName = ${q(f.LastName)}))`);
    if (dupes.length) return { result: "skipped", why: `already in Salesforce as ${dupes[0]!.Id}` };
    const id = await sf.create("Contact", w.fields);
    return { result: "created", id, after: w.fields };
  }
  const id = await sf.create(w.sobject, w.fields);
  return { result: "created", id, after: w.fields };
}

function stop(why: string): never {
  console.error(`STOPPED: ${why}`);
  process.exit(2);
}
