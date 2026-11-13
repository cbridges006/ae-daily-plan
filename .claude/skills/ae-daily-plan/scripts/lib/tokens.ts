/**
 * Names never reach the model.
 *
 * Each contact's name is swapped for a token ([[P1]]) in what the model is
 * handed, and swapped back only in the text a rep reads. The model can write
 * "Hi [[P1]]," without ever holding the name.
 *
 * In a skill this is a convention: the map sits in a file the instructions
 * say not to open. In production it has to be enforced at the model
 * boundary in code, which is the first thing the README lists to harden.
 */
import type { Card } from "./plan.ts";

export type TokenMap = Record<string, { first: string; last: string }>;

export function tokenize(cards: readonly Card[]): { map: TokenMap; tokenOf: (key: string) => string | null; scrub: (s: string) => string } {
  const map: TokenMap = {};
  const byCard = new Map<string, string>();
  const names: [string, string][] = [];
  let n = 0;
  for (const c of cards) {
    if (c.contacts.kind !== "contacts") continue;
    for (const [i, p] of [c.contacts.primary, ...c.contacts.alternates].entries()) {
      const t = `P${++n}`;
      map[t] = { first: p.firstName, last: p.lastName };
      if (i === 0) byCard.set(c.key, t);
      for (const part of [p.firstName, p.lastName]) if (part && part.length > 2 && !/\*/.test(part)) names.push([part, t]);
    }
  }
  /** A call brief is free text and may name the contact; any known name in it becomes that contact's token. */
  const scrub = (s: string): string => names.reduce((out, [name, t]) => out.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), `[[${t}]]`), s);
  return { map, tokenOf: (key) => byCard.get(key) ?? null, scrub };
}

/** Tokens back to first names, for text a person reads. An unknown token is left in place so the merge token check catches it. */
export const reveal = (s: string, map: TokenMap): string => s.replace(/\[\[(P\d+)\]\]/g, (m, t: string) => map[t]?.first || m);
