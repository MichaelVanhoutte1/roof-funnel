/**
 * Cortana (ad attribution) step webhooks. CORTANA_WEBHOOKS maps an event name to the webhook URL of that step in
 * Cortana; a name with no URL is never posted. Two kinds of event:
 *
 *  - survey steps (q1..q5, email, phone, qualified): relayed as they happen by POST /event and the lead handlers;
 *  - stage milestones (setter_self_booked, setter_qualified, setter_disqualified, closer_booked): read off the lead
 *    row — the funnel's own booking, the GHL pipeline stage, the closer appointment the outcome sync copied — and
 *    posted once per lead by a cron pass (plus straight away for the funnel's own booking). That is what fills
 *    Cortana's stage columns; without it they stay at 0 (seen 2026-11-10).
 *
 * Every body carries the lead at the top level (email / phone / first_name / last_name): Cortana reads it there.
 */
import { stagesWith } from "./report.ts";

export type Tracking = Record<string, string | number | undefined>;

export type CortanaEnv = { DB: D1Database; CORTANA_WEBHOOKS?: string };

export const MILESTONE_EVENTS = ["setter_self_booked", "setter_qualified", "setter_disqualified", "closer_booked"] as const;
export type MilestoneEvent = (typeof MILESTONE_EVENTS)[number];

/** Most milestone posts in one cron pass: 4 selects + 3 calls per lead (claim, webhook, mark) stay under the 50-subrequest cap. */
export const MILESTONE_BATCH = 14;
/** A claim this old with no sent_at (a pass that died mid-flight, or a failed webhook) is taken over by the next pass. */
const STALE_CLAIM = "-1 hour";
/** Posts tried for one (lead, event) before it is left alone (hourly: a lead Cortana keeps refusing stops after a day). */
export const MAX_ATTEMPTS = 24;
/** The clause shared by the claim upsert and the pass's select: a claim row counts as open again when this holds. */
function reclaimable(col: (name: string) => string = (n) => n): string {
  return `${col("sent_at")} IS NULL AND ${col("attempts")} < ${MAX_ATTEMPTS} AND ${col("claimed_at")} < strftime('%Y-%m-%dT%H:%M:%fZ','now','${STALE_CLAIM}')`;
}
const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export function webhookMap(raw: string | undefined): Record<string, string> {
  try {
    const m = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) if (typeof v === "string" && /^https:\/\//.test(v)) out[k] = v;
    return out;
  } catch { return {}; }
}

/** The lead at the top level of the body (Cortana reads it there), plus flattened tracking. */
export function eventPayload(event: string, fields: Record<string, unknown>, tracking: Tracking | undefined, country: string | null): Record<string, unknown> {
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    event,
    timestamp: new Date().toISOString(),
    ...fields,
    ...(parts[0] ? { first_name: parts[0] } : {}),
    ...(parts.length > 1 ? { last_name: parts.slice(1).join(" ") } : {}),
    ...(country ? { ip_country: country } : {}),
    ...(tracking ?? {}),
  };
}

/** Posts one event to its webhook. True when Cortana answered 2xx; false on any failure (logged, never thrown). */
export async function relayEvent(env: Pick<CortanaEnv, "CORTANA_WEBHOOKS">, event: string, payload: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const url = webhookMap(env.CORTANA_WEBHOOKS)[event];
  if (!url) return false;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) return true;
    console.error("[event]", event, "webhook", res.status, (await res.text().catch(() => "")).slice(0, 200));
    return false;
  } catch (err) {
    console.error("[event]", event, "webhook failed:", String(err).slice(0, 200));
    return false;
  }
}

/* ---------------- stage milestones ---------------- */

export type MilestoneRow = {
  id: number;
  name: string | null;
  email: string | null;
  phone: string;
  city: string | null;
  timeline: string | null;
  business_owner: string | null;
  capital: string | null;
  /** JSON as stored on the lead. */
  tracking: string | null;
  country: string | null;
  pipeline_stage: string | null;
  pipeline_stage_at: string | null;
  booked_at: string | null;
  appointment_start: string | null;
  closer_start: string | null;
};

export const MILESTONE_COLUMNS =
  "id, name, email, phone, city, timeline, business_owner, capital, tracking, country, pipeline_stage, pipeline_stage_at, booked_at, appointment_start, closer_start";

function stageList(fact: Parameters<typeof stagesWith>[0]): string {
  return stagesWith(fact).map((s) => `'${s}'`).join(", ");
}

/**
 * The SQL that says a lead reached the milestone, mirroring report.ts (the same stage table decides both):
 *  setter_self_booked  the lead booked its setter call through the funnel;
 *  setter_qualified    the setter passed it on (Setter Qualified or any later stage, or a closer call on the calendar);
 *  setter_disqualified the setter turned it away;
 *  closer_booked       a closer call is booked (calendar or Closer Booked onwards).
 */
export function milestoneWhere(event: MilestoneEvent): string {
  switch (event) {
    case "setter_self_booked": return "booked_at IS NOT NULL";
    case "setter_qualified": return `(LOWER(TRIM(pipeline_stage)) IN (${stageList("toCloser")}) OR closer_appointment_id IS NOT NULL)`;
    case "setter_disqualified": return `LOWER(TRIM(pipeline_stage)) IN (${stageList("setterDq")})`;
    case "closer_booked": return `(LOWER(TRIM(pipeline_stage)) IN (${stageList("closerBooked")}) OR closer_appointment_id IS NOT NULL)`;
  }
}

