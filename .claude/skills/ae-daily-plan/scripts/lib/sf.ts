/**
 * Salesforce, as the person who is logged in to the `sf` CLI.
 *
 * The CLI holds the session; this asks it once for the instance and token
 * and then talks to the REST API directly, which is far faster than one CLI
 * process per query. The token stays in memory and is never printed or
 * written to disk. Every read and write runs as that user, so Salesforce's
 * own sharing and field security decide what the plan can see and change.
 */
import { execFileSync } from "node:child_process";

export interface Sf {
  instanceUrl: string;
  username: string;
  query<T>(soql: string): Promise<T[]>;
  create(sobject: string, fields: Record<string, unknown>): Promise<string>;
  update(sobject: string, id: string, fields: Record<string, unknown>): Promise<void>;
  /** Used only by the seed script's --reset, on records it created. */
  remove(sobject: string, id: string): Promise<void>;
}

const API = "v60.0";

export function connect(alias: string): Sf {
  let out: string;
  try {
    out = execFileSync("sf", ["org", "display", "--json", "--target-org", alias], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(`Salesforce org "${alias}" is not logged in. Run: sf org login web --alias ${alias}\n${e instanceof Error ? e.message.split("\n")[0] : ""}`);
  }
  const r = (JSON.parse(out) as { result: { accessToken: string; instanceUrl: string; username: string } }).result;
  const base = `${r.instanceUrl}/services/data/${API}`;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path.startsWith("http") ? path : `${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${r.accessToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Salesforce ${method} ${path.split("?")[0]} answered ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  return {
    instanceUrl: r.instanceUrl,
    username: r.username,
    async query<T>(soql: string): Promise<T[]> {
      type Page = { records: T[]; nextRecordsUrl?: string };
      let page = await call<Page>("GET", `/query?q=${encodeURIComponent(soql)}`);
      const rows = [...page.records];
      // A book of more than 2,000 rows comes in pages; stopping at the first would silently shorten it.
      while (page.nextRecordsUrl) { page = await call<Page>("GET", `${r.instanceUrl}${page.nextRecordsUrl}`); rows.push(...page.records); }
      return rows;
    },
    async create(sobject, fields) {
      return (await call<{ id: string }>("POST", `/sobjects/${sobject}`, fields)).id;
    },
    async update(sobject, id, fields) {
      await call("PATCH", `/sobjects/${sobject}/${id}`, fields);
    },
    async remove(sobject, id) {
      await call("DELETE", `/sobjects/${sobject}/${id}`);
    },
  };
}

/** A value inside a SOQL string literal. */
export const q = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
