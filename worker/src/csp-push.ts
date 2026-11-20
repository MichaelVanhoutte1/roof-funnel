/**
 * Funnel → CSP lead push. The CSP is the system of record for leads; D1 stays the funnel's working store and outbox.
 *
 * Every lead row (D1 `leads`) and email capture (D1 `email_captures`) is POSTed, signed (Standard Webhooks, secret
 * FUNNEL_LEADS_SECRET), to CSP_LEADS_URL as { source, schema, records: [{ kind, d1_id, row }] }. `row` is the D1 row
 * with its column names verbatim (tracking parsed from its JSON), minus the three outbox bookkeeping columns.
 * The CSP answers one result per record: applied / unchanged (acknowledged) or rejected.
 *
 * Change tracking (migration 0014): `csp_changed_at` moves forward on every write to a row, from any write site, by
 * trigger. A row is pending while `csp_synced_updated_at` (the stamp the CSP last acknowledged) is NULL or older.
 * An acknowledged record is marked synced only if its stamp did not move while it was in flight; otherwise it stays
 * pending and goes again. A failure counts `csp_sync_attempts` and keeps the reason in `csp_sync_error`.
 *
 * Two senders: right after a visitor's write (ctx.waitUntil, best effort) and the push cron, which drains whatever is
 * pending (fewest failed tries first, then oldest change) a few batches per run. On first deploy every historical row
 * is pending, so the cron is also the backfill. Nothing here ever throws into the visitor's request, and nothing
 * here writes to GHL.
 *
 * Off unless CSP_LEADS_PUSH_ENABLED = "true" AND CSP_LEADS_URL is an https URL AND FUNNEL_LEADS_SECRET is set.
 */
import { standardWebhookHeaders } from "./webhook-signature.ts";

/** The fourth cron in wrangler.toml, verbatim. */
export const CSP_PUSH_CRON = "*/2 * * * *";
/** Records per request (the CSP accepts at most 100). */
export const PUSH_BATCH = 100;
/** Batches per cron run. Each batch: two selects, one or two POSTs, two mark batches. */
export const CRON_BATCHES = 3;
/** Body cap per request; the CSP refuses more than 1 MB. A bigger batch is split. */
export const MAX_BODY_BYTES = 900_000;
const TIMEOUT_MS = 10_000;

export type CspPushEnv = {
  DB: D1Database;
  CSP_LEADS_PUSH_ENABLED?: string;
  CSP_LEADS_URL?: string;
  FUNNEL_LEADS_SECRET?: string;
};
export type Kind = "lead" | "email_capture";
export type PushRecord = { kind: Kind; d1_id: number; row: Record<string, unknown> };
export type PushSummary = { sent: number; synced: number; failed: number; skipped?: string; error?: string };
type Fetch = typeof fetch;
type Sent = PushRecord & { version: string | null };
type Outcome = { ok: true } | { ok: false; error: string };

const TABLE: Record<Kind, string> = { lead: "leads", email_capture: "email_captures" };
/** Outbox bookkeeping: never part of the row the CSP receives. */
const OUTBOX_COLUMNS = new Set(["csp_synced_updated_at", "csp_sync_attempts", "csp_sync_error"]);
/** Repeated verbatim from the partial index in migration 0014, so the pending scan uses it. */
export const PENDING = "(csp_synced_updated_at IS NULL OR csp_synced_updated_at < csp_changed_at)";
const ORDER = "ORDER BY csp_sync_attempts, csp_changed_at, id";

