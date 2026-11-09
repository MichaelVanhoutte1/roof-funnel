/**
 * Admin API behind the bearer ADMIN_TOKEN (the private /admin/ page is its only client):
 *   GET  /admin/report?from=<ISO>&to=<ISO>   lead tracking report
 *   GET  /admin/leads?from=<ISO>&to=<ISO>    the leads behind it (personal data)
 *   GET  /admin/rules · POST /admin/rules    disqualification rules
 *   POST /admin/sync                         pull outcomes from GHL / Fathom / Google Meet now
 */
import { buildReport, leadOutcome, type ReportLead } from "./report.ts";
import { DEFAULT_RULES, normalizeRules, RULE_QUESTIONS, type Rules } from "./rules.ts";
import { runOutcomeSync, type SyncEnv } from "./outcomes.ts";

export type AdminEnv = SyncEnv & {
  ADMIN_TOKEN?: string;
  SIMPLECHECK_API_TOKEN?: string;
  SIMPLECHECK_MODE?: string;
  RL_EVENTS?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
};

type Json = (data: unknown, status: number, headers: Record<string, string>) => Response;

const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const RULES_TTL_MS = 30_000;
let rulesCache: { rules: Rules; at: number } | null = null;

/** The current rules; a missing or unreadable row means the defaults (only the "No" capital answer is turned away). */
export async function loadRules(db: D1Database): Promise<Rules> {
  if (rulesCache && Date.now() - rulesCache.at < RULES_TTL_MS) return rulesCache.rules;
  let rules = DEFAULT_RULES;
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'rules'").first<{ value: string }>();
    if (row?.value) rules = normalizeRules(JSON.parse(row.value));
  } catch (err) {
    console.error("[rules] could not load, using defaults:", String(err).slice(0, 160));
    return DEFAULT_RULES; // not cached: try again on the next request
  }
  rulesCache = { rules, at: Date.now() };
  return rules;
}

async function saveRules(db: D1Database, raw: unknown): Promise<Rules> {
  const rules = normalizeRules(raw);
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('rules', ?1, ${SQL_NOW})
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(JSON.stringify(rules)).run();
  rulesCache = { rules, at: Date.now() };
  return rules;
}

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function isoParam(v: string | null, fallback: string): string {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

const REPORT_COLUMNS = `status, route, dq_reason, timeline, business_owner, capital, tracking, appointment_id, appointment_start,
  pipeline_stage, opportunity_status, opportunity_value, setter_calls, setter_call_seconds, closer_appointment_id, closer_start,
  closer_status, closer_attended, credit_status, credit_score, credit_offer_amount_1, credit_offer_amount_2`;

type LeadListRow = ReportLead & { id: number; created_at: string; name: string | null; city: string | null; closer_attended_source: string | null };

export async function handleAdmin(request: Request, env: AdminEnv, path: string, cors: Record<string, string>, json: Json): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (env.RL_EVENTS) {
    try {
      const { success } = await env.RL_EVENTS.limit({ key: `admin:${ip}` });
      if (!success) return json({ ok: false, error: "Too many requests" }, 429, cors);
    } catch { /* limiter unavailable: the token check below still applies */ }
  }
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!env.ADMIN_TOKEN || !token || !safeEqual(token, env.ADMIN_TOKEN)) return json({ ok: false, error: "Unauthorized" }, 401, cors);

  const url = new URL(request.url);
  const nowIso = new Date().toISOString();
  const from = isoParam(url.searchParams.get("from"), "1970-01-01T00:00:00.000Z");
  const to = isoParam(url.searchParams.get("to"), "9999-12-31T00:00:00.000Z");

  if (request.method === "GET" && path === "/admin/report") {
    const { results } = await env.DB.prepare(
      `SELECT ${REPORT_COLUMNS} FROM leads WHERE created_at >= ?1 AND created_at < ?2 LIMIT 20000`,
    ).bind(from, to).all<ReportLead>();
    const sync = await env.DB.prepare("SELECT value FROM settings WHERE key = 'sync_status'").first<{ value: string }>();
    return json({
      ok: true, from, to, generatedAt: nowIso, report: buildReport(results, nowIso),
      sync: sync?.value ? JSON.parse(sync.value) : null,
      connections: {
        ghl: !!(env.GHL_PIT && env.GHL_LOCATION_ID),
        simplecheck: !!env.SIMPLECHECK_API_TOKEN && (env.SIMPLECHECK_MODE ?? "on").toLowerCase() !== "off",
        fathom: !!env.FATHOM_API_KEY,
        googleMeet: !!(env.GOOGLE_MEET_CLIENT_ID && env.GOOGLE_MEET_CLIENT_SECRET && env.GOOGLE_MEET_REFRESH_TOKENS),
      },
    }, 200, cors);
  }

  if (request.method === "GET" && path === "/admin/leads") {
    const { results } = await env.DB.prepare(
      `SELECT id, created_at, name, city, closer_attended_source, ${REPORT_COLUMNS} FROM leads
       WHERE created_at >= ?1 AND created_at < ?2 ORDER BY id DESC LIMIT 500`,
    ).bind(from, to).all<LeadListRow>();
    const leads = results.map((l) => {
      const o = leadOutcome(l, nowIso);
      return {
        id: l.id, created_at: l.created_at, name: l.name, city: l.city, status: l.status, route: l.route, dq_reason: l.dq_reason,
        timeline: l.timeline, business_owner: l.business_owner, capital: l.capital,
        credit_status: l.credit_status, credit_score: l.credit_score, credit_offer: l.credit_offer_amount_1,
        appointment_start: l.appointment_start, pipeline_stage: l.pipeline_stage,
        setter_call_seconds: l.setter_call_seconds, setter_calls: l.setter_calls,
        setter: !o.booked ? null : o.setterShowed ? "showed" : o.setterNoShow ? "no_show" : "pending",
        closer_start: l.closer_start,
        closer: !o.toCloser ? null : o.closerShowed ? "showed" : o.closerNoShow ? "no_show" : "pending",
        closer_source: l.closer_attended_source,
        won: o.won, cash: o.cash,
      };
    });
    return json({ ok: true, from, to, leads }, 200, cors);
  }

  if (request.method === "GET" && path === "/admin/rules") {
    rulesCache = null; // the editor always reads the stored rules
    return json({ ok: true, rules: await loadRules(env.DB), questions: RULE_QUESTIONS, defaults: DEFAULT_RULES }, 200, cors);
  }

  if (request.method === "POST" && path === "/admin/rules") {
    const body = (await request.json().catch(() => null)) as { rules?: unknown } | null;
    if (!body || typeof body.rules !== "object" || body.rules === null) return json({ ok: false, error: "Bad request" }, 400, cors);
    return json({ ok: true, rules: await saveRules(env.DB, body.rules) }, 200, cors);
  }

  if (request.method === "POST" && path === "/admin/sync") {
    return json({ ok: true, sync: await runOutcomeSync(env) }, 200, cors);
  }

  return json({ ok: false, error: "Not found" }, 404, cors);
}
