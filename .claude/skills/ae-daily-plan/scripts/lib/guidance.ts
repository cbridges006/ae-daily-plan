/**
 * The suggested email, held to a written standard.
 *
 * The model writes the text; this file decides whether that text may be
 * shown. A suggestion that fails a check is dropped and the card says why,
 * rather than shown with a warning nobody reads.
 *
 * The limits live in references/email-rules.md so enablement can read them.
 * They are numbers here because a rule in a prompt is a request and a rule
 * in code is a guarantee.
 */

export const WORDS_MIN = 50;
export const WORDS_MAX = 125;
export const SENTENCES_MIN = 2;
export const SENTENCES_MAX = 4;
export const LINKS_MAX = 1;
export const SUBJECT_WORDS_MAX = 4;

export interface Suggestion { subject: string; body: string }

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
/** Sentences end in . ! or ? followed by space or the end; a greeting line and a sign off are not counted. */
function sentences(body: string): number {
  const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  // A sign off is a short closing line ("Thanks,", "Best regards"). Matching any line that starts with
  // "Thanks" threw away a real body ("Thanks for reviewing the proposal...") on the first live run.
  const signOff = (l: string): boolean => words(l) <= 3 && /^(thanks|thank you|best|cheers|regards)\b/i.test(l);
  const core = lines.filter((l, i) => !(i === 0 && /^(hi|hello|hey)\b[^.!?]*,?$/i.test(l)) && !signOff(l) && !(i === lines.length - 1 && words(l) <= 2 && !/[.!?]$/.test(l)));
  return core.join(" ").split(/(?<=[.!?])\s+/).filter((s) => /[A-Za-z]/.test(s)).length;
}
const links = (s: string): number => (s.match(/https?:\/\/\S+|www\.\S+/gi) ?? []).length;
const questions = (s: string): number => (s.match(/\?/g) ?? []).length;

/** Hard don'ts, as checks on the text. Each names what it guards against. */
const DONTS: readonly { why: string; test: (s: Suggestion, ctx: Ctx) => boolean }[] = [
  {
    // The commonest way a generated email lies: warmth borrowed from a meeting that never happened.
    why: "claims a prior conversation that is not on record",
    test: (s, c) => !c.priorTouch && /\b(circling back|following up on our|as we discussed|per our (call|conversation|chat)|great (chatting|speaking|talking) with you|thanks for (your time|the call))\b/i.test(s.body),
  },
  {
    // Apollo's news is tied to the account, good and bad. A breach, a lawsuit or an investigation is a fact a rep
    // should know before calling, and never the hook of a cold email. Seen live: a "max severity" security flaw
    // at GitLab and a shareholder investigation at Braze, both in the facts the model was given.
    why: "builds on bad news (a breach, flaw, lawsuit, investigation or layoff)",
    test: (s) => /\b(breach(es|ed)?|vulnerabilit(y|ies)|exploit(ed|s)?|security (flaw|incident)|lawsuit|litigation|investigation|shareholder|layoffs?|laid off|outage)\b/i.test(`${s.subject} ${s.body}`),
  },
  {
    why: "has an unfilled merge token",
    test: (s) => /\{\{?\s*\w+\s*\}?\}|\[\[\s*\w+\s*\]\]|\[\s*(first ?name|title|account|company|name)\s*\]|<\s*(first ?name|account|company)\s*>/i.test(`${s.subject} ${s.body}`),
  },
];

export interface Ctx { accountName: string; priorTouch: boolean }

/**
 * Every reason a suggestion may not be shown, or none. Run after tokens are
 * revealed, so the word count and the merge token check see the real text.
 */
export function problems(s: Suggestion, ctx: Ctx): string[] {
  const out: string[] = [];
  const w = words(s.body);
  if (w < WORDS_MIN || w > WORDS_MAX) out.push(`${w} words, outside ${WORDS_MIN} to ${WORDS_MAX}`);
  const n = sentences(s.body);
  if (n < SENTENCES_MIN || n > SENTENCES_MAX) out.push(`${n} sentences, outside ${SENTENCES_MIN} to ${SENTENCES_MAX}`);
  if (links(s.body) > LINKS_MAX) out.push(`${links(s.body)} links, more than ${LINKS_MAX}`);
  if (words(s.subject) > SUBJECT_WORDS_MAX) out.push(`a subject of ${words(s.subject)} words, more than ${SUBJECT_WORDS_MAX}`);
  const name = ctx.accountName.trim().toLowerCase();
  if (name && !s.subject.toLowerCase().includes(name)) out.push("the account name is not in the subject");
  if (name && !s.body.toLowerCase().includes(name)) out.push("the account name is not in the body");
  if (questions(s.body) !== 1) out.push(`${questions(s.body)} questions, not exactly one`);
  for (const d of DONTS) if (d.test(s, ctx)) out.push(d.why);
  return out;
}
