/**
 * roof-funnel API — Cloudflare Worker.
 *
 *   POST /lead          full survey submission → D1 row → GHL inbound webhook (background)
 *   POST /lead/partial  abandonment save (phone + whatever exists) → D1 upsert → GHL (background)
 *   Completed, qualified applications submitted under the soft credit check disclosure also get one
 *   SimpleCheck pre-qualification (background): result → D1 credit_* columns → GHL fields → Slack.
 *   GET  /leads         admin export (Authorization: Bearer ADMIN_TOKEN) ?since=ISO&limit=N
 *   /admin/*            report, leads, disqualification rules, outcome sync (admin.ts; same bearer token)
 *   cron (every 30 min) outcome sync from GHL / Fathom / Google Meet (outcomes.ts)
 *
 * Routing: a completed application goes to the calendar unless one of its answers is switched to
 * "disqualify" in the rules, or a credit rule is on and the soft credit check result breaks it.
 *   GET  /health
 *
 * Gates, in order: CORS origin → rate limit (8/min binding, 40/h in D1) → honeypot → IP country
 * → validation (reject / ghost / process). Ghosted and blocked traffic gets a 200 `silent`
 * success so bots and out-of-market visitors learn nothing; nothing of theirs is stored.
 */
import {
  classifyFullSubmission,
  classifyPartialSubmission,
  isFakeLeadIdentity,
  isObviousFakeEmail,
  isObviousFakeText,
  isValidEmail,
  normalizePhoneDigits10,
  type FakeLeadConfig,
  type LeadInput,
} from "./validation.ts";
import { maskEmail, maskName, maskPhone } from "./log-mask.ts";
import { creditAlertMessage, creditProblemMessage, leadAlertMessage, leadWithdrawnMessage, postSlack } from "./slack.ts";
import { identityKey, offerAmounts, runPreQualification, type CreditReport, type CreditResult } from "./simplecheck.ts";
import { answerDqReason, answersQualify, creditDqReason, creditRulesApply, publicDqKind, type Answers, type Rules } from "./rules.ts";
import { handleAdmin, loadRules } from "./admin.ts";
import { runOutcomeSync } from "./outcomes.ts";
import { createAppointment, freeSlots, slotDurationMinutes, updateContactCredit, upsertSurveyContact, type ContactsConfig, type GhlConfig } from "./ghl.ts";

type RateLimitBinding = { limit(opts: { key: string }): Promise<{ success: boolean }> };

export interface Env {
  DB: D1Database;
  RL_MINUTE?: RateLimitBinding;
  RL_EVENTS?: RateLimitBinding;
  /** JSON map of event name → webhook URL (Cortana). */
  CORTANA_WEBHOOKS?: string;
  ALLOWED_ORIGINS: string;
  ALLOWED_COUNTRIES: string;
  GHL_WEBHOOK_URL?: string;
  ADMIN_TOKEN?: string;
  FAKE_LEAD_TEST_PHONE_PREFIXES?: string;
  FAKE_LEAD_INTERNAL_EMAIL_DOMAINS?: string;
  /** Native booking step (optional until set): PIT secret + sub-account + calendar. */
  GHL_PIT?: string;
  GHL_LOCATION_ID?: string;
  GHL_CALENDAR_ID?: string;
  /** Shown as the appointment title and on the thank-you page. */
  APPOINTMENT_TITLE?: string;
  /** "off" disables the pre-booking contact sync (email capture + lead save → GHL contact). */
  GHL_CONTACT_SYNC?: string;
  /** Slack incoming webhook for #lead-alerts (secret). Unset = no alerts. */
  SLACK_LEAD_ALERTS_WEBHOOK?: string;
  /** SimpleCheck Qualify API token (secret). Unset = no soft credit checks. */
  SIMPLECHECK_API_TOKEN?: string;
  /** "off" pauses soft credit checks without removing the token. */
  SIMPLECHECK_MODE?: string;
  /** Most soft credit checks allowed in any 24 hours (default 40). A guard against a flood of fake applications. */
  SIMPLECHECK_DAILY_CAP?: string;
  /** Local runs only: point the check at a stub on localhost. Any other host is ignored. */
  SIMPLECHECK_API_URL?: string;
  /** Closer-call attendance for the roof business (all optional; see outcomes.ts). */
  FATHOM_API_KEY?: string;
  GOOGLE_MEET_SERVICE_ACCOUNT?: string;
}

const HONEYPOT_FIELD = "contact_fax";
const HOURLY_LIMIT = 40;
const MAX_BODY_BYTES = 16_384;
const GHL_TIMEOUT_MS = 8_000;
/**
 * The disclosure the survey shows under its submit button ("By submitting, you agree to our Privacy
 * Policy, including a soft credit check…"). The survey sends this value with a full submission; a
 * submission without it (an older cached survey, a partial save) is never credit checked.
 */
const CREDIT_CONSENT_VERSION = "soft-pull-v1";
/**
 * With a credit rule switched on, the submit waits this long for the check before routing.
 * If the check is not back by then the lead is let through to the calendar (it still finishes in the background).
 */
const CREDIT_ROUTING_WAIT_MS = 10_000;

type Tracking = Record<string, string | number | undefined>;

type Body = LeadInput & {
  survey_partial?: boolean;
  superseded_phone?: string;
  credit_consent?: unknown;
  tracking?: Tracking | null;
  [HONEYPOT_FIELD]?: unknown;
};

/* ---------------- helpers ---------------- */

function csv(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = csv(env.ALLOWED_ORIGINS);
  const ok = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] ?? "",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  // Non-browser clients (no Origin) are allowed through; the gates below still apply.
  if (!origin) return true;
  return csv(env.ALLOWED_ORIGINS).includes(origin);
}

function json(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function clientCountry(request: Request): string | null {
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const raw = (cf?.country ?? request.headers.get("cf-ipcountry") ?? "").trim().toUpperCase();
  return raw.length === 2 ? raw : null;
}

function countryAllowed(country: string | null, env: Env): boolean {
  if (!country) return true; // unknown → process, same as the original funnel
  return csv(env.ALLOWED_COUNTRIES).map((c) => c.toUpperCase()).includes(country);
}

function fakeLeadConfig(env: Env): FakeLeadConfig {
  return {
    testPhonePrefixes: env.FAKE_LEAD_TEST_PHONE_PREFIXES,
    internalEmailDomains: env.FAKE_LEAD_INTERNAL_EMAIL_DOMAINS,
  };
}

function str(v: unknown, max = 200): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function pickTracking(raw: unknown): Tracking | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Tracking = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9_]{1,40}$/.test(k)) continue;
    if (typeof v === "string" && v.length <= 2048) out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/* ---------------- rate limiting ---------------- */

async function rateLimited(env: Env, ip: string): Promise<boolean> {
  if (env.RL_MINUTE) {
    try {
      const { success } = await env.RL_MINUTE.limit({ key: `ip:${ip}` });
      if (!success) return true;
    } catch (err) {
      console.warn("[rl] binding failed (failing open):", String(err));
    }
  }
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM leads WHERE ip = ?1 AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')",
    )
      .bind(ip)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= HOURLY_LIMIT) return true;
  } catch (err) {
    console.warn("[rl] hourly count failed (failing open):", String(err));
  }
  return false;
}

