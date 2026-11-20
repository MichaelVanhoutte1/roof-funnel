/**
 * Funnel → CSP lead push. The CSP is the system of record for leads; D1 stays the funnel's working store and outbox.
 *
 * Every lead row (D1 `leads`) and email capture (D1 `email_captures`) is POSTed, signed (Standard Webhooks, secret
 * FUNNEL_LEADS_SECRET), to CSP_LEADS_URL as { source, schema: 2, records: [{ kind, d1_id, row }] }. `row` holds the
 * allowlisted columns under their D1 names (csp-push-columns.ts). The CSP answers one result per record: applied /
 * unchanged (acknowledged) or rejected.
 *
 * Ordering (schema 2): the CSP applies a record only when `row.csp_changed_at` is strictly newer than what it holds.
 * `updated_at` moves only on a survey save or a booking, so ordering on it would drop every later write (credit
 * result, route, GHL status, outcome sync) as "unchanged". A CSP that only knows schema 1 answers 400 to the whole
 * request, so the rows stay pending instead of being lost.
 *
 * Change tracking (migration 0014): `csp_changed_at` moves forward on every write to a row, from any write site, by
 * trigger. A row is pending while `csp_synced_updated_at` (the stamp the CSP last acknowledged) is NULL or older.
 * An acknowledged record is marked synced only if its stamp did not move while it was in flight; otherwise it stays
 * pending and goes again. A failure counts `csp_sync_attempts` and keeps the reason in `csp_sync_error`; a record the
 * CSP refused also waits (`csp_next_attempt_at`, 2 min doubling to 24 h) unless the row changes again.
 *
 * Two senders: right after a visitor's write (ctx.waitUntil, best effort) and the push cron, which drains whatever is
 * pending, a few batches per run, half of each batch kept for email captures. On first deploy every historical row
 * is pending, so the cron is also the backfill. Failures reach Slack through csp-push-health.ts. Nothing here ever
 * throws into the visitor's request, and nothing here writes to GHL.
 *
 * Off unless CSP_LEADS_PUSH_ENABLED = "true" AND CSP_LEADS_URL is https on the roof CSP API host AND
 * FUNNEL_LEADS_SECRET is at least SECRET_MIN_LENGTH characters.
 */
import { cspRow, type Kind, PENDING, SENT_COLUMNS } from "./csp-push-columns.ts";
import { recordRun } from "./csp-push-health.ts";
import { standardWebhookHeaders } from "./webhook-signature.ts";

/** The fourth cron in wrangler.toml, verbatim. */
export const CSP_PUSH_CRON = "*/2 * * * *";
/** Envelope version: 2 = ordered on row.csp_changed_at. */
export const SCHEMA_VERSION = 2;
/** The only host the production Worker may send lead PII to: the roof CSP's production API, never staging. */
export const CSP_HOSTS: readonly string[] = ["csp-api.startroofrejuvenating.com"];
/** The CSP refuses a shorter secret (503 on every delivery); the same floor here makes it a config error instead. */
export const SECRET_MIN_LENGTH = 32;
/** Records per request (the CSP accepts at most 100). */
export const PUSH_BATCH = 100;
/** Batches per cron run. */
export const CRON_BATCHES = 3;
/** Body cap per request; the CSP refuses more than 1 MB. A bigger batch is split. */
export const MAX_BODY_BYTES = 900_000;
const TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MINUTES = 24 * 60;

export type CspPushEnv = {
  DB: D1Database;
  CSP_LEADS_PUSH_ENABLED?: string;
  CSP_LEADS_URL?: string;
  FUNNEL_LEADS_SECRET?: string;
  /** Where push failures are reported (the #lead-alerts webhook). Unset = log only. */
  SLACK_LEAD_ALERTS_WEBHOOK?: string;
};
export { PENDING, type Kind };
export type PushRecord = { kind: Kind; d1_id: number; row: Record<string, unknown> };
export type PushSummary = { sent: number; synced: number; failed: number; skipped?: string; error?: string };
export type PushConfig = { url: string; secret: string };
type Fetch = typeof fetch;
type Sent = PushRecord & { version: string | null; attempts: number };
/** "request" = the whole request failed (CSP down, 4xx/5xx, bad body); "record" = the CSP refused this one record. */
type Outcome = { ok: true } | { ok: false; error: string; scope: "request" | "record" };
type BatchResult = { summary: PushSummary; requestsOk: number; requestsFailed: number };

const TABLE: Record<Kind, string> = { lead: "leads", email_capture: "email_captures" };
const DUE = "(csp_next_attempt_at IS NULL OR csp_next_attempt_at <= ?2)";
const ORDER = "ORDER BY csp_sync_attempts, csp_changed_at, id";

