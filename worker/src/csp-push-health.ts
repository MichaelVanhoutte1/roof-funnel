/**
 * Is the lead push keeping the CSP (the system of record) up to date? Every push cron run reports here. Two problems
 * reach #lead-alerts, each at most once every ALERT_EVERY_MS while it lasts:
 *  - the push has failed for OUTAGE_ALERT_AFTER_MS straight (CSP down, 401 from a secret mismatch, a CSP that does
 *    not speak schema 2, the switch on with a bad URL or secret, migration 0014 missing);
 *  - the CSP refuses records (each waits out its backoff and is retried; a refused lead is missing on the CSP).
 * Messages carry counts and error codes only (the CSP's codes name a column, never a value). State lives in
 * settings.csp_push_health; the admin report shows the same numbers (pushReport).
 */
import type { CspPushEnv } from "./csp-push.ts";
import { PENDING } from "./csp-push-columns.ts";
import { cspPushProblemMessage, postSlack } from "./slack.ts";

export const OUTAGE_ALERT_AFTER_MS = 30 * 60_000;
export const ALERT_EVERY_MS = 6 * 60 * 60_000;
const KEY = "csp_push_health";
const TABLES = ["leads", "email_captures"] as const;

export type PushHealth = {
  failing_since: string | null;
  last_error: string | null;
  last_ok_at: string | null;
  outage_alerted_at: string | null;
  rejected_alerted_at: string | null;
};
export type RunReport = { requestsOk: number; requestsFailed: number; error?: string };

const EMPTY: PushHealth = { failing_since: null, last_error: null, last_ok_at: null, outage_alerted_at: null, rejected_alerted_at: null };

async function readHealth(db: D1Database): Promise<PushHealth> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?1").bind(KEY).first<{ value: string }>();
  if (!row?.value) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(row.value) as Partial<PushHealth>) };
  } catch {
    return { ...EMPTY };
  }
}

/** Pending and refused rows, both tables, over the pending partial index only. */
export async function pushBacklog(db: D1Database): Promise<{ pending: number; rejected: number; codes: string[] }> {
  let pending = 0;
  let rejected = 0;
  const codes = new Set<string>();
  for (const t of TABLES) {
    const r = await db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(csp_sync_error LIKE 'rejected:%'), 0) AS rejected FROM ${t} WHERE ${PENDING}`,
    ).first<{ n: number; rejected: number }>();
    pending += Number(r?.n ?? 0);
    rejected += Number(r?.rejected ?? 0);
    if (Number(r?.rejected ?? 0) > 0) {
      const { results } = await db.prepare(
        `SELECT DISTINCT csp_sync_error AS e FROM ${t} WHERE ${PENDING} AND csp_sync_error LIKE 'rejected:%' LIMIT 5`,
      ).all<{ e: string }>();
      for (const x of results) codes.add(String(x.e).slice(0, 80));
    }
  }
  return { pending, rejected, codes: [...codes].slice(0, 5) };
}

const older = (iso: string | null, nowMs: number, ms: number) => !iso || nowMs - Date.parse(iso) >= ms;

/** Updates the state after a cron run and sends what is due. Never rejects. */
export async function recordRun(env: CspPushEnv, run: RunReport, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const before = await readHealth(env.DB);
    const h = { ...before };
    const now = new Date(nowMs).toISOString();
    if (run.requestsOk > 0) {
      h.failing_since = null;
      h.last_ok_at = now;
    } else if (run.requestsFailed > 0) {
      h.failing_since ??= now;
      h.last_error = (run.error ?? "unknown").slice(0, 160);
    } else {
      h.failing_since = null; // nothing was due: nothing is diverging
    }
    let backlog = { pending: 0, rejected: 0, codes: [] as string[] };
    try {
      backlog = await pushBacklog(env.DB);
    } catch { /* migration 0014 missing: the failed run above already says so */ }
    const webhook = env.SLACK_LEAD_ALERTS_WEBHOOK;
    // true = reported (sent, or logged only when no webhook is set), so the throttle also quiets the log line
    const send = async (msg: Record<string, unknown>): Promise<boolean> => {
      if (!webhook) return true;
      try {
        await postSlack(webhook, msg, fetchImpl);
        return true;
      } catch (err) {
        console.error("[csp-push] alert not sent:", String(err).slice(0, 120));
        return false;
      }
    };
    if (h.failing_since && nowMs - Date.parse(h.failing_since) >= OUTAGE_ALERT_AFTER_MS && older(h.outage_alerted_at, nowMs, ALERT_EVERY_MS)) {
      console.error("[csp-push] failing since", h.failing_since, h.last_error, "pending:", backlog.pending);
      if (await send(cspPushProblemMessage({ kind: "outage", since: h.failing_since, error: h.last_error, pending: backlog.pending }))) h.outage_alerted_at = now;
    }
    if (backlog.rejected > 0 && older(h.rejected_alerted_at, nowMs, ALERT_EVERY_MS)) {
      console.error("[csp-push] refused by the CSP:", backlog.rejected, backlog.codes.join(", "));
      if (await send(cspPushProblemMessage({ kind: "rejected", rejected: backlog.rejected, codes: backlog.codes }))) h.rejected_alerted_at = now;
    }
    if (JSON.stringify(h) !== JSON.stringify(before)) {
      await env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(KEY, JSON.stringify(h)).run();
    }
  } catch (err) {
    console.error("[csp-push] health not recorded:", String(err).slice(0, 160));
  }
}

/** For the admin report: the push state and the backlog, or null when the push cannot be read (pre-0014). */
export async function pushReport(env: CspPushEnv & { CSP_LEADS_PUSH_ENABLED?: string }): Promise<Record<string, unknown> | null> {
  try {
    const [h, backlog] = [await readHealth(env.DB), await pushBacklog(env.DB)];
    return {
      enabled: (env.CSP_LEADS_PUSH_ENABLED ?? "").trim().toLowerCase() === "true",
      pending: backlog.pending, rejected: backlog.rejected, rejectedCodes: backlog.codes,
      failingSince: h.failing_since, lastError: h.last_error, lastOkAt: h.last_ok_at,
    };
  } catch {
    return null;
  }
}