/* ---------------- GHL ---------------- */

type LeadRow = {
  id: number;
  status: "partial" | "full";
  route: "calendar" | "dq" | null;
  qualified: boolean | null;
  /** 'answer:<question>' or 'credit:<rule>' on a disqualified full submit (written separately, see storeRoute). */
  dq_reason?: string | null;
  phone: string;
  superseded_phone?: string;
  name?: string;
  email?: string;
  city?: string;
  timeline?: string;
  business_owner?: string;
  capital?: string;
  tracking?: Tracking;
};

function ghlPayload(row: LeadRow): Record<string, unknown> {
  const parts = (row.name ?? "").trim().split(/\s+/).filter(Boolean);
  const first_name = parts[0];
  const last_name = parts.length > 1 ? parts.slice(1).join(" ") : undefined;
  const t = row.tracking ?? {};
  const referrer = typeof t.referrer === "string" ? t.referrer : "";
  const source =
    (typeof t.utm_source === "string" && t.utm_source) ||
    (referrer.includes("facebook") ? "facebook" : referrer.includes("google") ? "google" : undefined);
  const flat: Record<string, unknown> = {
    lead_id: row.id,
    name: row.name,
    first_name,
    last_name,
    phone: row.phone,
    email: row.email,
    city: row.city,
    timeline: row.timeline,
    business_owner: row.business_owner,
    capital: row.capital,
    ...(row.status === "partial" ? { survey_partial: true } : { qualified: row.qualified, route: row.route }),
    ...(row.superseded_phone ? { superseded_phone: row.superseded_phone } : {}),
    source,
    ...t,
  };
  const customFields = Object.entries(flat)
    .filter(([, v]) => v != null && v !== "" && typeof v !== "object")
    .map(([key, value]) => ({ key, value: String(value) }));
  return { ...flat, customFields };
}

async function pushToGhl(env: Env, row: LeadRow): Promise<void> {
  if (!env.GHL_WEBHOOK_URL) {
    await env.DB.prepare("UPDATE leads SET ghl_status = 'skipped' WHERE id = ?1").bind(row.id).run();
    return;
  }
  let status = "sent";
  let error: string | null = null;
  try {
    const res = await fetch(env.GHL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ghlPayload(row)),
      signal: AbortSignal.timeout(GHL_TIMEOUT_MS),
    });
    if (!res.ok) {
      status = "failed";
      error = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
    }
  } catch (err) {
    status = "failed";
    error = String(err).slice(0, 300);
  }
  if (status === "failed") console.error("[ghl] push failed for lead", row.id, error);
  await env.DB.prepare("UPDATE leads SET ghl_status = ?1, ghl_error = ?2 WHERE id = ?3").bind(status, error, row.id).run();
}

/* ---------------- storage ---------------- */

type Meta = { ip: string; country: string | null; ua: string | null };

async function findReusableRow(env: Env, phones: string[]): Promise<{ id: number; status: string } | null> {
  for (const p of phones) {
    const row = await env.DB.prepare("SELECT id, status FROM leads WHERE phone = ?1 ORDER BY id DESC LIMIT 1")
      .bind(p)
      .first<{ id: number; status: string }>();
    if (row) return row;
  }
  return null;
}