/** The config, or why there is none: "off" (switch not "true"), else a misconfiguration worth reporting. */
export function pushSetup(env: CspPushEnv): { cfg: PushConfig } | { off: string } {
  if ((env.CSP_LEADS_PUSH_ENABLED ?? "").trim().toLowerCase() !== "true") return { off: "off" };
  const url = (env.CSP_LEADS_URL ?? "").trim();
  const secret = (env.FUNNEL_LEADS_SECRET ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { off: "config: CSP_LEADS_URL missing or not a URL" };
  }
  if (parsed.protocol !== "https:") return { off: "config: CSP_LEADS_URL is not https" };
  if (!CSP_HOSTS.includes(parsed.hostname)) return { off: "config: CSP_LEADS_URL is not the roof CSP API host" };
  if (!secret) return { off: "config: FUNNEL_LEADS_SECRET missing" };
  if (secret.length < SECRET_MIN_LENGTH) return { off: "config: FUNNEL_LEADS_SECRET too short" };
  return { cfg: { url, secret } };
}

export function pushConfig(env: CspPushEnv): PushConfig | null {
  const s = pushSetup(env);
  return "cfg" in s ? s.cfg : null;
}

/** A D1 row as the CSP receives it; `version` is the stamp the acknowledgement is checked against. */
export function toRecord(kind: Kind, raw: Record<string, unknown>): Sent {
  const version = typeof raw.csp_changed_at === "string" && raw.csp_changed_at ? raw.csp_changed_at : null;
  return { kind, d1_id: Number(raw.id), row: cspRow(kind, raw), version, attempts: Number(raw.csp_sync_attempts ?? 0) || 0 };
}

function body(records: PushRecord[]): string {
  return JSON.stringify({
    source: "roof-funnel", schema: SCHEMA_VERSION, records: records.map(({ kind, d1_id, row }) => ({ kind, d1_id, row })),
  });
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

/** Half of every batch is kept for email captures, so neither kind can starve the other. */
export function fairShare<T>(leads: T[], captures: T[], size: number = PUSH_BATCH): T[] {
  const captureTake = Math.min(captures.length, Math.max(Math.floor(size / 2), size - leads.length));
  return [...leads.slice(0, size - captureTake), ...captures.slice(0, captureTake)];
}

/** Wait before retrying a refused record, after its `attempts`-th failure: 2, 4, 8 … minutes, at most 24 h. */
export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MINUTES, 2 ** Math.min(Math.max(attempts, 1), 11)) * 60_000;
}

/** One signed POST. Resolves to one outcome per record, in order; a failure of the whole request fails every record. */
async function post(cfg: PushConfig, records: Sent[], fetchImpl: Fetch): Promise<Outcome[]> {
  const fail = (error: string): Outcome[] => records.map(() => ({ ok: false, error, scope: "request" }));
  const text = body(records);
  let res: Response;
  try {
    res = await fetchImpl(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await standardWebhookHeaders(cfg.secret, text)) },
      body: text,
      // Never re-POST the signed PII body to wherever a Location header points: a 3xx fails like any non-2xx.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return fail(`network: ${String(err).slice(0, 160)}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return fail(`http_${res.status}`);
  }
  let results: unknown;
  try {
    results = ((await res.json()) as { results?: unknown }).results;
  } catch {
    return fail("bad_response");
  }
  if (!Array.isArray(results)) return fail("bad_response");
  return records.map((r, i): Outcome => {
    const got = results[i] as { kind?: unknown; d1_id?: unknown; status?: unknown; error?: unknown } | undefined;
    if (!got || got.kind !== r.kind || Number(got.d1_id) !== r.d1_id) return { ok: false, error: "no_result", scope: "record" };
    if (got.status === "applied" || got.status === "unchanged") return { ok: true };
    const code = typeof got.error === "string" ? got.error.slice(0, 160) : "unknown";
    const error = got.status === "rejected" ? `rejected: ${code}` : `bad_status: ${String(got.status).slice(0, 40)}`;
    return { ok: false, error, scope: "record" };
  });
}

/**
 * Records the outcomes, each only against the stamp that was sent: a row that changed meanwhile is left pending and
 * untouched, so the newer data goes next without a stale failure counted against it.
 */
async function settle(db: D1Database, sent: Sent[], outcomes: Outcome[], nowMs: number): Promise<void> {
  const statements = sent.map((r, i) => {
    const o = outcomes[i];
    const table = TABLE[r.kind];
    if (o.ok) {
      return db.prepare(
        `UPDATE ${table} SET csp_synced_updated_at = ?1, csp_sync_attempts = 0, csp_sync_error = NULL, csp_next_attempt_at = NULL
         WHERE id = ?2 AND csp_changed_at IS ?1 AND (csp_synced_updated_at IS NULL OR csp_synced_updated_at < ?1)`,
      ).bind(r.version, r.d1_id);
    }
    // A refused record waits; a failed request does not (the run already stops after one failed request).
    const next = o.scope === "record" ? new Date(nowMs + backoffMs(r.attempts + 1)).toISOString() : null;
    return db.prepare(
      `UPDATE ${table} SET csp_sync_attempts = csp_sync_attempts + 1, csp_sync_error = ?1, csp_next_attempt_at = COALESCE(?4, csp_next_attempt_at)
       WHERE id = ?2 AND csp_changed_at IS ?3`,
    ).bind(o.error, r.d1_id, r.version, next);
  });
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
}