function stageSays(row: MilestoneRow, fact: Parameters<typeof stagesWith>[0]): boolean {
  return stagesWith(fact).includes((row.pipeline_stage ?? "").trim().toLowerCase());
}

/** When the milestone happened, as far as the row knows; null = unknown (the post is stamped with now). */
export function milestoneAt(event: MilestoneEvent, row: MilestoneRow): string | null {
  switch (event) {
    case "setter_self_booked": return row.booked_at;
    case "setter_qualified": return stageSays(row, "toCloser") ? row.pipeline_stage_at : null;
    case "setter_disqualified": return row.pipeline_stage_at;
    case "closer_booked": return stageSays(row, "closerBooked") ? row.pipeline_stage_at : null;
  }
}

function parseTracking(raw: string | null): Tracking | undefined {
  if (!raw) return undefined;
  try {
    const t = JSON.parse(raw) as unknown;
    if (!t || typeof t !== "object") return undefined;
    const out: Tracking = {};
    for (const [k, v] of Object.entries(t as Record<string, unknown>)) if (typeof v === "string" || typeof v === "number") out[k] = v;
    return Object.keys(out).length ? out : undefined;
  } catch { return undefined; }
}

export function milestonePayload(event: MilestoneEvent, row: MilestoneRow): Record<string, unknown> {
  const tracking = parseTracking(row.tracking);
  const at = milestoneAt(event, row);
  const fields: Record<string, unknown> = {
    lead_id: row.id, session_id: tracking?.session_id, city: row.city, timeline: row.timeline, business_owner: row.business_owner,
    capital: row.capital, name: row.name, email: row.email, phone: row.phone, pipeline_stage: row.pipeline_stage,
    ...(event === "setter_self_booked" ? { appointment_start: row.appointment_start } : {}),
    ...(event === "closer_booked" ? { closer_start: row.closer_start } : {}),
  };
  const payload = eventPayload(event, fields, tracking, row.country);
  if (at) payload.timestamp = at;
  return payload;
}

export type SendResult = "sent" | "failed" | "skipped";

/**
 * Posts the milestone for one lead at most once. The claim row is taken first (so a cron pass and a request
 * cannot both post it), the webhook is called, then the row is marked sent. On failure the claim stays: the
 * next pass an hour later tries again, up to MAX_ATTEMPTS. "skipped" = no URL, sent before, or in flight elsewhere.
 */
export async function sendMilestoneOnce(env: CortanaEnv, leadId: number, event: MilestoneEvent, payload: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  if (!webhookMap(env.CORTANA_WEBHOOKS)[event]) return "skipped";
  const claim = await env.DB.prepare(
    `INSERT INTO cortana_sent (lead_id, event) VALUES (?1, ?2)
     ON CONFLICT(lead_id, event) DO UPDATE SET claimed_at = ${SQL_NOW}, attempts = attempts + 1 WHERE ${reclaimable()}`,
  ).bind(leadId, event).run();
  if ((claim.meta.changes ?? 0) === 0) return "skipped";
  const ok = await relayEvent(env, event, payload, fetchImpl);
  if (!ok) return "failed";
  await env.DB.prepare(`UPDATE cortana_sent SET sent_at = ${SQL_NOW} WHERE lead_id = ?1 AND event = ?2`).bind(leadId, event).run();
  console.log("[cortana]", event, "lead", leadId);
  return "sent";
}

export type MilestoneSummary = { at: string; events: number; sent: number; failed: number; skipped: number; note?: string };

/**
 * One cron pass: for each milestone that has a webhook, the leads that reached it and were never posted (or whose
 * claim went stale), oldest first, up to `max` posts in all. Leads that already were at a milestone before this
 * existed are caught up the same way, a batch per pass.
 */
export async function relayMilestones(env: CortanaEnv, max: number = MILESTONE_BATCH, fetchImpl: typeof fetch = fetch, nowMs: number = Date.now()): Promise<MilestoneSummary> {
  const summary: MilestoneSummary = { at: new Date(nowMs).toISOString(), events: 0, sent: 0, failed: 0, skipped: 0 };
  const urls = webhookMap(env.CORTANA_WEBHOOKS);
  const wanted = MILESTONE_EVENTS.filter((e) => urls[e]);
  if (!wanted.length) { summary.note = "no milestone webhooks configured"; return summary; }
  summary.events = wanted.length;
  let budget = max;
  for (const event of wanted) {
    if (budget <= 0) break;
    // Leads at the milestone with no claim row, or one that is open again (failed or died a while ago, tries left).
    const { results } = await env.DB.prepare(
      `SELECT ${MILESTONE_COLUMNS} FROM leads
       WHERE ${milestoneWhere(event)}
         AND NOT EXISTS (SELECT 1 FROM cortana_sent s WHERE s.lead_id = leads.id AND s.event = ?1 AND NOT (${reclaimable((n) => `s.${n}`)}))
       ORDER BY id LIMIT ?2`,
    ).bind(event, budget).all<MilestoneRow>();
    for (const row of results) {
      budget--;
      summary[await sendMilestoneOnce(env, row.id, event, milestonePayload(event, row), fetchImpl)]++;
    }
  }
  console.log("[cortana]", JSON.stringify(summary));
  return summary;
}
