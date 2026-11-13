/**
 * The plan as people read it: the markdown kept in out/plan.md, and the
 * shapes check.ts produces. Shared by check.ts and deliver.ts.
 */
import type { Card, Plan } from "./plan.ts";
import { money } from "./plan.ts";

export interface Written { key: string; call?: string | null; next?: string | null; email?: { subject: string; body: string } | null; meeting?: { opener: string; questions: string[]; objections: string[] } | null }
export interface FinalCard extends Card {
  call: string | null;
  next: string | null;
  email: Card["email"] & { subject?: string; body?: string };
  meetingPrep: Written["meeting"] | null;
  notWritten: boolean;
}
export interface Final extends Omit<Plan, "cards"> { cards: FinalCard[]; dropped: { account: string; why: string[] }[] }

export function render(f: Final): string {
  const urgent = f.cards.filter((c) => c.tier === "pipeline" || c.tier === "meeting");
  const lines = [
    `# Plan for ${f.rep}, ${f.day}`,
    "",
    `**Urgent:** ${urgent.length ? urgent.map((c) => `${c.account} (${c.label.toLowerCase()})`).join(", ") : "nothing"}`,
    `**Meetings today:** ${f.cards.filter((c) => c.meeting).map((c) => `${c.account}, ${c.meeting}`).join("; ") || "none"}`,
    `**Outbound focus:** ${f.cards.filter((c) => c.tier === "outbound" || c.tier === "reengage").map((c) => c.account).join(", ") || "none"}`,
    `**Start with:** ${f.cards.slice(0, 3).map((c) => c.account).join(", ") || "nothing today"}`,
    `**Not checked:** ${f.notChecked.join("; ") || "nothing"}`,
    "",
  ];
  for (const [i, c] of f.cards.entries()) lines.push(...cardLines(c, i + 1), "");
  if (f.leftOut.length) lines.push("## Left out today", "", ...f.leftOut.map((l) => `- ${l.account}: ${l.why}`), "");
  if (f.writes.length) lines.push("## Proposed writes (nothing is written until you approve)", "", ...f.writes.map((w) => `${w.n}. ${w.summary}`), "");
  return lines.join("\n");
}

export function cardLines(c: FinalCard, i: number): string[] {
  const who = c.contacts.kind === "contacts"
    ? [c.contacts.primary, ...c.contacts.alternates].map((p, j) => `${j === 0 ? "" : "alt: "}${p.firstName} ${p.lastName}${p.title ? `, ${p.title}` : ""}${p.phone ? `, ${p.phone}` : ""}${p.source === "apollo" ? " (Apollo)" : ""}`).join("; ")
    : `research needed: ${c.contacts.why}`;
  return [
    `## ${i}. ${c.account} · ${c.label}${money(c.amount) ? ` · ${money(c.amount)}` : ""}`,
    `**Why now:** ${c.why}`,
    ...c.facts.map((f) => `- ${f}`),
    `**Contact:** ${who}${c.contacts.kind === "contacts" && c.contacts.note ? ` _${c.contacts.note}_` : ""}`,
    `**Call opener:** ${c.call ?? "_not written this run_"}`,
    ...(c.meetingPrep ? [`**Meeting opener:** ${c.meetingPrep.opener}`, `**Discovery questions:** ${c.meetingPrep.questions.join(" · ")}`, `**Likely objections:** ${c.meetingPrep.objections.join(" · ")}`] : []),
    c.email.allowed && c.email.body ? `**Email:** _${c.email.subject}_\n\n> ${c.email.body.replace(/\n+/g, "\n> ")}` : `**Email:** none, ${c.email.why}`,
    `**Next step:** ${c.next ?? "_not written this run_"}`,
    ...(c.url ? [`[Open in Salesforce](${c.url})`] : []),
  ];
}
