/**
 * Slack, with a bot token. Three calls: post, read a thread, and nothing else.
 *
 * Slack answers 200 with { ok: false } on most failures, so a call that is
 * not ok is thrown with Slack's own error code. "not_in_channel" and
 * "missing_scope" were the two a first install hits; both are named in the
 * README.
 */
export interface Slack {
  post(channel: string, text: string, blocks?: unknown[], threadTs?: string): Promise<{ ts: string; channel: string }>;
  replies(channel: string, ts: string): Promise<{ user?: string; bot_id?: string; text?: string; ts: string }[]>;
  update(channel: string, ts: string, text: string, blocks?: unknown[]): Promise<void>;
  /** Seen only by that person: why a click was refused, without telling the whole channel. */
  ephemeral(channel: string, user: string, text: string, threadTs?: string): Promise<void>;
}

export function slack(token: string, fetchImpl: typeof fetch = fetch): Slack {
  async function call<T>(method: string, body: Record<string, unknown>, get = false): Promise<T> {
    const url = `https://slack.com/api/${method}${get ? `?${new URLSearchParams(body as Record<string, string>)}` : ""}`;
    const res = await fetchImpl(url, {
      method: get ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(get ? {} : { "content-type": "application/json; charset=utf-8" }) },
      body: get ? undefined : JSON.stringify(body),
    });
    const r = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!r.ok) throw new Error(`Slack ${method} failed: ${r.error ?? res.status}`);
    return r;
  }
  return {
    async post(channel, text, blocks, threadTs) {
      const r = await call<{ ts: string; channel: string }>("chat.postMessage", { channel, text, ...(blocks ? { blocks } : {}), ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false });
      return { ts: r.ts, channel: r.channel };
    },
    async replies(channel, ts) {
      return (await call<{ messages: { user?: string; bot_id?: string; text?: string; ts: string }[] }>("conversations.replies", { channel, ts, limit: "200" }, true)).messages;
    },
    async update(channel, ts, text, blocks) {
      await call("chat.update", { channel, ts, text, ...(blocks ? { blocks } : {}) });
    },
    async ephemeral(channel, user, text, threadTs) {
      await call("chat.postEphemeral", { channel, user, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
    },
  };
}

/** One proposed write, as the approval message lists it. */
export interface WriteLine { n: number; summary: string }

export const APPLY_ACTION = "apply_selected";
const PICK_BLOCK = "writes_";
// Slack allows at most 10 options in one checkbox group, and option text of at most 75 characters.
const GROUP = 10;
const OPTION_MAX = 75;

/**
 * The proposed writes as checkboxes and one Apply button. Nothing is ticked to start: the rep chooses,
 * so a careless click on Apply writes nothing (the listener says so and asks them to tick one).
 */
export function approvalBlocks(writes: readonly WriteLine[], planTs: string): unknown[] {
  const groups: WriteLine[][] = [];
  for (let i = 0; i < writes.length; i += GROUP) groups.push(writes.slice(i, i + GROUP));
  return [
    { type: "section", text: { type: "mrkdwn", text: "*Proposed writes.* Nothing is written to Salesforce until you tick what you want and press Apply." } },
    ...groups.map((g, i) => ({
      type: "actions",
      block_id: `${PICK_BLOCK}${i}`,
      elements: [{
        type: "checkboxes",
        action_id: `pick_${i}`,
        options: g.map((w) => {
          const t = `${w.n}. ${w.summary}`;
          return { text: { type: "plain_text", text: t.length > OPTION_MAX ? `${t.slice(0, OPTION_MAX - 1)}…` : t }, value: String(w.n) };
        }),
      }],
    })),
    { type: "actions", block_id: "apply", elements: [{ type: "button", style: "primary", action_id: APPLY_ACTION, value: planTs, text: { type: "plain_text", text: "Apply selected" } }] },
    { type: "context", elements: [{ type: "mrkdwn", text: "Only the person who asked for this plan can apply it. Or reply `approve 1 3` in this thread." }] },
  ];
}

/** The write numbers ticked across every checkbox group of an approval message, sorted, no repeats. */
export function selectedWrites(state: unknown): number[] {
  const values = (state as { values?: Record<string, Record<string, { selected_options?: { value: string }[] }>> } | undefined)?.values ?? {};
  const ns = Object.entries(values)
    .filter(([block]) => block.startsWith(PICK_BLOCK))
    .flatMap(([, actions]) => Object.values(actions).flatMap((a) => a.selected_options ?? []))
    .map((o) => Number(o.value))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ns)].sort((a, b) => a - b);
}

/** Slack's mrkdwn: *bold*, _italic_, <url|text>. Escapes the three characters Slack reserves. */
export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * An approval reply: "approve 1 3 5", "approve 1,3", "approve all".
 * Anything else in the thread is conversation and is ignored.
 */
export function parseApproval(text: string | undefined, max: number): number[] | null {
  const m = /^\s*approve\s+(all|[\d,\s]+)\s*$/i.exec(text ?? "");
  if (!m) return null;
  if (/^all$/i.test(m[1]!)) return Array.from({ length: max }, (_, i) => i + 1);
  const ns = m[1]!.split(/[,\s]+/).filter(Boolean).map(Number);
  return ns.every((n) => Number.isInteger(n) && n >= 1 && n <= max) ? [...new Set(ns)].sort((a, b) => a - b) : null;
}