async function upsertLead(env: Env, lead: Omit<LeadRow, "id">, meta: Meta): Promise<LeadRow> {
  const candidates = [lead.phone, ...(lead.superseded_phone ? [lead.superseded_phone] : [])];
  const existing = await findReusableRow(env, candidates);
  const tracking = lead.tracking ? JSON.stringify(lead.tracking) : null;
  // A partial never overwrites a completed survey; a full submit always upgrades the partial.
  if (existing && !(lead.status === "partial" && existing.status === "full")) {
    await env.DB.prepare(
      `UPDATE leads SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), status = ?1, route = ?2, qualified = ?3,
         phone = ?4, superseded_phone = COALESCE(?5, superseded_phone), name = COALESCE(?6, name), email = COALESCE(?7, email),
         city = COALESCE(?8, city), timeline = COALESCE(?9, timeline), business_owner = COALESCE(?10, business_owner),
         capital = COALESCE(?11, capital), tracking = COALESCE(?12, tracking), ghl_status = NULL, ghl_error = NULL
       WHERE id = ?13`,
    )
      .bind(
        lead.status, lead.route, lead.qualified == null ? null : lead.qualified ? 1 : 0, lead.phone,
        lead.superseded_phone ?? null, lead.name ?? null, lead.email ?? null, lead.city ?? null, lead.timeline ?? null,
        lead.business_owner ?? null, lead.capital ?? null, tracking, existing.id,
      )
      .run();
    return { ...lead, id: existing.id };
  }
  const res = await env.DB.prepare(
    `INSERT INTO leads (status, route, qualified, phone, superseded_phone, name, email, city, timeline, business_owner, capital,
       tracking, ip, country, user_agent)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
  )
    .bind(
      lead.status, lead.route, lead.qualified == null ? null : lead.qualified ? 1 : 0, lead.phone,
      lead.superseded_phone ?? null, lead.name ?? null, lead.email ?? null, lead.city ?? null, lead.timeline ?? null,
      lead.business_owner ?? null, lead.capital ?? null, tracking, meta.ip, meta.country, meta.ua,
    )
    .run();
  return { ...lead, id: Number(res.meta.last_row_id) };
}

/* ---------------- handlers ---------------- */

async function readBody(request: Request): Promise<Body | null> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Body) : null;
  } catch {
    return null;
  }
}

function leadInput(body: Body): LeadInput {
  return {
    timeline: str(body.timeline),
    business_owner: str(body.business_owner),
    capital: str(body.capital),
    city: str(body.city, 120),
    name: str(body.name, 120),
    phone: str(body.phone, 40),
    email: str(body.email, 254),
  };
}

async function handleLead(request: Request, env: Env, ctx: ExecutionContext, partial: boolean): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (!originAllowed(request, env)) return json({ ok: false, error: "Forbidden" }, 403, cors);
  const body = await readBody(request);
  if (!body) return json({ ok: false, error: "Bad request" }, 400, cors);

  const ip = clientIp(request);
  const country = clientCountry(request);
  const meta: Meta = { ip, country, ua: request.headers.get("User-Agent")?.slice(0, 300) ?? null };
  const tag = partial ? "partial" : "full";

  if (await rateLimited(env, ip)) {
    console.log(`[${tag}] rate limited`, ip);
    return json({ ok: false, error: "Too many submissions. Please wait a moment and try again." }, 429, {
      ...cors,
      "Retry-After": "60",
    });
  }
  const hp = body[HONEYPOT_FIELD];
  if (hp != null && (typeof hp !== "string" || hp.trim() !== "")) {
    console.log(`[${tag}] honeypot — silent`, ip);
    return json({ ok: true, silent: true }, 200, cors);
  }
  if (!countryAllowed(country, env)) {
    console.log(`[${tag}] geo blocked — silent`, ip, country);
    return json({ ok: true, silent: true }, 200, cors);
  }

  const input = leadInput(body);
  const gate = partial
    ? classifyPartialSubmission(input, fakeLeadConfig(env))
    : classifyFullSubmission(input, fakeLeadConfig(env));
  if (gate.outcome === "reject") {
    console.log(`[${tag}] rejected:`, gate.error);
    return json({ ok: false, error: gate.error }, 400, cors);
  }
  if (gate.outcome === "ghost") {
    console.log(`[${tag}] ghosted (${gate.reason}) — silent`, maskName(input.name), maskPhone(input.phone), maskEmail(input.email));
    return json({ ok: true, silent: true }, 200, cors);
  }

  const digits = normalizePhoneDigits10(input.phone)!;
  const phone = `+1${digits}`;
  const supersededDigits = normalizePhoneDigits10(str(body.superseded_phone, 40));
  const superseded_phone = supersededDigits && `+1${supersededDigits}` !== phone ? `+1${supersededDigits}` : undefined;
  const email = isValidEmail(input.email) ? input.email.trim() : undefined;
  const tracking = pickTracking(body.tracking);

  const rules = await loadRules(env.DB);
  const answers = { timeline: input.timeline, business_owner: input.business_owner, capital: input.capital };
  // The answer rules decide first; a credit rule can still turn a calendar route into "dq" further down.
  const answerDq: string | null = partial ? null : answerDqReason(rules, answers);
  const row = await upsertLead(
    env,
    {
      status: partial ? "partial" : "full",
      route: partial ? null : answerDq === null ? "calendar" : "dq",
      qualified: partial ? null : answerDq === null,
      dq_reason: answerDq,
      phone,
      superseded_phone,
      name: input.name,
      email,
      city: input.city,
      timeline: input.timeline,
      business_owner: input.business_owner,
      capital: input.capital,
      tracking,
    },
    meta,
  );
  console.log(`[${tag}] stored lead`, row.id, maskName(row.name), maskPhone(row.phone), "route:", row.route, "country:", country);

  // The lead is stored. Everything else is registered up front, so it finishes even if the visitor closes the
  // tab while a credit rule is still waiting on the check.
  const origin = request.headers.get("Origin");
  // Sent by the full submit and by the phone step's save (the survey asks the timeline question last so the check
  // runs meanwhile); an abandonment save never carries it.
  const consent = str(body.credit_consent, 40) === CREDIT_CONSENT_VERSION && !!origin && csv(env.ALLOWED_ORIGINS).includes(origin);
  const settle = settleLead(env, ctx, { row, meta, partial, rules, answers, answerDq, consent, tracking, country, tag });
  ctx.waitUntil(settle.catch(() => {}));
  let dqReason = answerDq;
  try {
    dqReason = await settle;
  } catch (err) {
    console.error(`[${tag}] lead`, row.id, "follow-up failed:", String(err).slice(0, 200));
  }

  if (partial) return json({ ok: true, partial_saved: true }, 200, cors);
  const qualified = dqReason === null;
  return json({ ok: true, lead_id: row.id, route: qualified ? "calendar" : "dq", qualified, ...(qualified ? {} : { dq: publicDqKind(dqReason) }) }, 200, cors);
}

type SettleInput = {
  row: LeadRow; meta: Meta; partial: boolean; rules: Rules; answers: Answers; answerDq: string | null; consent: boolean;
  tracking: Tracking | undefined; country: string | null; tag: string;
};

/** Route, reason and qualified flag of a completed application. Best effort: the lead row itself is already stored. */
async function storeRoute(env: Env, rowId: number, dqReason: string | null): Promise<boolean> {
  try {
    await env.DB.prepare("UPDATE leads SET route = ?1, qualified = ?2, dq_reason = ?3 WHERE id = ?4")
      .bind(dqReason === null ? "calendar" : "dq", dqReason === null ? 1 : 0, dqReason, rowId).run();
    return true;
  } catch (err) {
    console.error("[lead]", rowId, "route not stored:", String(err).slice(0, 160));
    return false;
  }
}

/** True when the newest completed application from this phone was turned away by a credit rule. */
async function creditDisqualifiedBefore(env: Env, phone: string): Promise<boolean> {
  try {
    const r = await env.DB.prepare("SELECT dq_reason FROM leads WHERE phone = ?1 AND status = 'full' ORDER BY id DESC LIMIT 1").bind(phone).first<{ dq_reason: string | null }>();
    return (r?.dq_reason ?? "").startsWith("credit:");
  } catch {
    return false;
  }
}

/**
 * Everything after the lead row exists: the credit check, the final route, and the side effects that only a
 * qualified lead triggers (Slack alert, GHL contact, "qualified" event, credit follow-up).
 * Resolves to the final disqualification reason (null = qualified).
 */
async function settleLead(env: Env, ctx: ExecutionContext, s: SettleInput): Promise<string | null> {
  const { row, meta, partial, rules, answers, tracking, country, tag } = s;
  const timezone = typeof tracking?.timezone === "string" ? tracking.timezone : undefined;
  let dqReason = s.answerDq;
  let credit: Promise<CreditOutcome> | null = null;
  let turnedAwayBefore = false;

  if (partial) {
    // An abandoned retry by someone the credit rules already turned away is not a qualified lead again.
    if (answersQualify(rules, answers)) turnedAwayBefore = await creditDisqualifiedBefore(env, row.phone);
    // Start the soft credit check as soon as a qualified lead has a phone: the phone step's save (so the full submit a
    // few seconds later finds the result and routes without waiting) and abandonment saves alike. Michael's ruling
    // (2026-11-10): the disclosure under the phone field is the consent, whether or not Continue was pressed.
    if (answersQualify(rules, answers) && !turnedAwayBefore && creditCheckEnabled(env)) {
      credit = creditFlow(env, row, meta, { consent: true, qualified: true });
    }
  } else {
    // Soft credit check. It never fails the submit; the consent flag was only accepted from our own pages.
    credit = creditFlow(env, row, meta, { consent: s.consent, qualified: dqReason === null });
    if (dqReason === null && creditRulesApply(rules, answers)) {
      // A credit rule is switched on, so routing waits for the result. No result in time = the lead goes through
      // (and is judged again when it tries to book, see handleBook).
      let result: CreditResult | null = null;
      if (s.consent && creditCheckEnabled(env)) {
        const outcome = await Promise.race([
          credit,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), CREDIT_ROUTING_WAIT_MS)),
        ]);
        result = outcome?.result ?? null;
      }
      // A resubmit (with or without the consent flag) is judged on the result already stored for this person.
      if (!result) result = await storedCreditFor(env, row).catch(() => null);
      const broken = result?.status === "success" ? creditDqReason(rules, result) : null;
      if (broken) {
        dqReason = broken;
        console.log(`[${tag}] lead`, row.id, "disqualified by a credit rule");
      }
    }
    // If this cannot be written the lead keeps the calendar rather than being turned away off the books.
    if (!(await storeRoute(env, row.id, dqReason)) && dqReason !== s.answerDq) dqReason = s.answerDq;
    row.route = dqReason === null ? "calendar" : "dq";
    row.qualified = dqReason === null;
    row.dq_reason = dqReason;
  }

  ctx.waitUntil(pushToGhl(env, row));
  // Qualified = sent to the calendar (completed) / nothing disqualifying among the answers so far (partial).
  const isQualified = partial ? answersQualify(rules, answers) && !turnedAwayBefore : dqReason === null;
  const contactSynced = syncLeadContact(env, row, timezone, isQualified);
  ctx.waitUntil(contactSynced);
  const leadFields = {
    lead_id: row.id, session_id: tracking?.session_id, city: row.city, timeline: row.timeline, business_owner: row.business_owner,
    capital: row.capital, name: row.name, email: row.email, phone: row.phone, survey_partial: partial,
  };
  ctx.waitUntil(relayEvent(env, "phone", eventPayload("phone", { ...leadFields, qualified: isQualified }, tracking, country)));
  // One alert and one "qualified" event per qualified lead, preferably now that the phone is here.
  const alerted = isQualified ? slackAlertOnce(env, row, partial, tracking).catch(() => {}) : Promise.resolve();
  ctx.waitUntil(alerted);
  if (isQualified && (row.email || row.phone)) ctx.waitUntil(sendQualifiedOnce(env, row.id, eventPayload("qualified", { ...leadFields, qualified: true }, tracking, country)));
  // The team sees a credit result only for leads that stay qualified, after the lead alert.
  if (credit && isQualified) ctx.waitUntil(publishCredit(env, row, credit, contactSynced, alerted));
  // Turned away by a credit rule after the team was already told about this lead (the survey saves a partial
  // before the final submit): take it back.
  if (!partial && (dqReason ?? "").startsWith("credit:")) ctx.waitUntil(retractQualified(env, row, timezone));
  if (credit) ctx.waitUntil(credit);
  return dqReason;
}

/** The team was alerted / GHL holds a "qualified" contact from the partial save: correct both. Never rejects. */
async function retractQualified(env: Env, row: LeadRow, timezone: string | undefined): Promise<void> {
  try {
    const seen = await env.DB.prepare("SELECT slack_sent_at, ghl_contact_id FROM leads WHERE id = ?1").bind(row.id).first<{ slack_sent_at: string | null; ghl_contact_id: string | null }>();
    const cfg = contactsConfig(env);
    if (seen?.ghl_contact_id && cfg) {
      await upsertSurveyContact(cfg, {
        name: row.name, email: row.email, phone: row.phone, city: row.city, timezone,
        timeline: row.timeline, business_owner: row.business_owner, capital: row.capital, qualified: false,
      }).catch((err) => console.error("[credit] GHL correction failed for lead", row.id, String(err).slice(0, 80)));
    }
    if (seen?.slack_sent_at && env.SLACK_LEAD_ALERTS_WEBHOOK) {
      await postSlack(env.SLACK_LEAD_ALERTS_WEBHOOK, leadWithdrawnMessage({ id: row.id, name: row.name }))
        .catch((err) => console.error("[credit] slack correction failed for lead", row.id, String(err).slice(0, 80)));
    }
  } catch (err) {
    console.error("[credit] correction failed for lead", row.id, String(err).slice(0, 120));
  }
}

async function handleExport(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.ADMIN_TOKEN || !token || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return json({ ok: false, error: "Unauthorized" }, 401, {});
  }
  const url = new URL(request.url);
  const since = url.searchParams.get("since") ?? "1970-01-01";
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? "200") || 200));
  const { results } = await env.DB.prepare(
    "SELECT * FROM leads WHERE created_at >= ?1 ORDER BY id DESC LIMIT ?2",
  )
    .bind(since, limit)
    .all();
  return json({ ok: true, count: results.length, leads: results }, 200, {});
}

/* ---------------- GHL contact sync (email first, phone when it arrives) ---------------- */

/** GHL_CONTACT_SYNC: "off" = never, "qualified" = qualified leads with a phone (default), "all" = every capture. */
function syncMode(env: Env): "off" | "qualified" | "all" {
  const m = (env.GHL_CONTACT_SYNC ?? "qualified").toLowerCase();
  return m === "off" || m === "all" ? m : "qualified";
}

function contactsConfig(env: Env): ContactsConfig | null {
  if (syncMode(env) === "off") return null;
  if (!env.GHL_PIT || !env.GHL_LOCATION_ID) return null;
  return { token: env.GHL_PIT, locationId: env.GHL_LOCATION_ID };
}

/** Lead row → GHL contact; records the outcome on the row. Resolves to the contact id, or null. Never rejects. */
async function syncLeadContact(env: Env, row: LeadRow, timezone: string | undefined, qualified: boolean): Promise<string | null> {
  const cfg = contactsConfig(env);
  if (!cfg) return null;
  if (syncMode(env) === "qualified" && !qualified) return null; // only qualified leads go to GHL
  try {
    const id = await upsertSurveyContact(cfg, {
      name: row.name, email: row.email, phone: row.phone, city: row.city, timezone,
      timeline: row.timeline, business_owner: row.business_owner, capital: row.capital,
      qualified: row.capital ? qualified : null,
    });
    await env.DB.prepare("UPDATE leads SET ghl_contact_id = ?1 WHERE id = ?2").bind(id, row.id).run();
    console.log("[contact] lead", row.id, "→ GHL contact", id);
    return id;
  } catch (err) {
    console.error("[contact] lead", row.id, "GHL upsert failed:", String(err).slice(0, 300));
    return null;
  }
}

type EmailCaptureBody = LeadInput & { tracking?: Tracking | null; [HONEYPOT_FIELD]?: unknown };

/** POST /contact — a valid email (plus answers so far), before any phone exists. */
async function handleEmailCapture(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (!originAllowed(request, env)) return json({ ok: false, error: "Forbidden" }, 403, cors);
  const body = (await readBody(request)) as EmailCaptureBody | null;
  if (!body) return json({ ok: false, error: "Bad request" }, 400, cors);
  const ip = clientIp(request);
  if (env.RL_EVENTS) {
    try { const { success } = await env.RL_EVENTS.limit({ key: `ip:${ip}` }); if (!success) return json({ ok: false, error: "Too many requests" }, 429, cors); }
    catch (err) { console.warn("[contact] rl failed (open):", String(err)); }
  }
  const hp = body[HONEYPOT_FIELD];
  if (hp != null && (typeof hp !== "string" || hp.trim() !== "")) return json({ ok: true, silent: true }, 200, cors);
  const country = clientCountry(request);
  if (!countryAllowed(country, env)) return json({ ok: true, silent: true }, 200, cors);
  const input = leadInput(body);
  if (!isValidEmail(input.email)) return json({ ok: false, error: "Please enter a valid email address." }, 400, cors);
  const email = input.email.trim();
  const name = input.name ?? "";
  if (isObviousFakeEmail(email) || (name && isObviousFakeText(name)) || isFakeLeadIdentity({ name, email }, fakeLeadConfig(env))) {
    console.log("[contact] ghosted", maskName(name), maskEmail(email));
    return json({ ok: true, silent: true }, 200, cors);
  }
  const tracking = pickTracking(body.tracking);
  await env.DB.prepare(
    `INSERT INTO email_captures (email, name, city, timeline, business_owner, capital, tracking, ip, country)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(email) DO UPDATE SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       name = COALESCE(excluded.name, name), city = COALESCE(excluded.city, city), timeline = COALESCE(excluded.timeline, timeline),
       business_owner = COALESCE(excluded.business_owner, business_owner), capital = COALESCE(excluded.capital, capital),
       tracking = COALESCE(excluded.tracking, tracking)`,
  ).bind(email, input.name ?? null, input.city ?? null, input.timeline ?? null, input.business_owner ?? null, input.capital ?? null,
         tracking ? JSON.stringify(tracking) : null, ip, country).run();
  console.log("[contact] email capture", maskName(name), maskEmail(email), "country:", country);
  const cfg = syncMode(env) === "all" ? contactsConfig(env) : null; // email-only captures reach GHL only in "all" mode
  if (cfg) ctx.waitUntil((async () => {
    try {
      const id = await upsertSurveyContact(cfg, {
        name: input.name, email, city: input.city, timezone: typeof tracking?.timezone === "string" ? tracking.timezone : undefined,
        timeline: input.timeline, business_owner: input.business_owner, capital: input.capital,
        qualified: input.capital ? answersQualify(await loadRules(env.DB), { timeline: input.timeline, business_owner: input.business_owner, capital: input.capital }) : null,
      });
      await env.DB.prepare("UPDATE email_captures SET ghl_contact_id = ?1, ghl_status = 'sent', ghl_error = NULL WHERE email = ?2").bind(id, email).run();
      console.log("[contact] email-only → GHL contact", id);
    } catch (err) {
      await env.DB.prepare("UPDATE email_captures SET ghl_status = 'failed', ghl_error = ?1 WHERE email = ?2").bind(String(err).slice(0, 300), email).run();
      console.error("[contact] email-only GHL upsert failed:", String(err).slice(0, 300));
    }
  })());
  return json({ ok: true }, 202, cors);
}

/* ---------------- step webhooks (Cortana) ---------------- */

const EVENT_FIELDS = ["session_id", "city", "timeline", "business_owner", "capital", "name", "email", "phone", "question_key", "question", "answer"] as const;
const EVENT_NAMES = new Set(["q1", "q2", "q3", "q4", "q5", "email", "phone", "qualified"]);

function webhookMap(env: Env): Record<string, string> {
  try {
    const m = JSON.parse(env.CORTANA_WEBHOOKS ?? "{}") as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) if (typeof v === "string" && /^https:\/\//.test(v)) out[k] = v;
    return out;
  } catch { return {}; }
}

/** The lead at the top level of the body (Cortana reads it there), plus flattened tracking. */
function eventPayload(event: string, fields: Record<string, unknown>, tracking: Tracking | undefined, country: string | null) {
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

async function relayEvent(env: Env, event: string, payload: Record<string, unknown>): Promise<void> {
  const url = webhookMap(env)[event];
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) console.error("[event]", event, "webhook", res.status, (await res.text().catch(() => "")).slice(0, 200));
  } catch (err) {
    console.error("[event]", event, "webhook failed:", String(err).slice(0, 200));
  }
}

/* ---------------- soft credit check (SimpleCheck) ---------------- */

const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const CREDIT_RESULT_COLUMNS = [
  "credit_prequal_id", "credit_score", "credit_offer_status", "credit_offer_amount_1", "credit_offer_amount_2",
  "credit_dti", "credit_income", "credit_household_income", "credit_freeze",
] as const;

function creditCheckEnabled(env: Env): boolean {
  return !!env.SIMPLECHECK_API_TOKEN && (env.SIMPLECHECK_MODE ?? "on").toLowerCase() !== "off";
}

function creditDailyCap(env: Env): number {
  const n = Number(env.SIMPLECHECK_DAILY_CAP ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 40;
}

/** The stub override is honoured for localhost only, so the token can never be sent to another host. */
function creditEndpoint(env: Env): string | undefined {
  if (!env.SIMPLECHECK_API_URL) return undefined;
  try {
    const u = new URL(env.SIMPLECHECK_API_URL);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

type CreditOpts = { consent: boolean; qualified: boolean };
/** `fresh` = this request ran (or copied) the check; false = an earlier result that is already on the row. */
type CreditOutcome = { result: CreditResult | null; fresh: boolean };
const NO_CREDIT: CreditOutcome = { result: null, fresh: false };

/** Runs after every completed application. Never rejects: capture, routing and booking do not depend on it. */
async function creditFlow(env: Env, row: LeadRow, meta: Meta, opts: CreditOpts): Promise<CreditOutcome> {
  try {
    const identity = await identityKey(row.name, row.email, row.phone);
    // Rows are found by phone. If this row now carries someone else (or corrected details), the earlier
    // consent and result do not carry over to them.
    await env.DB.prepare(
      `UPDATE leads SET credit_consent = NULL, credit_consent_at = NULL, credit_consent_ip = NULL, credit_identity = NULL,
         credit_status = NULL, credit_checked_at = NULL, credit_error = NULL,
         ${CREDIT_RESULT_COLUMNS.map((c) => `${c} = NULL`).join(", ")}
       WHERE id = ?1 AND credit_identity IS NOT NULL AND credit_identity <> ?2`,
    ).bind(row.id, identity).run();
    if (!opts.consent) return NO_CREDIT;
    // Consent evidence is written only while no check is recorded, so it always describes the check that used it.
    await env.DB.prepare(
      `UPDATE leads SET credit_consent = ?1, credit_consent_at = ${SQL_NOW}, credit_consent_ip = ?2, credit_identity = ?3
       WHERE id = ?4 AND credit_checked_at IS NULL`,
    ).bind(CREDIT_CONSENT_VERSION, meta.ip, identity, row.id).run();
    if (!opts.qualified || !creditCheckEnabled(env)) return NO_CREDIT;
    return await creditCheckOnce(env, row, meta, identity);
  } catch (err) {
    console.error("[credit] flow failed for lead", row.id, String(err).slice(0, 200));
    return NO_CREDIT;
  }
}

type CreditColumns = {
  credit_prequal_id: number | null; credit_score: number | null; credit_offer_status: string | null;
  credit_offer_amount_1: string | null; credit_offer_amount_2: string | null; credit_dti: number | null;
  credit_income: number | null; credit_household_income: number | null; credit_freeze: string | null;
};

function creditFromColumns(r: CreditColumns): CreditResult {
  return {
    status: "success", prequalId: r.credit_prequal_id, score: r.credit_score, offerStatus: r.credit_offer_status,
    offerAmount1: r.credit_offer_amount_1, offerAmount2: r.credit_offer_amount_2, dti: r.credit_dti,
    income: r.credit_income, householdIncome: r.credit_household_income, creditFreeze: r.credit_freeze,
  };
}

/** The result already stored on this row for this person (a resubmit), so the rules still apply to it. */
async function storedCreditResult(env: Env, rowId: number, identity: string): Promise<CreditResult | null> {
  const r = await env.DB.prepare(
    `SELECT credit_status, ${CREDIT_RESULT_COLUMNS.join(", ")} FROM leads WHERE id = ?1 AND credit_identity = ?2`,
  ).bind(rowId, identity).first<CreditColumns & { credit_status: string | null }>();
  return r && r.credit_status === "success" ? creditFromColumns(r) : null;
}

/** The stored result, waiting up to `maxMs` while a check started by an earlier request is still 'pending'. */
async function settledCreditResult(env: Env, rowId: number, identity: string, maxMs: number): Promise<CreditResult | null> {
  const until = Date.now() + maxMs;
  for (;;) {
    const r = await env.DB.prepare("SELECT credit_status FROM leads WHERE id = ?1 AND credit_identity = ?2").bind(rowId, identity).first<{ credit_status: string | null }>();
    if (r?.credit_status !== "pending" || Date.now() >= until) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return storedCreditResult(env, rowId, identity);
}

async function storedCreditFor(env: Env, row: LeadRow): Promise<CreditResult | null> {
  return storedCreditResult(env, row.id, await identityKey(row.name, row.email, row.phone));
}

/** The same person checked on another row in the last 30 days (a returning applicant): reuse it, do not pull again. */
async function recentResultFor(env: Env, identity: string, exceptId: number): Promise<CreditResult | null> {
  const r = await env.DB.prepare(
    `SELECT ${CREDIT_RESULT_COLUMNS.join(", ")} FROM leads
     WHERE credit_identity = ?1 AND credit_status = 'success' AND id <> ?2
       AND credit_checked_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')
     ORDER BY id DESC LIMIT 1`,
  ).bind(identity, exceptId).first<CreditColumns>();
  return r ? creditFromColumns(r) : null;
}

async function overDailyCap(env: Env, exceptId: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM leads WHERE id <> ?1 AND credit_status IN ('success', 'invalid', 'queued', 'pending')
       AND credit_checked_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')`,
  ).bind(exceptId).first<{ n: number }>();
  return (r?.n ?? 0) >= creditDailyCap(env);
}

