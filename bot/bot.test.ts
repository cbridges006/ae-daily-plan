import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approvalBlocks, selectedWrites } from "../.claude/skills/ae-daily-plan/scripts/lib/slack.ts";
import { advance, appliedLines, childEnv, claudeArgs, decideApply, orgFrom, progressText, resultOf, stageOf } from "./logic.ts";
import type { PlanRecord, RunRecord } from "./logic.ts";

const tool = (name: string, input: Record<string, string>) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

describe("/plan", () => {
  it("takes an org alias or the default, and refuses anything that is not an alias", () => {
    assert.equal(orgFrom(""), "apollo-demo");
    assert.equal(orgFrom("  my-org "), "my-org");
    assert.equal(orgFrom("my org; rm -rf"), null);
  });

  it("follows the run by the agent's own tool calls, not by script names in its prose", () => {
    assert.equal(stageOf(tool("Bash", { command: "node .claude/skills/ae-daily-plan/scripts/gather.ts --org apollo-demo" })), "gather");
    assert.equal(stageOf(tool("Read", { file_path: "/x/out/model-input.md" })), "write");
    assert.equal(stageOf(tool("Write", { file_path: "/x/out/written.json" })), "write");
    assert.equal(stageOf(tool("Bash", { command: "node .claude/skills/ae-daily-plan/scripts/check.ts" })), "check");
    assert.equal(stageOf(tool("Bash", { command: "node .claude/skills/ae-daily-plan/scripts/deliver.ts" })), "deliver");
    assert.equal(stageOf(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "next I run deliver.ts" }] } })), null);
    assert.equal(stageOf("not json"), null);
  });

  it("progress only moves forward through a rewrite after the checker", () => {
    let st: ReturnType<typeof advance> = null;
    for (const s of ["gather", "write", "check", "write", null, "check", "deliver"] as const) st = advance(st, s);
    assert.equal(st, "deliver");
    assert.equal(advance("check", "write"), "check");
  });

  it("the background run drops a parent Claude session's variables and keeps the rest", () => {
    const e = childEnv({ PATH: "/bin", HOME: "/h", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", ANTHROPIC_BASE_URL: "http://proxy", SLACK_BOT_TOKEN: "t", SLACK_CHANNEL: "COLD" }, "CNEW");
    assert.equal(e.PATH, "/bin");
    assert.equal(e.SLACK_BOT_TOKEN, "t");
    assert.equal(e.SLACK_CHANNEL, "CNEW");
    assert.equal(e.AE_PLAN_BUTTONS, "1");
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "ANTHROPIC_BASE_URL"]) assert.equal(e[k], undefined, k);
  });

  it("counts a run as done only on a success result", () => {
    assert.deepEqual(resultOf(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Posted." })), { ok: true, text: "Posted." });
    assert.equal(resultOf(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }))?.ok, false);
    assert.equal(resultOf(tool("Bash", { command: "x" })), null);
  });

  it("ticks the steps behind the current one", () => {
    const t = progressText("U1", "apollo-demo", "check", 0, 42_000);
    assert.match(t, /42s/);
    assert.match(t, /:white_check_mark: Reading Salesforce/);
    assert.match(t, /:white_check_mark: Claude is writing/);
    assert.match(t, /:hourglass_flowing_sand: Checking every email/);
    assert.match(t, /:white_small_square: Posting the plan/);
  });

  it("the background run may never call apply.ts or read the name map", () => {
    const a = claudeArgs("apollo-demo");
    const denied = a.slice(a.indexOf("--disallowedTools") + 1);
    assert.ok(denied.some((x) => x.includes("apply.ts")));
    assert.ok(denied.includes("Read(./out/tokens.json)"));
    const allowed = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"));
    assert.ok(!allowed.some((x) => x.includes("apply.ts")));
    assert.ok(!allowed.includes("Bash"), "no blanket shell access");
  });
});

