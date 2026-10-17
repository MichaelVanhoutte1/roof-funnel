/**
 * roof-funnel API — Cloudflare Worker.
 *
 *   POST /lead          full survey submission → D1 row → GHL inbound webhook (background)
 *   POST /lead/partial  abandonment save (phone + whatever exists) → D1 upsert → GHL (background)
 *   GET  /leads         admin export (Authorization: Bearer ADMIN_TOKEN) ?since=ISO&limit=N
 *   GET  /health
 *
 * Gates, in order: CORS origin → rate limit (8/min binding, 40/h in D1) → honeypot → IP country
 * → validation (reject / ghost / process). Ghosted and blocked traffic gets a 200 `silent`
 * success so bots and out-of-market visitors learn nothing; nothing of theirs is stored.
 */
import {
  CAPITAL_DQ_VALUE,
  classifyFullSubmission,
  classifyPartialSubmission,
  isValidEmail,
  normalizePhoneDigits10,
  type FakeLeadConfig,
  type LeadInput,
} from "./validation.ts";
import { maskEmail, maskName, maskPhone } from "./log-mask.ts";
import { createAppointment, freeSlots, slotDurationMinutes, upsertContact, type GhlConfig } from "./ghl.ts";

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
}

const HONEYPOT_FIELD = "contact_fax";
const HOURLY_LIMIT = 40;
const MAX_BODY_BYTES = 16_384;
const GHL_TIMEOUT_MS = 8_000;

type Tracking = Record<string, string | number | undefined>;

type Body = LeadInput & {
  survey_partial?: boolean;
  superseded_phone?: string;
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

  const qualified = partial ? null : input.capital !== CAPITAL_DQ_VALUE;
  const route = partial ? null : qualified ? "calendar" : "dq";

  const row = await upsertLead(
    env,
    {
      status: partial ? "partial" : "full",
      route,
      qualified,
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
  console.log(`[${tag}] stored lead`, row.id, maskName(row.name), maskPhone(row.phone), "route:", route, "country:", country);
  ctx.waitUntil(pushToGhl(env, row));
  ctx.waitUntil(relayEvent(env, "phone", eventPayload("phone", {
    lead_id: row.id, session_id: tracking?.session_id, city: row.city, timeline: row.timeline, business_owner: row.business_owner,
    capital: row.capital, name: row.name, email: row.email, phone: row.phone,
    survey_partial: partial, ...(qualified == null ? {} : { qualified }),
  }, tracking, country)));

  if (partial) return json({ ok: true, partial_saved: true }, 200, cors);
  return json({ ok: true, lead_id: row.id, route, qualified }, 200, cors);
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

/* ---------------- step webhooks (Cortana) ---------------- */

const EVENT_FIELDS = ["session_id", "city", "timeline", "business_owner", "capital", "name", "email", "phone"] as const;
const EVENT_NAMES = new Set(["q1", "q2", "q3", "q4", "q5", "q6", "email", "phone", "qualified"]);

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
  for (const k of EVENT_FIELDS) { const v = str(raw[k], k === "email" ? 254 : 120); if (v) fields[k] = v; }
  if (typeof fields.phone === "string") { const d = normalizePhoneDigits10(fields.phone); if (d) fields.phone = `+1${d}`; else delete fields.phone; }
  if (typeof fields.email === "string" && !isValidEmail(fields.email)) delete fields.email;
  if (event === "qualified") fields.qualified = true;
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
    "SELECT id, name, email, city, route FROM leads WHERE phone = ?1 AND status = 'full' ORDER BY id DESC LIMIT 1",
  ).bind(phone).first<{ id: number; name: string | null; email: string | null; city: string | null; route: string | null }>();
  if (!lead || lead.route !== "calendar") return json({ ok: false, error: "Please complete the application first." }, 400, cors);

  try {
    const minutes = await slotDurationMinutes(cfg);
    const endMs = startMs + minutes * 60_000;
    const parts = (lead.name ?? "").trim().split(/\s+/).filter(Boolean);
    const contactId = await upsertContact(cfg, {
      firstName: parts[0], lastName: parts.length > 1 ? parts.slice(1).join(" ") : undefined,
      email: lead.email ?? undefined, phone, timezone: tz, city: lead.city ?? undefined,
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
    if (request.method === "GET" && path === "/slots") return handleSlots(request, env);
    if (request.method === "POST" && path === "/event") return handleEvent(request, env, ctx);
    if (request.method === "POST" && path === "/book") return handleBook(request, env, ctx);
    if (request.method === "POST" && path === "/lead") return handleLead(request, env, ctx, false);
    if (request.method === "POST" && path === "/lead/partial") return handleLead(request, env, ctx, true);
    return json({ ok: false, error: "Not found" }, 404, corsHeaders(request, env));
  },
} satisfies ExportedHandler<Env>;