/** A reason worth telling the team about (checks are not running at all), or null for a one-lead outcome. */
function creditProblem(env: Env, result: CreditResult): string | null {
  if (result.status === "queued") return "The SimpleCheck account is paused, so requests are being queued";
  if (result.status === "skipped" && result.error === "daily_cap") return `The daily limit of ${creditDailyCap(env)} checks was reached`;
  if (result.status !== "error") return null;
  if (result.http === 401) return "SimpleCheck rejected the API token";
  if (result.http === 429) return "The SimpleCheck rate limit (100 per hour) was reached";
  if (result.http === 400 || result.http === 403) return "SimpleCheck reports a billing or account problem";
  return null;
}

/** At most one notice per reason every 6 hours. */
async function notifyCreditProblemOnce(env: Env, rowId: number, key: string, reason: string): Promise<void> {
  if (!env.SLACK_LEAD_ALERTS_WEBHOOK) return;
  try {
    const seen = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM leads WHERE id <> ?1 AND credit_error = ?2 AND updated_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 hours')",
    ).bind(rowId, key).first<{ n: number }>();
    if ((seen?.n ?? 0) > 0) return;
    await postSlack(env.SLACK_LEAD_ALERTS_WEBHOOK, creditProblemMessage(reason));
  } catch (err) {
    console.error("[credit] problem notice failed:", String(err).slice(0, 120));
  }
}

