/**
 * What of a D1 row the CSP receives (csp-push.ts). An explicit allowlist per table: a column a later migration adds is
 * never sent until someone classifies it here (test/csp-push.test.ts fails until every column is either sent or held
 * back). The sent set is the contract's (every column of `leads` at migration 0013 and of `email_captures` at 0004),
 * minus `credit_identity`, plus the ordering key `csp_changed_at`. `video_watches` (0015) is held back since video
 * tracking moved into the CSP (2026-11-24: the pages post there; the CSP keeps its own table).
 */
export type Kind = "lead" | "email_capture";

/** The pending predicate, repeated verbatim from the partial indexes in migration 0014 so every scan uses them. */
export const PENDING = "(csp_synced_updated_at IS NULL OR csp_synced_updated_at < csp_changed_at)";

const LEAD_COLUMNS = [
  "id", "created_at", "updated_at", "status", "route", "qualified", "phone", "superseded_phone", "name", "email", "city",
  "timeline", "business_owner", "capital", "tracking", "ip", "country", "user_agent", "ghl_status", "ghl_error",
  "appointment_id", "appointment_start", "appointment_end", "appointment_tz", "ghl_contact_id", "qualified_sent_at",
  "slack_sent_at", "credit_consent", "credit_consent_at", "credit_consent_ip", "credit_status", "credit_checked_at",
  "credit_error", "credit_prequal_id", "credit_score", "credit_offer_status", "credit_offer_amount_1",
  "credit_offer_amount_2", "credit_dti", "credit_income", "credit_household_income", "credit_freeze", "dq_reason",
  "opportunity_id", "pipeline_stage", "pipeline_stage_at", "opportunity_status", "opportunity_value", "setter_calls",
  "setter_call_seconds", "setter_calls_synced_at", "closer_appointment_id", "closer_start", "closer_status",
  "closer_meet_code", "closer_attended", "closer_attended_source", "closer_minutes", "closer_checked_at", "closer_host",
  "appointment_status", "setter_host", "setter_attended_manual", "closer_attended_manual", "won_manual", "cash_manual",
  "close_date_manual", "outcome_manual_at", "phone_line_type", "phone_carrier", "phone_lookup_at", "booked_at",
  "ghl_abandoned_at", "ghl_abandoned_attempts", "csp_changed_at",
] as const;

const CAPTURE_COLUMNS = [
  "id", "created_at", "updated_at", "email", "name", "city", "timeline", "business_owner", "capital", "tracking", "ip",
  "country", "ghl_contact_id", "ghl_status", "ghl_error", "csp_changed_at",
] as const;

/** Sent columns per kind. */
export const SENT_COLUMNS: Record<Kind, readonly string[]> = { lead: LEAD_COLUMNS, email_capture: CAPTURE_COLUMNS };

/**
 * Held back on purpose. `credit_identity` is an unsalted SHA-256 of name + email + phone, the funnel's own
 * credit-reuse key, with no use on the CSP. The rest is the outbox's own bookkeeping.
 */
export const HELD_BACK_COLUMNS: Record<Kind, readonly string[]> = {
  // video_watches (0015): the old D1 aggregate; video tracking lives in the CSP now (its own lead_video_watches table).
  lead: ["credit_identity", "csp_synced_updated_at", "csp_sync_attempts", "csp_sync_error", "csp_next_attempt_at", "video_watches"],
  email_capture: ["csp_synced_updated_at", "csp_sync_attempts", "csp_sync_error", "csp_next_attempt_at"],
};

/**
 * INTEGER columns. SQLite's INTEGER affinity keeps a non-integral number as REAL (credit_income can come back from
 * SimpleCheck as 52000.5), while the CSP stores these as integers and would refuse the whole record; they are rounded.
 */
export const INTEGER_COLUMNS: Record<Kind, readonly string[]> = {
  lead: [
    "id", "qualified", "credit_prequal_id", "credit_score", "credit_income", "credit_household_income", "setter_calls",
    "setter_call_seconds", "closer_minutes", "won_manual", "ghl_abandoned_attempts",
  ],
  email_capture: ["id"],
};

/** TEXT columns holding a JSON object, sent parsed (an object, or null when empty or not an object). */
export const JSON_COLUMNS: Record<Kind, readonly string[]> = { lead: ["tracking"], email_capture: ["tracking"] };

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === "object") return Array.isArray(raw) ? null : (raw as Record<string, unknown>);
  try {
    const v: unknown = JSON.parse(String(raw));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The row as the CSP receives it: allowlisted columns only (missing = null), JSON columns parsed, integers rounded. */
export function cspRow(kind: Kind, raw: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const c of SENT_COLUMNS[kind]) row[c] = raw[c] ?? null;
  for (const c of JSON_COLUMNS[kind]) row[c] = parseJsonObject(row[c]);
  for (const c of INTEGER_COLUMNS[kind]) {
    const v = row[c];
    if (typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v)) row[c] = Math.round(v);
  }
  return row;
}
