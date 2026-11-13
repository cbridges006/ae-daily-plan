/**
 * Step 3: hold what the model wrote to the rules, and render the plan.
 *
 *   node scripts/check.ts
 *
 * Reads out/plan.json, out/written.json and out/tokens.json. Writes
 * out/final.json and out/plan.md.
 *
 * Every account the model skipped is said, loudly. An email is shown only if
 * the card allowed one and it passes every check in lib/guidance.ts; one that
 * fails is dropped with its reasons. Names are put back only here, in text a
 * person reads. Each next step becomes a proposed Task.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { problems } from "./lib/guidance.ts";
import type { Plan, Write } from "./lib/plan.ts";
import type { Final, FinalCard, Written } from "./lib/render.ts";
import { render } from "./lib/render.ts";
import type { TokenMap } from "./lib/tokens.ts";
import { reveal } from "./lib/tokens.ts";

const { values: arg } = parseArgs({ options: { out: { type: "string", default: "out" } } });
const out = join(process.cwd(), arg.out!);
const read = <T,>(f: string): T => JSON.parse(readFileSync(join(out, f), "utf8")) as T;


const plan = read<Plan>("plan.json");
const map = read<TokenMap>("tokens.json");
let written: Written[];
try { written = read<Written[]>("written.json"); } catch (e) { console.error(`STOPPED: out/written.json is not valid JSON: ${(e as Error).message}`); process.exit(2); }
if (!Array.isArray(written)) { console.error("STOPPED: out/written.json must be a JSON array"); process.exit(2); }

const keys = new Set(plan.cards.map((c) => c.key));
const stray = written.filter((w) => !keys.has(w.key)).map((w) => w.key);
const byKey = new Map(written.filter((w) => keys.has(w.key)).map((w) => [w.key, w]));
// A leftover token in plain text (call, next step) is read as "the contact" rather than shown raw.
const show = (s: string | null | undefined): string | null => (s && s.trim() ? reveal(s.trim(), map).replace(/\[\[P\d+\]\]/g, "the contact") : null);

const dropped: Final["dropped"] = [];
const cards: FinalCard[] = plan.cards.map((c) => {
  const w = byKey.get(c.key);
  const base: FinalCard = { ...c, call: show(w?.call), next: show(w?.next), email: { ...c.email }, meetingPrep: w?.meeting ?? null, notWritten: !w };
  // A card may allow an email; only a written one that passes every check is shown.
  if (!w || !w.email) {
    if (c.email.allowed) base.email = { allowed: false, why: w ? "no email was written" : "not written this run" };
    return base;
  }
  if (!c.email.allowed) { dropped.push({ account: c.account, why: [`an email was written although ${c.email.why}`] }); return base; }
  // Reveal first, so the checks see the words a customer would. An unknown token survives and fails the merge token check.
  const s = { subject: reveal(w.email.subject ?? "", map), body: reveal(w.email.body ?? "", map) };
  const why = problems(s, { accountName: c.account, priorTouch: c.priorTouch });
  if (why.length) { dropped.push({ account: c.account, why }); base.email = { allowed: false, why: `email dropped: ${why.join("; ")}` }; return base; }
  base.email = { allowed: true, why: null, ...s };
  return base;
});

const tasks: Omit<Write, "n">[] = cards.filter((c) => c.next).map((c) => ({
  kind: "task", account: c.account, sobject: "Task",
  summary: `Task on ${c.account}: ${c.next}`,
  fields: { WhatId: c.oppId ?? c.key, Subject: c.next!.slice(0, 255), ActivityDate: plan.day, Status: "Not Started", Priority: c.tier === "pipeline" || c.tier === "meeting" ? "High" : "Normal", Description: `From the AE daily plan of ${plan.day}. Why now: ${c.why}` },
}));
const writes: Write[] = [...plan.writes.map(({ n: _, ...w }) => w), ...tasks].map((w, i) => ({ n: i + 1, ...w }));
const final: Final = { ...plan, cards, writes, dropped };
writeFileSync(join(out, "final.json"), JSON.stringify(final, null, 2));
writeFileSync(join(out, "plan.md"), render(final));

const missing = cards.filter((c) => c.notWritten).map((c) => c.account);
console.log(`Checked ${cards.length} cards: ${cards.filter((c) => c.email.allowed).length} emails kept, ${dropped.length} dropped, ${missing.length} not written`);
if (missing.length) console.log(`  NOT WRITTEN: ${missing.join(", ")}. Those cards show "not written"; write them and run check.ts again.`);
if (stray.length) console.log(`  IGNORED: written.json names keys that are not in the plan: ${stray.join(", ")}`);
for (const d of dropped) console.log(`  DROPPED ${d.account}: ${d.why.join("; ")}`);
console.log(`  ${writes.length} writes proposed. Next: node scripts/deliver.ts`);