/** One SimpleCheck pre-qualification per person per lead row; the result lands on the row. */
async function creditCheckOnce(env: Env, row: LeadRow, meta: Meta, identity: string): Promise<CreditOutcome> {
  const claim = await env.DB.prepare(
    `UPDATE leads SET credit_checked_at = ${SQL_NOW}, credit_status = 'pending', credit_error = NULL
     WHERE id = ?1 AND credit_checked_at IS NULL AND credit_consent = ?2 AND credit_identity = ?3`,
  ).bind(row.id, CREDIT_CONSENT_VERSION, identity).run();
  // Already checked (or in flight) for this person on this row: hand back what is stored, if anything. A check the
  // phone step started may still be running when the full submit arrives: wait for it, briefly.
  if ((claim.meta.changes ?? 0) === 0) return { result: await settledCreditResult(env, row.id, identity, CREDIT_ROUTING_WAIT_MS), fresh: false };

  let result: CreditResult;
  if (meta.country && meta.country !== "US") {
    result = { status: "skipped", error: "non_us" }; // SimpleCheck covers US consumers only
  } else {
    const reused = await recentResultFor(env, identity, row.id);
    if (reused) result = reused;
    else if (await overDailyCap(env, row.id)) result = { status: "skipped", error: "daily_cap" };
    else {
      result = await runPreQualification(
        env.SIMPLECHECK_API_TOKEN!, { name: row.name, email: row.email, phone: row.phone, consentIp: meta.ip },
        fetch, creditEndpoint(env),
      );
    }
  }

  if (result.status !== "success") {
    // 'error' and 'skipped' release the claim so a later submit of this lead can still be checked;
    // 'invalid' and 'queued' keep it (the same input would fail again / the request is already with SimpleCheck).
    await env.DB.prepare(
      "UPDATE leads SET credit_status = ?1, credit_error = ?2, credit_checked_at = CASE WHEN ?1 IN ('error', 'skipped') THEN NULL ELSE credit_checked_at END WHERE id = ?3",
    ).bind(result.status, result.error, row.id).run();
    console.log("[credit] lead", row.id, result.status); // the reason is on the row, not in the log
    const problem = creditProblem(env, result);
    if (problem) await notifyCreditProblemOnce(env, row.id, result.error, problem);
    return { result, fresh: true };
  }

  try {
    await env.DB.prepare(
      `UPDATE leads SET credit_status = 'success', credit_error = NULL, credit_prequal_id = ?1, credit_score = ?2,
         credit_offer_status = ?3, credit_offer_amount_1 = ?4, credit_offer_amount_2 = ?5, credit_dti = ?6,
         credit_income = ?7, credit_household_income = ?8, credit_freeze = ?9 WHERE id = ?10`,
    ).bind(
      result.prequalId, result.score, result.offerStatus, result.offerAmount1, result.offerAmount2, result.dti,
      result.income, result.householdIncome, result.creditFreeze, row.id,
    ).run();
    console.log("[credit] lead", row.id, "checked");
  } catch (err) {
    // The result still reaches Slack and GHL, so a paid report is not lost with the write.
    console.error("[credit] lead", row.id, "result not stored:", String(err).slice(0, 120));
  }
  return { result, fresh: true };
}

