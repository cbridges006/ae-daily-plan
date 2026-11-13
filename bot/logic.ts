/**
 * The listener's decisions, kept apart from sockets and processes so each one is a test.
 */

export const DEFAULT_ORG = "apollo-demo";
export const SCRIPTS = ".claude/skills/ae-daily-plan/scripts";

/** "/plan" or "/plan my-org": the Salesforce org alias, or the default. Anything that is not an alias is refused. */
export function orgFrom(text: string | undefined, fallback = DEFAULT_ORG): string | null {
  const t = (text ?? "").trim();
  if (!t) return fallback;
  return /^[A-Za-z0-9_.@-]{1,80}$/.test(t) ? t : null;
}

export type Stage = "gather" | "write" | "check" | "deliver";
export const STAGES: readonly { id: Stage; label: string }[] = [
  { id: "gather", label: "Reading Salesforce and Apollo" },
  { id: "write", label: "Claude is writing call openers, next steps and emails" },
  { id: "check", label: "Checking every email against the rules" },
  { id: "deliver", label: "Posting the plan" },
];

/**
 * Which step the headless run has reached, from one line of Claude Code's stream-json output.
 * Only the agent's own tool calls count; a script name quoted in its prose does not move the stage.
 */
export function stageOf(line: string): Stage | null {
  let ev: { type?: string; message?: { content?: { type?: string; name?: string; input?: { command?: string; file_path?: string } }[] } };
  try { ev = JSON.parse(line); } catch { return null; }
  if (ev.type !== "assistant") return null;
  let found: Stage | null = null;
  for (const c of ev.message?.content ?? []) {
    if (c.type !== "tool_use") continue;
    const cmd = c.input?.command ?? "";
    const file = c.input?.file_path ?? "";
    if (c.name === "Bash" && cmd.includes("gather.ts")) found = "gather";
    else if (c.name === "Bash" && cmd.includes("check.ts")) found = "check";
    else if (c.name === "Bash" && cmd.includes("deliver.ts")) found = "deliver";
    else if ((c.name === "Write" || c.name === "Edit") && file.endsWith("written.json")) found = "write";
    else if (c.name === "Read" && file.endsWith("model-input.md")) found = "write";
  }
  return found;
}

/**
 * Progress only moves forward. The skill allows one rewrite after the checker, so a live run goes
 * write, check, write, check (seen 11/13/2026), and a list that ticks a step and then unticks it
 * reads as something going wrong.
 */
export function advance(current: Stage | null, next: Stage | null): Stage | null {
  if (!next) return current;
  const at = (s: Stage | null) => (s ? STAGES.findIndex((x) => x.id === s) : -1);
  return at(next) > at(current) ? next : current;
}

/** The headless run's final result line, if this is it. */
export function resultOf(line: string): { ok: boolean; text: string } | null {
  try {
    const ev = JSON.parse(line) as { type?: string; is_error?: boolean; subtype?: string; result?: string };
    if (ev.type !== "result") return null;
    return { ok: !ev.is_error && ev.subtype === "success", text: ev.result ?? ev.subtype ?? "" };
  } catch { return null; }
}

/** The progress message: done steps ticked, the current one marked, the rest waiting. */
export function progressText(user: string, org: string, reached: Stage | null, startedAt: number, now: number): string {
  const at = reached ? STAGES.findIndex((s) => s.id === reached) : -1;
  const lines = STAGES.map((s, i) => `${i < at ? ":white_check_mark:" : i === at ? ":hourglass_flowing_sand:" : ":white_small_square:"} ${s.label}`);
  return `*Building <@${user}>'s plan* from \`${org}\` · ${Math.round((now - startedAt) / 1000)}s\n${lines.join("\n")}`;
}

/**
 * How the background run is started. The skill runs exactly as it does in a Claude Code window, with
 * only the tools its steps use. apply.ts is denied outright: the run that writes the plan can never
 * write to Salesforce; only a person's click on Apply can, through the listener.
 */
export function claudeArgs(org: string): string[] {
  const prompt = [
    `Build today's plan for the Salesforce org ${org} using the ae-daily-plan skill, and deliver it to Slack.`,
    "Run each script exactly as the skill gives it, from the current folder.",
    "Do not apply any writes; the rep approves them in Slack.",
  ].join(" ");
  return [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--allowedTools",
    "Skill",
    `Bash(node ${SCRIPTS}/gather.ts:*)`, `Bash(node ${SCRIPTS}/check.ts:*)`, `Bash(node ${SCRIPTS}/deliver.ts:*)`,
    "Read(./out/**)", "Read(./.claude/skills/**)", "Write(./out/written.json)", "Edit(./out/written.json)",
    "--disallowedTools", `Bash(node ${SCRIPTS}/apply.ts:*)`, "Read(./out/tokens.json)",
  ];
}

/**
 * The background run's environment. A listener started from inside another Claude Code session inherits
 * that session's CLAUDE_CODE_* variables and ANTHROPIC_BASE_URL, and `claude -p` then ran against the
 * parent session and stopped in 18 seconds with "error_during_execution" (11/13/2026). Dropping them makes
 * the run use the rep's own Claude Code login wherever the listener was started.
 */
export function childEnv(env: Readonly<Record<string, string | undefined>>, channel: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || /^(CLAUDECODE|CLAUDE_|ANTHROPIC_BASE_URL$)/.test(k)) continue;
    out[k] = v;
  }
  return { ...out, SLACK_CHANNEL: channel, AE_PLAN_BUTTONS: "1" };
}

export interface AppliedEntry { n: number; result: string; why?: string; url?: string | null }

/**
 * One line per approved write for the Slack message, each linked to the Salesforce record it changed so
 * the rep can open it and see the fields. A write that failed or was refused says so and links nowhere.
 */
export function appliedLines(log: readonly AppliedEntry[], writes: readonly { n: number; summary: string }[]): string[] {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return log.map((l) => {
    const what = esc(`${l.n}. ${writes.find((w) => w.n === l.n)?.summary ?? "write"}`);
    if (l.result === "updated" || l.result === "created") return `:white_check_mark: ${l.url ? `<${l.url}|${what}>` : what}`;
    if (l.result === "skipped") return `:fast_forward: ${what}: skipped, ${esc(l.why ?? "")}`;
    return `:x: ${what}: ${l.result}${l.why ? `, ${esc(l.why)}` : ""}`;
  });
}

export interface PlanRecord { channel: string; ts: string; day: string; writesTs?: string | null; applied?: { by: string; at: string; numbers: number[] } }
export interface RunRecord { org: string; requestedBy: string; channel: string; startedAt: string }

/**
 * Whether a click on Apply may write, and what. Refused when the button belongs to an older plan, when
 * someone other than the person who asked for the plan pressed it, when it was already applied, or when
 * nothing was ticked.
 */
export function decideApply(click: { user: string; planTs: string }, run: RunRecord | null, plan: PlanRecord | null, ticked: number[]):
  { ok: true; numbers: number[] } | { ok: false; why: string } {
  if (!plan || !run || plan.ts !== click.planTs) return { ok: false, why: "This plan is no longer the current one. Ask for a new plan with /plan." };
  if (click.user !== run.requestedBy) return { ok: false, why: `Only <@${run.requestedBy}>, who asked for this plan, can apply its writes.` };
  if (plan.applied) return { ok: false, why: `These writes were already applied by <@${plan.applied.by}>.` };
  if (!ticked.length) return { ok: false, why: "Tick at least one write, then press Apply." };
  return { ok: true, numbers: ticked };
}