async function pushBatch(env: CspPushEnv, cfg: PushConfig, records: Sent[], fetchImpl: Fetch): Promise<BatchResult> {
  const out: BatchResult = { summary: { sent: 0, synced: 0, failed: 0 }, requestsOk: 0, requestsFailed: 0 };
  const s = out.summary;
  const count = (o: Outcome) => {
    if (o.ok) s.synced++;
    else {
      s.failed++;
      s.error ??= o.error;
    }
  };
  const record = async (batch: Sent[], outcomes: Outcome[]) => {
    outcomes.forEach(count);
    try {
      await settle(env.DB, batch, outcomes, Date.now());
    } catch (err) {
      console.error("[csp-push] outcome not recorded:", String(err).slice(0, 160)); // the rows stay pending: sent again
    }
  };
  // A row without a stamp could never be marked synced; it is reported instead of sent (migration 0014 prevents it).
  const unstamped = records.filter((r) => r.version === null);
  if (unstamped.length) await record(unstamped, unstamped.map(() => ({ ok: false, error: "no_version", scope: "record" })));
  for (const part of chunk(records.filter((r) => r.version !== null))) {
    const outcomes = await post(cfg, part, fetchImpl);
    s.sent += part.length;
    if (outcomes.some((o) => !o.ok && o.scope === "request")) out.requestsFailed++;
    else out.requestsOk++;
    await record(part, outcomes);
    if (out.requestsFailed) break; // the rest stays pending for the next run
  }
  return out;
}

/** Sends records and records the outcomes. Never rejects. */
export async function pushRecords(env: CspPushEnv, records: Sent[], fetchImpl: Fetch = fetch): Promise<PushSummary> {
  const cfg = pushConfig(env);
  if (!cfg) return { sent: 0, synced: 0, failed: 0, skipped: "off" };
  return (await pushBatch(env, cfg, records, fetchImpl)).summary;
}

const SELECT = (kind: Kind) => `SELECT ${SENT_COLUMNS[kind].join(", ")}, csp_sync_attempts FROM ${TABLE[kind]}`;

async function pendingRows(db: D1Database, kind: Kind, limit: number, nowIso: string): Promise<Sent[]> {
  const { results } = await db.prepare(`${SELECT(kind)} WHERE ${PENDING} AND ${DUE} ${ORDER} LIMIT ?1`)
    .bind(limit, nowIso).all<Record<string, unknown>>();
  return results.map((r) => toRecord(kind, r));
}

/**
 * Push right after a visitor's write: the one row, if it is pending. Best effort and never rejects; the cron sends
 * whatever this misses (switch off, CSP down, a write that lands later).
 */
export async function pushOne(env: CspPushEnv, kind: Kind, where: "id" | "email", key: number | string, fetchImpl: Fetch = fetch): Promise<PushSummary> {
  if (!pushConfig(env)) return { sent: 0, synced: 0, failed: 0, skipped: "off" };
  try {
    const { results } = await env.DB.prepare(`${SELECT(kind)} WHERE ${where} = ?1 AND ${PENDING} LIMIT 1`)
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
 * The push cron: up to `batches` batches of PUSH_BATCH, each shared fairly between leads and email captures. A run
 * stops at the first failed request, so a CSP outage costs one request per run; a refused record does not stop the
 * run (it waits out its backoff instead). Every run reports to csp-push-health.ts. Never rejects.
 */
export async function drainPending(env: CspPushEnv, fetchImpl: Fetch = fetch, batches: number = CRON_BATCHES): Promise<PushSummary> {
  const total: PushSummary = { sent: 0, synced: 0, failed: 0 };
  const setup = pushSetup(env);
  if ("off" in setup) {
    if (setup.off === "off") return { ...total, skipped: "off" };
    console.error("[csp-push] switched on but not configured:", setup.off);
    await recordRun(env, { requestsOk: 0, requestsFailed: 1, error: setup.off }, Date.now(), fetchImpl);
    return { ...total, skipped: setup.off };
  }
  let requestsOk = 0;
  let requestsFailed = 0;
  try {
    for (let b = 0; b < batches; b++) {
      const nowIso = new Date().toISOString();
      const leads = await pendingRows(env.DB, "lead", PUSH_BATCH, nowIso);
      const captures = await pendingRows(env.DB, "email_capture", PUSH_BATCH, nowIso);
      const records = fairShare(leads, captures);
      if (!records.length) break;
      const r = await pushBatch(env, setup.cfg, records, fetchImpl);
      total.sent += r.summary.sent;
      total.synced += r.summary.synced;
      total.failed += r.summary.failed;
      if (r.summary.error) total.error ??= r.summary.error;
      requestsOk += r.requestsOk;
      requestsFailed += r.requestsFailed;
      if (r.requestsFailed || leads.length + captures.length <= PUSH_BATCH) break;
    }
  } catch (err) {
    total.error = String(err).slice(0, 160); // e.g. migration 0014 not applied yet
    requestsFailed++;
  }
  console.log("[csp-push]", JSON.stringify(total));
  await recordRun(env, { requestsOk, requestsFailed, error: total.error }, Date.now(), fetchImpl);
  return total;
}