/** A fresh credit result for a lead that stays qualified: a Slack follow-up after the lead alert, and the GHL fields. */
async function publishCredit(
  env: Env, row: LeadRow, credit: Promise<CreditOutcome>, contactSynced: Promise<string | null>, after: Promise<unknown>,
): Promise<void> {
  const outcome = await credit;
  if (!outcome.fresh || outcome.result?.status !== "success") return;
  const report: CreditReport = outcome.result;
  const amount = offerAmounts(report);
  await after.catch(() => {});
  const toSlack = async (): Promise<void> => {
    if (!env.SLACK_LEAD_ALERTS_WEBHOOK) return;
    try {
      await postSlack(env.SLACK_LEAD_ALERTS_WEBHOOK, creditAlertMessage({
        id: row.id, name: row.name, score: report.score, offerStatus: report.offerStatus, offerAmount: amount,
        dti: report.dti, income: report.income, creditFreeze: report.creditFreeze,
      }));
    } catch (err) {
      console.error("[credit] slack failed for lead", row.id, String(err).slice(0, 120));
    }
  };
  const toGhl = async (): Promise<void> => {
    const cfg = contactsConfig(env);
    if (!cfg) return;
    try {
      // After the first contact sync, and by contact id, so nothing but the credit fields is touched.
      let contactId = await contactSynced.catch(() => null);
      if (!contactId) {
        const saved = await env.DB.prepare("SELECT ghl_contact_id FROM leads WHERE id = ?1").bind(row.id).first<{ ghl_contact_id: string | null }>();
        contactId = saved?.ghl_contact_id ?? null;
      }
      if (!contactId) { console.log("[credit] lead", row.id, "has no GHL contact; credit fields not written"); return; }
      await updateContactCredit(cfg, contactId, {
        score: report.score == null ? "No credit file matched" : String(report.score),
        offer_status: report.offerStatus,
        offer_amount: amount,
        dti: report.dti == null ? null : `${report.dti}%`,
        income: report.income == null ? null : `$${Math.round(report.income).toLocaleString("en-US")}`,
        credit_freeze: report.creditFreeze,
      });
    } catch (err) {
      console.error("[credit] GHL update failed for lead", row.id, String(err).slice(0, 80));
    }
  };
  await Promise.allSettled([toSlack(), toGhl()]);
}