export function pushConfig(env: CspPushEnv): { url: string; secret: string } | null {
  if ((env.CSP_LEADS_PUSH_ENABLED ?? "").trim().toLowerCase() !== "true") return null;
  const url = (env.CSP_LEADS_URL ?? "").trim();
  const secret = env.FUNNEL_LEADS_SECRET ?? "";
  if (!url || !secret) return null;
  try {
    if (new URL(url).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { url, secret };
}

function parseTracking(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(String(raw));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A D1 row as the CSP receives it: every column verbatim, tracking parsed, outbox bookkeeping left out. */
export function toRecord(kind: Kind, raw: Record<string, unknown>): Sent {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!OUTBOX_COLUMNS.has(k)) row[k] = v;
  if ("tracking" in row) row.tracking = parseTracking(row.tracking);
  const version = typeof raw.csp_changed_at === "string" ? raw.csp_changed_at : null;
  return { kind, d1_id: Number(raw.id), row, version };
}

function body(records: PushRecord[]): string {
  return JSON.stringify({ source: "roof-funnel", schema: 1, records: records.map(({ kind, d1_id, row }) => ({ kind, d1_id, row })) });
}

/** Splits records into requests of at most PUSH_BATCH records and MAX_BODY_BYTES. */
export function chunk<T extends PushRecord>(records: T[], maxBytes: number = MAX_BODY_BYTES): T[][] {
  const enc = new TextEncoder();
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const r of records) {
    const size = enc.encode(JSON.stringify({ kind: r.kind, d1_id: r.d1_id, row: r.row })).byteLength + 1;
    if (cur.length && (cur.length >= PUSH_BATCH || bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** One signed POST. Resolves to one outcome per record, in order; a failure of the whole request fails every record. */
async function post(cfg: { url: string; secret: string }, records: Sent[], fetchImpl: Fetch): Promise<Outcome[]> {
  const fail = (error: string): Outcome[] => records.map(() => ({ ok: false, error }));
  const text = body(records);
  let res: Response;
  try {
    res = await fetchImpl(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await standardWebhookHeaders(cfg.secret, text)) },
      body: text,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return fail(`network: ${String(err).slice(0, 160)}`);
  }
  if (!res.ok) return fail(`http_${res.status}`);
  let results: unknown;
  try {
    results = ((await res.json()) as { results?: unknown }).results;
  } catch {
    return fail("bad_response");
  }
  if (!Array.isArray(results)) return fail("bad_response");
  return records.map((r, i): Outcome => {
    const got = results[i] as { kind?: unknown; d1_id?: unknown; status?: unknown; error?: unknown } | undefined;
    if (!got || got.kind !== r.kind || Number(got.d1_id) !== r.d1_id) return { ok: false, error: "no_result" };
    if (got.status === "applied" || got.status === "unchanged") return { ok: true };
    const code = typeof got.error === "string" ? got.error.slice(0, 160) : "unknown";
    return { ok: false, error: got.status === "rejected" ? `rejected: ${code}` : `bad_status: ${String(got.status).slice(0, 40)}` };
  });
}

/** Records the outcomes. A success only marks a row whose stamp is still the one sent. */
async function settle(db: D1Database, sent: Sent[], outcomes: Outcome[]): Promise<number> {
  const statements = sent.map((r, i) => {
    const o = outcomes[i];
    const table = TABLE[r.kind];
    return o.ok
      ? db.prepare(
        `UPDATE ${table} SET csp_synced_updated_at = ?1, csp_sync_attempts = 0, csp_sync_error = NULL
         WHERE id = ?2 AND csp_changed_at IS ?1 AND (csp_synced_updated_at IS NULL OR csp_synced_updated_at < ?1)`,
      ).bind(r.version, r.d1_id)
      : db.prepare(`UPDATE ${table} SET csp_sync_attempts = csp_sync_attempts + 1, csp_sync_error = ?1 WHERE id = ?2`)
        .bind(o.error, r.d1_id);
  });
  let changed = 0;
  for (let i = 0; i < statements.length; i += 50) {
    for (const res of await db.batch(statements.slice(i, i + 50))) changed += res.meta.changes ?? 0;
  }
  return changed;
}

/** Sends records and records the outcomes. Never rejects. */
export async function pushRecords(env: CspPushEnv, records: Sent[], fetchImpl: Fetch = fetch): Promise<PushSummary> {
  const summary: PushSummary = { sent: 0, synced: 0, failed: 0 };
  const cfg = pushConfig(env);
  if (!cfg) return { ...summary, skipped: "off" };
  for (const part of chunk(records)) {
    const outcomes = await post(cfg, part, fetchImpl);
    summary.sent += part.length;
    for (const o of outcomes) {
      if (o.ok) summary.synced++;
      else {
        summary.failed++;
        summary.error ??= o.error;
      }
    }
    try {
      await settle(env.DB, part, outcomes);
    } catch (err) {
      console.error("[csp-push] outcome not recorded:", String(err).slice(0, 160)); // the rows stay pending: sent again
    }
  }
  return summary;
}

async function pendingRows(db: D1Database, kind: Kind, limit: number): Promise<Sent[]> {
  if (limit <= 0) return [];
  const { results } = await db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE ${PENDING} ${ORDER} LIMIT ?1`)
    .bind(limit).all<Record<string, unknown>>();
  return results.map((r) => toRecord(kind, r));
}

/**
 * Push right after a visitor's write: the one row, if it is pending. Best effort and never rejects; the cron sends
 * whatever this misses (switch off, CSP down, a write that lands later).
 */
export async function pushOne(env: CspPushEnv, kind: Kind, where: "id" | "email", key: number | string, fetchImpl: Fetch = fetch): Promise<PushSummary> {
  if (!pushConfig(env)) return { sent: 0, synced: 0, failed: 0, skipped: "off" };
  try {
    const { results } = await env.DB.prepare(`SELECT * FROM ${TABLE[kind]} WHERE ${where} = ?1 AND ${PENDING} LIMIT 1`)
      .bind(key).all<Record<string, unknown>>();
    if (!results.length) return { sent: 0, synced: 0, failed: 0 };
    const summary = await pushRecords(env, results.map((r) => toRecord(kind, r)), fetchImpl);
    if (summary.failed) console.error("[csp-push]", kind, "push failed:", summary.error);
    return summary;
  } catch (err) {
    console.error("[csp-push]", kind, "push failed:", String(err).slice(0, 160));
    return { sent: 0, synced: 0, failed: 0, error: String(err).slice(0, 160) };
  }
}

/**
 * The push cron: pending leads, then pending email captures, up to `batches` batches of PUSH_BATCH. A run stops at
 * the first batch with a failure, so a CSP outage costs one request per run and a row the CSP keeps rejecting is
 * tried at most once per run (it sorts behind every row that has not failed). Never rejects.
 */
export async function drainPending(env: CspPushEnv, fetchImpl: Fetch = fetch, batches: number = CRON_BATCHES): Promise<PushSummary> {
  const total: PushSummary = { sent: 0, synced: 0, failed: 0 };
  if (!pushConfig(env)) return { ...total, skipped: "off" };
  try {
    for (let b = 0; b < batches; b++) {
      const leads = await pendingRows(env.DB, "lead", PUSH_BATCH);
      const records = [...leads, ...(await pendingRows(env.DB, "email_capture", PUSH_BATCH - leads.length))];
      if (!records.length) break;
      const s = await pushRecords(env, records, fetchImpl);
      total.sent += s.sent;
      total.synced += s.synced;
      total.failed += s.failed;
      if (s.error) total.error ??= s.error;
      if (s.failed || records.length < PUSH_BATCH) break;
    }
  } catch (err) {
    total.error = String(err).slice(0, 160); // e.g. migration 0014 not applied yet
  }
  console.log("[csp-push]", JSON.stringify(total));
  return total;
}
