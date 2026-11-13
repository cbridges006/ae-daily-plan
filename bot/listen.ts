/**
 * The Slack front door: `/plan` in Slack runs the skill in the background and shows its progress;
 * Apply on the proposed writes makes the ones the rep ticked.
 *
 *   npm run bot
 *
 * It uses Slack's Socket Mode: this process opens a connection out to Slack and commands and clicks
 * come back down it, so there is no public URL and no server. It runs where the skill runs (a laptop
 * here, a small always-on host in production) and does nothing while it is not running, which Slack
 * shows as "/plan failed with the error dispatch_failed".
 *
 * The plan is written by Claude Code itself, headless (`claude -p`), with the same skill a rep would
 * use in a Claude Code window, so there is one implementation and not a second copy for Slack.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { APPLY_ACTION, esc, selectedWrites, slack } from "../.claude/skills/ae-daily-plan/scripts/lib/slack.ts";
import { advance, appliedLines, childEnv, claudeArgs, decideApply, orgFrom, progressText, resultOf, SCRIPTS, stageOf } from "./logic.ts";
import type { AppliedEntry, PlanRecord, RunRecord, Stage } from "./logic.ts";

const root = new URL("..", import.meta.url).pathname;
try { process.loadEnvFile(join(root, ".env")); } catch { /* no .env: use the shell */ }
const out = join(root, "out");
const RUN_LIMIT_MS = 10 * 60_000;

const appToken = process.env.SLACK_APP_TOKEN;
const botToken = process.env.SLACK_BOT_TOKEN;
if (!appToken?.startsWith("xapp-")) stop("SLACK_APP_TOKEN is not set (an app level token starting xapp-, with connections:write). Save it with: zsh setup/save-one.zsh SLACK_APP_TOKEN");
if (!botToken?.startsWith("xoxb-")) stop("SLACK_BOT_TOKEN is not set. Save it with: zsh setup/save-one.zsh SLACK_BOT_TOKEN");
const s = slack(botToken);

let running: { user: string; startedAt: number } | null = null;
const applying = new Set<string>();

const readJson = <T,>(file: string): T | null => { try { return JSON.parse(readFileSync(join(out, file), "utf8")) as T; } catch { return null; } };
const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } });
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);

// ---- Socket Mode ----

async function connect(): Promise<void> {
  const res = await fetch("https://slack.com/api/apps.connections.open", { method: "POST", headers: { authorization: `Bearer ${appToken}` } });
  const r = (await res.json()) as { ok: boolean; url?: string; error?: string };
  if (!r.ok || !r.url) throw new Error(`apps.connections.open failed: ${r.error ?? res.status}`);
  const ws = new WebSocket(r.url);
  ws.onmessage = (m) => { void onFrame(ws, String(m.data)); };
  // Slack refreshes the connection every few hours ("disconnect", then a close); reconnecting is routine.
  ws.onclose = () => { log("Slack connection closed; reconnecting"); setTimeout(() => void connectLoop(), 1000); };
  ws.onerror = () => log("Slack connection error");
}

async function connectLoop(): Promise<void> {
  for (let wait = 1000; ; wait = Math.min(wait * 2, 60_000)) {
    try { await connect(); return; }
    catch (e) { log(`${(e as Error).message}; trying again in ${wait / 1000}s`); await new Promise((r) => setTimeout(r, wait)); }
  }
}

interface Envelope { envelope_id?: string; type: string; reason?: string; payload?: unknown }

async function onFrame(ws: WebSocket, raw: string): Promise<void> {
  const env = JSON.parse(raw) as Envelope;
  if (env.type === "hello") { log("Connected to Slack. Type /plan in a channel the app is in."); return; }
  if (env.type === "disconnect") { ws.close(); return; }
  if (!env.envelope_id) return;
  // Slack wants the acknowledgment within 3 seconds; everything slow happens after it.
  const ack = (payload?: unknown) => ws.send(JSON.stringify({ envelope_id: env.envelope_id, ...(payload ? { payload } : {}) }));
  try {
    if (env.type === "slash_commands") return onPlan(env.payload as SlashPayload, ack);
    ack();
    if (env.type === "interactive") await onClick(env.payload as ClickPayload);
  } catch (e) {
    // Loud, not swallowed: the terminal shows it, and the rep is told when we know who they are.
    log(`FAILED handling ${env.type}: ${(e as Error).stack ?? e}`);
  }
}

// ---- /plan ----

interface SlashPayload { command: string; text?: string; user_id: string; channel_id: string; response_url: string }

function onPlan(p: SlashPayload, ack: (payload?: unknown) => void): void {
  const org = orgFrom(p.text);
  if (!org) return ack({ text: "Usage: `/plan` for the default org, or `/plan <Salesforce org alias>`." });
  if (running) return ack({ text: `A plan is already being built for <@${running.user}>; it posts here when it is done.` });
  ack({ text: "Building your plan. Progress shows in the channel." });
  void build(p, org).catch((e) => log(`FAILED building: ${(e as Error).stack ?? e}`)).finally(() => { running = null; });
}