describe("Apply in Slack", () => {
  const writes = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, summary: i === 0 ? `Task on Twilio: ${"x".repeat(100)}` : `Write ${i + 1}` }));
  const run: RunRecord = { org: "apollo-demo", requestedBy: "UREP", channel: "C1", startedAt: "2026-11-13T15:00:00Z" };
  const plan: PlanRecord = { channel: "C1", ts: "111.1", day: "2026-11-13", writesTs: "111.9" };

  it("splits writes into checkbox groups Slack accepts, nothing ticked, option text inside 75 characters", () => {
    const blocks = approvalBlocks(writes, "111.1") as { type: string; block_id?: string; elements?: { type: string; options?: { text: { text: string } }[]; initial_options?: unknown; value?: string }[] }[];
    const groups = blocks.filter((b) => b.block_id?.startsWith("writes_"));
    assert.deepEqual(groups.map((g) => g.elements![0]!.options!.length), [10, 2]);
    for (const g of groups) {
      assert.equal(g.elements![0]!.initial_options, undefined);
      for (const o of g.elements![0]!.options!) assert.ok(o.text.text.length <= 75, o.text.text);
    }
    assert.equal(blocks.find((b) => b.block_id === "apply")!.elements![0]!.value, "111.1");
  });

  it("reads what was ticked across every group, and ignores other blocks", () => {
    const state = { values: { writes_0: { pick_0: { selected_options: [{ value: "3" }, { value: "1" }] } }, writes_1: { pick_1: { selected_options: [{ value: "11" }] } }, other: { x: { selected_options: [{ value: "5" }] } } } };
    assert.deepEqual(selectedWrites(state), [1, 3, 11]);
    assert.deepEqual(selectedWrites(undefined), []);
  });

  it("links each applied write to its Salesforce record, and a failed one to nothing", () => {
    const lines = appliedLines([
      { n: 3, result: "updated", url: "https://x.my.salesforce.com/001A" },
      { n: 4, result: "created", url: "https://x.my.salesforce.com/00TB" },
      { n: 5, result: "failed", why: "REQUIRED_FIELD_MISSING" },
      { n: 6, result: "skipped", why: "already in Salesforce as 003C" },
    ], [{ n: 3, summary: "Set readiness to B on Amplitude (was A)" }, { n: 4, summary: "Task on Twilio: Send <pricing> & close" }, { n: 5, summary: "Task on Box" }, { n: 6, summary: "Contact" }]);
    assert.equal(lines[0], ":white_check_mark: <https://x.my.salesforce.com/001A|3. Set readiness to B on Amplitude (was A)>");
    assert.equal(lines[1], ":white_check_mark: <https://x.my.salesforce.com/00TB|4. Task on Twilio: Send &lt;pricing&gt; &amp; close>");
    assert.match(lines[2]!, /^:x: 5\. Task on Box: failed, REQUIRED_FIELD_MISSING$/);
    assert.ok(!lines[2]!.includes("<http"));
    assert.match(lines[3]!, /skipped, already in Salesforce/);
  });

  it("writes only for the person who asked, on the current plan, once, with something ticked", () => {
    assert.deepEqual(decideApply({ user: "UREP", planTs: "111.1" }, run, plan, [1, 2, 3]), { ok: true, numbers: [1, 2, 3] });
    assert.match((decideApply({ user: "UOTHER", planTs: "111.1" }, run, plan, [1]) as { why: string }).why, /Only <@UREP>/);
    assert.match((decideApply({ user: "UREP", planTs: "099.0" }, run, plan, [1]) as { why: string }).why, /no longer the current/);
    assert.match((decideApply({ user: "UREP", planTs: "111.1" }, run, { ...plan, applied: { by: "UREP", at: "", numbers: [1] } }, [1]) as { why: string }).why, /already applied/);
    assert.match((decideApply({ user: "UREP", planTs: "111.1" }, run, plan, []) as { why: string }).why, /Tick at least one/);
    assert.equal(decideApply({ user: "UREP", planTs: "111.1" }, null, plan, [1]).ok, false);
  });
});
