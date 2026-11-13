/**
 * Step 2, unattended: have Claude write the plan's words through the API.
 *
 *   ANTHROPIC_API_KEY=... node scripts/write.ts
 *
 * When a rep runs the skill in Claude Code, Claude itself writes
 * out/written.json and this script is not needed. This is for the 8:00 run
 * with nobody at a keyboard (cron, a scheduled agent, CI).
 *
 * The model is handed out/model-input.md, which already has names swapped
 * for tokens, and nothing else: no tools, no CRM access, no way to write.
 *
 * The answer comes back as structured output, not prose. The schema's `key`
 * is an enum of this batch's account ids, so the model cannot return an
 * account that is not in the plan or a mangled id. In Precog the first
 * production runs wrote nothing at all: one model answered in prose and the
 * next dropped the id, while the tests passed against a stand in model that
 * always answered in shape. The enum closes that hole at the API, and
 * check.ts still says, loudly, which accounts came back unwritten.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

// Keys live in a git ignored .env at the repository root, written once by the rep, so they never pass
// through a chat or a command line. Variables already set in the shell win.
try { process.loadEnvFile(new URL("../../../../.env", import.meta.url).pathname); } catch { /* no .env: use the shell */ }


/** Accounts per call. Small batches keep each answer short; a failed batch loses five cards, not the plan. */
export const BATCH = 5;

/** Split model-input.md into its shared rules and one block per account. */
export function split(md: string): { rules: string; blocks: { key: string; text: string }[] } {
  const at = md.search(/^KEY /m);
  if (at < 0) return { rules: md, blocks: [] };
  const blocks = md.slice(at).split(/\n\n(?=KEY )/).map((text) => ({ key: /^KEY (\S+)/.exec(text)![1]!, text: text.trim() }));
  return { rules: md.slice(0, at).trim(), blocks };
}

/** The response schema for one batch: one object per key, keys limited to this batch. */
export function schema(keys: readonly string[]): Record<string, unknown> {
  const str = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["accounts"],
    properties: {
      accounts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "call", "next", "email", "meeting"],
          properties: {
            key: { type: "string", enum: [...keys] },
            call: str,
            next: str,
            email: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["subject", "body"], properties: { subject: str, body: str } }] },
            meeting: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["opener", "questions", "objections"], properties: { opener: str, questions: { type: "array", items: str }, objections: { type: "array", items: str } } }] },
          },
        },
      },
    },
  };
}

if (process.argv[1]?.endsWith("write.ts")) await main();

async function main(): Promise<void> {
  const { values: arg } = parseArgs({ options: { out: { type: "string", default: "out" }, model: { type: "string", default: "claude-opus-5-5" } } });
  const out = join(process.cwd(), arg.out!);
  const { rules, blocks } = split(readFileSync(join(out, "model-input.md"), "utf8"));
  if (!blocks.length) { writeFileSync(join(out, "written.json"), "[]"); console.log("Nothing to write: the plan has no accounts."); return; }

  // Resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile.
  const client = new Anthropic();
  const system = [
    rules.replace(/Write one JSON array to out\/written\.json[^\n]*\n/, "Return one object per KEY in `accounts`, in this shape:\n"),
    "Your answer is read only through the response format. Use `null` for email or meeting where the block does not allow one.",
  ].join("\n\n");

  const batches: { key: string; text: string }[][] = [];
  for (let i = 0; i < blocks.length; i += BATCH) batches.push(blocks.slice(i, i + BATCH));

  const results = await Promise.all(batches.map(async (batch, i) => {
    const keys = batch.map((b) => b.key);
    try {
      const res = await client.beta.messages.create({
        model: arg.model!,
        max_tokens: 16000,
        // Server side fallback: if Claude Opus 5.5 declines a batch, the API re-runs it on a fallback model in the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // Writing short emails from given facts is not hard reasoning; medium is this model's default, set so it is visible.
        output_config: { effort: "medium", format: { type: "json_schema", schema: schema(keys) } },
        system,
        messages: [{ role: "user", content: `Write these ${keys.length} accounts:\n\n${batch.map((b) => b.text).join("\n\n")}` }],
      });
      if (res.stop_reason === "refusal") return { i, rows: [], why: `declined (${res.stop_details?.category ?? "no category"})` };
      if (res.stop_reason === "max_tokens") return { i, rows: [], why: "cut off at max_tokens" };
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const rows = (JSON.parse(text) as { accounts: { key: string }[] }).accounts;
      return { i, rows, why: null, usage: res.usage };
    } catch (e) {
      return { i, rows: [], why: e instanceof Anthropic.APIError ? `API ${e.status}: ${e.message.slice(0, 160)}` : (e as Error).message };
    }
  }));

  const written = results.flatMap((r) => r.rows);
  writeFileSync(join(out, "written.json"), JSON.stringify(written, null, 2));
  const inTok = results.reduce((n, r) => n + (r.usage?.input_tokens ?? 0), 0);
  const outTok = results.reduce((n, r) => n + (r.usage?.output_tokens ?? 0), 0);
  console.log(`Claude (${arg.model}) wrote ${written.length} of ${blocks.length} accounts in ${batches.length} call${batches.length === 1 ? "" : "s"} (${inTok} input, ${outTok} output tokens).`);
  for (const r of results.filter((r) => r.why)) console.log(`  BATCH ${r.i + 1} NOT WRITTEN: ${r.why}`);
  console.log("Next: node scripts/check.ts");
  if (results.some((r) => r.why)) process.exitCode = 1;
}