async function build(p: SlashPayload, org: string): Promise<void> {
  const startedAt = Date.now();
  running = { user: p.user_id, startedAt };
  mkdirSync(out, { recursive: true });
  const run: RunRecord = { org, requestedBy: p.user_id, channel: p.channel_id, startedAt: new Date(startedAt).toISOString() };
  writeFileSync(join(out, "bot-run.json"), JSON.stringify(run, null, 2));
  log(`/plan ${org} from ${p.user_id}`);

  let status: { channel: string; ts: string };
  try {
    status = await s.post(p.channel_id, "Building your plan", [section(progressText(p.user_id, org, null, startedAt, Date.now()))]);
  } catch (e) {
    // The commonest first failure: the app was never invited to this channel.
    await fetch(p.response_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `I can't post here (${(e as Error).message}). Invite me with \`/invite @AE Daily Plan\`, then try /plan again.` }) });
    return;
  }

  let stage: Stage | null = null;
  let result: { ok: boolean; text: string } | null = null;
  const show = () => s.update(status.channel, status.ts, "Building your plan", [section(progressText(p.user_id, org, stage, startedAt, Date.now()))]).catch((e) => log(`progress update failed: ${(e as Error).message}`));
  const tick = setInterval(() => void show(), 10_000);

  const child = spawn("claude", claudeArgs(org), {
    cwd: root,
    env: childEnv(process.env, p.channel_id),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const killer = setTimeout(() => child.kill("SIGTERM"), RUN_LIMIT_MS);
  let stderr = "";
  child.stderr.on("data", (d) => { stderr = (stderr + String(d)).slice(-2000); });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const st = stageOf(line);
    const next = advance(stage, st);
    if (next !== stage) { stage = next; log(`stage: ${next}`); void show(); }
    result = resultOf(line) ?? result;
  });
  const code = await new Promise<number | null>((resolve) => { child.on("close", resolve); child.on("error", (e) => { stderr += String(e); resolve(-1); }); });
  clearInterval(tick); clearTimeout(killer);

  // Done means the plan reached Slack, not that Claude said it finished: slack.json is rewritten by deliver.ts.
  const posted = existsSync(join(out, "slack.json")) && statSync(join(out, "slack.json")).mtimeMs >= startedAt;
  const secs = Math.round((Date.now() - startedAt) / 1000);
  const r = result as { ok: boolean; text: string } | null;
  if (code === 0 && r?.ok && posted) {
    log(`plan posted in ${secs}s`);
    await s.update(status.channel, status.ts, "Your plan is ready", [section(`:white_check_mark: *<@${p.user_id}>'s plan is ready* (${Math.floor(secs / 60)}m ${secs % 60}s). It's the message below.`)]);
    return;
  }
  const why = code === null ? `stopped after ${RUN_LIMIT_MS / 60_000} minutes` : !posted ? "the plan was never posted" : `the run ended with code ${code}`;
  const detail = (r?.text || stderr || "no output").trim().slice(-1200);
  log(`FAILED: ${why}\n${detail}`);
  await s.update(status.channel, status.ts, "The plan was not built", [
    section(`:x: *The plan was not built:* ${esc(why)}.`),
    section(`\`\`\`${esc(detail)}\`\`\``),
  ]);
}

// ---- Apply ----

interface ClickPayload {
  type: string;
  user: { id: string };
  channel?: { id: string };
  container?: { message_ts?: string; thread_ts?: string };
  actions?: { action_id: string; value?: string }[];
  state?: unknown;
}

async function onClick(p: ClickPayload): Promise<void> {
  const a = p.actions?.find((x) => x.action_id === APPLY_ACTION);
  if (p.type !== "block_actions" || !a) return; // a checkbox tick: Slack keeps its state until Apply
  const channel = p.channel?.id ?? "";
  const plan = readJson<PlanRecord>("slack.json");
  const run = readJson<RunRecord>("bot-run.json");
  const d = decideApply({ user: p.user.id, planTs: a.value ?? "" }, run, plan, selectedWrites(p.state));
  if (!d.ok) { await s.ephemeral(channel, p.user.id, d.why, p.container?.thread_ts); return; }
  if (applying.has(plan!.ts)) return; // a double click while the first is still writing
  applying.add(plan!.ts);
  try {
    log(`apply ${d.numbers.join(",")} by ${p.user.id}`);
    const startedApply = Date.now();
    const { code, text } = await node(`${SCRIPTS}/apply.ts`, ["--org", run!.org, "--approve", d.numbers.join(","), "--approved-by", `Slack user ${p.user.id}`]);
    const applied = { by: p.user.id, at: new Date().toISOString(), numbers: d.numbers };
    writeFileSync(join(out, "slack.json"), JSON.stringify({ ...plan, applied }, null, 2));
    // apply.ts's own log, not its printed text: it holds each record's link. Read only if this run wrote it.
    const done = readJson<{ log: AppliedEntry[] }>("applied.json");
    const writes = readJson<{ writes: { n: number; summary: string }[] }>("final.json")?.writes ?? [];
    const lines = done && existsSync(join(out, "applied.json")) && statSync(join(out, "applied.json")).mtimeMs >= startedApply ? appliedLines(done.log, writes) : [];
    await s.update(channel, plan!.writesTs ?? p.container!.message_ts!, "Writes applied", [
      section(`${code === 0 ? ":white_check_mark:" : ":warning:"} *Applied by <@${p.user.id}>*, writes ${d.numbers.join(", ")}. Each one is logged with its value before and after.`),
      section(lines.join("\n") || "_apply.ts left no log; nothing can be shown as written_"),
      { type: "context", elements: [{ type: "mrkdwn", text: "Each link opens the record in Salesforce." }] },
      ...(code === 0 ? [] : [section(`*Some writes failed or were refused.* Nothing else was attempted. The terminal running \`npm run bot\` has the detail.`)]),
    ]);
    if (code !== 0) log(`apply ended with code ${code}\n${text}`);
  } finally { applying.delete(plan!.ts); }
}

function node(script: string, args: string[]): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    c.stdout.on("data", (d) => { text += String(d); });
    c.stderr.on("data", (d) => { text += String(d); });
    c.on("close", (code) => resolve({ code, text }));
  });
}

function stop(why: string): never {
  console.error(`STOPPED: ${why}`);
  process.exit(2);
}

log("Starting the AE Daily Plan listener");
await connectLoop();
