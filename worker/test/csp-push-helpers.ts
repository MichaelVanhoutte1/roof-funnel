/** Shared fixtures for the CSP lead push tests: the real migration chain on SQLite, and a fake CSP that orders like the real one. */
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const MIGRATIONS = new URL("../migrations/", import.meta.url);
/** A placeholder of the CSP's minimum length (32), never a real secret. */
export const SECRET = "test-secret-not-real-000000000000";
export const URL_ = "https://csp-api.startroofrejuvenating.com/webhook/funnel-leads";
export const plain = (o: unknown) => ({ ...(o as Record<string, unknown>) });

/* The real migration chain on a real SQLite, behind the slice of the D1 API the Worker uses. */
export function realDb(upTo = "9999"): { db: DatabaseSync; d1: D1Database } {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f.slice(0, 4) <= upTo).sort()) {
    db.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  }
  return { db, d1: wrap(db) };
}

function wrap(db: DatabaseSync): D1Database {
  const exec = (sql: string, args: Array<string | number | null>) => {
    const st = db.prepare(sql);
    return {
      async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      async all() { return { results: st.all(...args).map(plain) }; },
      async first() { const r = st.get(...args); return r ? plain(r) : null; },
    };
  };
  return {
    prepare(sql: string) {
      return { ...exec(sql, []), bind: (...args: Array<string | number | null>) => exec(sql, args) };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

export function insertLead(db: DatabaseSync, i: number, extra: Record<string, string | number | null> = {}): void {
  const cols = { status: "full", phone: `+1312555${String(i).padStart(4, "0")}`, name: `Lead ${i}`, ...extra };
  db.prepare(`INSERT INTO leads (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map(() => "?").join(", ")})`).run(...Object.values(cols));
}

export const on = (d1: D1Database) => ({ DB: d1, CSP_LEADS_PUSH_ENABLED: "true", CSP_LEADS_URL: URL_, FUNNEL_LEADS_SECRET: SECRET });

export type Body = { source: string; schema: number; records: Array<{ kind: string; d1_id: number; row: Record<string, unknown> }> };
export type Delivery = { url: string; headers: Record<string, string>; init: RequestInit; text: string; body: Body };

/**
 * A fake CSP that behaves like the real receiver where it matters: it speaks only `schema` (400 otherwise), and it
 * applies a record only when row.csp_changed_at is strictly newer than what it holds for (kind, d1_id), else
 * "unchanged". `refuse` rejects chosen records; `httpStatus` fails every request. `held` is what the CSP stores.
 */
export function fakeCsp(opts: { refuse?: (r: Body["records"][number]) => string | null; omit?: (r: Body["records"][number]) => boolean; httpStatus?: number; schema?: number } = {}) {
  const deliveries: Delivery[] = [];
  const held = new Map<string, Record<string, unknown>>();
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(init?.body);
    const body = JSON.parse(text) as Body;
    deliveries.push({ url: String(url), headers: init?.headers as Record<string, string>, init: init ?? {}, text, body });
    if (opts.httpStatus && opts.httpStatus !== 200) return new Response("down", { status: opts.httpStatus });
    if (body.schema !== (opts.schema ?? 2)) return new Response(JSON.stringify({ error: "schema" }), { status: 400 });
    const results = body.records.flatMap((r) => {
      if (opts.omit?.(r)) return [];
      const refused = opts.refuse?.(r);
      if (refused) return [{ kind: r.kind, d1_id: r.d1_id, status: "rejected", error: refused }];
      const key = `${r.kind}:${r.d1_id}`;
      const prior = held.get(key);
      const next = String(r.row.csp_changed_at ?? r.row.updated_at);
      if (prior && !(next > String(prior.csp_changed_at ?? prior.updated_at))) return [{ kind: r.kind, d1_id: r.d1_id, status: "unchanged" }];
      held.set(key, r.row);
      return [{ kind: r.kind, d1_id: r.d1_id, status: "applied" }];
    });
    return new Response(JSON.stringify({ results }), { status: 200 });
  }) as typeof fetch;
  return { deliveries, held, fetchImpl };
}

export const pushState = (db: DatabaseSync, table = "leads") =>
  db.prepare(`SELECT id, csp_changed_at IS NOT NULL AS stamped, csp_synced_updated_at = csp_changed_at AS synced, csp_sync_attempts AS attempts, csp_sync_error AS error FROM ${table} ORDER BY id`).all().map(plain);

export function ctx() {
  const waits: Promise<unknown>[] = [];
  return { waits, ctx: { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext };
}

/** Waits for every background task, including the ones registered while waiting. */
export async function settleAll(waits: Promise<unknown>[]): Promise<void> {
  let done = 0;
  while (done < waits.length) {
    const n = waits.length;
    await Promise.all(waits.slice(done, n));
    done = n;
  }
}