/** One #lead-alerts message per qualified lead (Yes on capital), the moment a phone is stored. */
async function slackAlertOnce(env: Env, row: LeadRow, partial: boolean, tracking: Tracking | undefined): Promise<void> {
  if (!env.SLACK_LEAD_ALERTS_WEBHOOK) return;
  const res = await env.DB.prepare(
    "UPDATE leads SET slack_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND slack_sent_at IS NULL",
  ).bind(row.id).run();
  if ((res.meta.changes ?? 0) === 0) return;
  try {
    await postSlack(env.SLACK_LEAD_ALERTS_WEBHOOK, leadAlertMessage({
      id: row.id, name: row.name, phone: row.phone, email: row.email, city: row.city, timeline: row.timeline,
      business_owner: row.business_owner, capital: row.capital, partial,
      source: typeof tracking?.utm_source === "string" ? tracking.utm_source : null,
      campaign: typeof tracking?.utm_campaign === "string" ? tracking.utm_campaign : null,
    }));
    console.log("[slack] alert sent for lead", row.id);
  } catch (err) {
    // let a later save retry
    await env.DB.prepare("UPDATE leads SET slack_sent_at = NULL WHERE id = ?1").bind(row.id).run();
    console.error("[slack] alert failed for lead", row.id, String(err).slice(0, 200));
  }
}

async function sendQualifiedOnce(env: Env, leadId: number, payload: Record<string, unknown>): Promise<void> {
  const res = await env.DB.prepare(
    "UPDATE leads SET qualified_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND qualified_sent_at IS NULL",
  ).bind(leadId).run();
  if ((res.meta.changes ?? 0) === 0) return; // already sent for this lead
  await relayEvent(env, "qualified", payload);
}

/** POST /event { event, session_id, city?, timeline?, …, tracking? } → relayed to the matching webhook. */
async function handleEvent(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (!originAllowed(request, env)) return json({ ok: false, error: "Forbidden" }, 403, cors);
  const body = await readBody(request);
  if (!body) return json({ ok: false, error: "Bad request" }, 400, cors);
  const ip = clientIp(request);
  if (env.RL_EVENTS) {
    try { const { success } = await env.RL_EVENTS.limit({ key: `ip:${ip}` }); if (!success) return json({ ok: false, error: "Too many events" }, 429, cors); }
    catch (err) { console.warn("[event] rl failed (open):", String(err)); }
  }
  const raw = body as unknown as Record<string, unknown>;
  const event = typeof raw.event === "string" ? raw.event : "";
  if (!EVENT_NAMES.has(event)) return json({ ok: false, error: "Unknown event" }, 400, cors);
  const hp = raw[HONEYPOT_FIELD];
  if (hp != null && (typeof hp !== "string" || hp.trim() !== "")) return json({ ok: true, silent: true }, 200, cors);
  const country = clientCountry(request);
  if (!countryAllowed(country, env)) return json({ ok: true, silent: true }, 200, cors);
  const fields: Record<string, unknown> = {};
  for (const k of EVENT_FIELDS) { const v = str(raw[k], k === "email" ? 254 : k === "question" ? 300 : 120); if (v) fields[k] = v; }
  if (typeof fields.phone === "string") { const d = normalizePhoneDigits10(fields.phone); if (d) fields.phone = `+1${d}`; else delete fields.phone; }
  if (typeof fields.email === "string" && !isValidEmail(fields.email)) delete fields.email;
  if (event === "qualified") {
    // Qualified needs answers that pass the rules (capital answered, nothing disqualifying) and an email on file.
    const rules = await loadRules(env.DB);
    const given = (k: string): string | undefined => (typeof fields[k] === "string" ? (fields[k] as string) : undefined);
    const passes = answersQualify(rules, { timeline: given("timeline"), business_owner: given("business_owner"), capital: given("capital") });
    if (!passes || !fields.email) return json({ ok: true, silent: true }, 200, cors);
    fields.qualified = true;
  }
  const payload = eventPayload(event, fields, pickTracking(raw.tracking), country);
  ctx.waitUntil(relayEvent(env, event, payload));
  return json({ ok: true }, 202, cors);
}

/* ---------------- native booking (GHL calendar) ---------------- */

const MAX_RANGE_DAYS = 62;
const IANA_RE = /^[A-Za-z_]+(?:\/[A-Za-z_+-]+){0,2}$/;

function ghlConfig(env: Env): GhlConfig | null {
  if (!env.GHL_PIT || !env.GHL_LOCATION_ID || !env.GHL_CALENDAR_ID) return null;
  return { token: env.GHL_PIT, locationId: env.GHL_LOCATION_ID, calendarId: env.GHL_CALENDAR_ID };
}

function validTz(tz: string | null): string | null {
  if (!tz || tz.length > 64 || !IANA_RE.test(tz)) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
}

/** GET /slots?start=YYYY-MM-DD&end=YYYY-MM-DD&tz=IANA → { ok, configured, dates: { "YYYY-MM-DD": [iso…] } } */
async function handleSlots(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (!originAllowed(request, env)) return json({ ok: false, error: "Forbidden" }, 403, cors);
  const cfg = ghlConfig(env);
  if (!cfg) return json({ ok: true, configured: false, dates: {} }, 200, cors);
  const url = new URL(request.url);
  const start = url.searchParams.get("start") ?? "";
  const end = url.searchParams.get("end") ?? "";
  const tz = validTz(url.searchParams.get("tz")) ?? "America/New_York";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return json({ ok: false, error: "start and end must be YYYY-MM-DD" }, 400, cors);
  }
  const startMs = Date.parse(start + "T00:00:00Z");
  const endMs = Date.parse(end + "T23:59:59Z");
  if (!(endMs > startMs) || endMs - startMs > MAX_RANGE_DAYS * 86_400_000) {
    return json({ ok: false, error: "Range must be 1–62 days" }, 400, cors);
  }
  try {
    const dates = await freeSlots(cfg, Math.max(startMs, Date.now()), endMs, tz);
    return json({ ok: true, configured: true, tz, dates }, 200, { ...cors, "Cache-Control": "no-store" });
  } catch (err) {
    console.error("[slots] GHL error:", String(err).slice(0, 300));
    return json({ ok: false, error: "Could not load availability. Please try again." }, 502, cors);
  }
}

type BookBody = { lead_id?: number; phone?: string; email?: string; name?: string; city?: string; start?: string; tz?: string };

/** POST /book { lead_id, phone, start (ISO from /slots), tz } → creates the GHL appointment for the stored lead. */
async function handleBook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (!originAllowed(request, env)) return json({ ok: false, error: "Forbidden" }, 403, cors);
  const cfg = ghlConfig(env);
  if (!cfg) return json({ ok: false, error: "Booking is not configured yet." }, 503, cors);
  const body = (await readBody(request)) as BookBody | null;
  if (!body) return json({ ok: false, error: "Bad request" }, 400, cors);
  const ip = clientIp(request);
  if (await rateLimited(env, ip)) return json({ ok: false, error: "Too many requests. Please wait a moment." }, 429, cors);

  const digits = normalizePhoneDigits10(str(body.phone, 40));
  const start = str(body.start, 40);
  const tz = validTz(str(body.tz, 64) ?? null) ?? "America/New_York";
  if (!digits) return json({ ok: false, error: "Enter a valid 10-digit phone number." }, 400, cors);
  const startMs = start ? Date.parse(start) : NaN;
  if (!Number.isFinite(startMs) || startMs < Date.now() - 60_000) return json({ ok: false, error: "Please pick a time slot." }, 400, cors);
  const phone = `+1${digits}`;

  // The slot must belong to a lead this API stored (a completed, qualified survey).
  const lead = await env.DB.prepare(
    "SELECT id, name, email, city, timeline, business_owner, capital, route FROM leads WHERE phone = ?1 AND status = 'full' ORDER BY id DESC LIMIT 1",
  ).bind(phone).first<{ id: number; name: string | null; email: string | null; city: string | null; timeline: string | null; business_owner: string | null; capital: string | null; route: string | null }>();
  if (!lead || lead.route !== "calendar") return json({ ok: false, error: "Please complete the application first." }, 400, cors);

  // A credit rule can be broken by a result that arrived after routing (a slow check let the lead through).
  // Judge what is on the row once more before a call is booked. If this cannot be read, booking goes ahead.
  try {
    const rules = await loadRules(env.DB);
    if (creditRulesApply(rules, { capital: lead.capital })) {
      const stored = await env.DB.prepare(
        `SELECT credit_status, ${CREDIT_RESULT_COLUMNS.join(", ")} FROM leads WHERE id = ?1`,
      ).bind(lead.id).first<CreditColumns & { credit_status: string | null }>();
      const stored_result = stored && stored.credit_status === "success" ? creditFromColumns(stored) : null;
      const broken = stored_result && stored_result.status === "success" ? creditDqReason(rules, stored_result) : null;
      if (broken) {
        await storeRoute(env, lead.id, broken);
        console.log("[book] lead", lead.id, "refused: a credit rule is broken");
        return json({ ok: false, error: "We can't offer a strategy session right now." }, 400, cors);
      }
    }
  } catch (err) {
    console.error("[book] credit rule check failed for lead", lead.id, String(err).slice(0, 160));
  }

  try {
    const minutes = await slotDurationMinutes(cfg);
    const endMs = startMs + minutes * 60_000;
    const contactId = await upsertSurveyContact(cfg, {
      name: lead.name, email: lead.email, phone, timezone: tz, city: lead.city,
      timeline: lead.timeline, business_owner: lead.business_owner, capital: lead.capital,
      qualified: true, // only a lead routed to the calendar gets this far
    });
    const title = `${lead.name ?? "Dealer"} - ${env.APPOINTMENT_TITLE ?? "Dealer Strategy Session"}`;
    const appointmentId = await createAppointment(cfg, {
      contactId, startTime: new Date(startMs).toISOString(), endTime: new Date(endMs).toISOString(), title,
    });
    await env.DB.prepare(
      "UPDATE leads SET appointment_id = ?1, appointment_start = ?2, appointment_end = ?3, appointment_tz = ?4, ghl_contact_id = ?5, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?6",
    ).bind(appointmentId, new Date(startMs).toISOString(), new Date(endMs).toISOString(), tz, contactId, lead.id).run();
    console.log("[book] appointment", appointmentId, "lead", lead.id, maskName(lead.name), maskPhone(phone), start, tz);
    return json({
      ok: true,
      appointment: { id: appointmentId, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), tz, title: env.APPOINTMENT_TITLE ?? "Dealer Strategy Session", minutes },
    }, 200, cors);
  } catch (err) {
    const msg = String(err);
    console.error("[book] failed for lead", lead.id, msg.slice(0, 300));
    const taken = /slot|not available|already|unavailable/i.test(msg);
    return json({ ok: false, error: taken ? "That time was just taken. Please pick another slot." : "Could not book the appointment. Please try another time." }, 502, cors);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    if (request.method === "GET" && path === "/health") return json({ ok: true }, 200, {});
    if (request.method === "GET" && path === "/leads") return handleExport(request, env);
    if (path.startsWith("/admin/")) {
      const cors = corsHeaders(request, env);
      if (!originAllowed(request, env)) return json({ ok: false, error: "Forbidden" }, 403, cors);
      try {
        return await handleAdmin(request, env, path, cors, json);
      } catch (err) {
        console.error("[admin]", path, String(err).slice(0, 200));
        return json({ ok: false, error: "Something went wrong" }, 500, cors);
      }
    }
    if (request.method === "GET" && path === "/slots") return handleSlots(request, env);
    if (request.method === "POST" && path === "/event") return handleEvent(request, env, ctx);
    if (request.method === "POST" && path === "/contact") return handleEmailCapture(request, env, ctx);
    if (request.method === "POST" && path === "/book") return handleBook(request, env, ctx);
    if (request.method === "POST" && path === "/lead") return handleLead(request, env, ctx, false);
    if (request.method === "POST" && path === "/lead/partial") return handleLead(request, env, ctx, true);
    return json({ ok: false, error: "Not found" }, 404, corsHeaders(request, env));
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runOutcomeSync(env));
  },
} satisfies ExportedHandler<Env>;
