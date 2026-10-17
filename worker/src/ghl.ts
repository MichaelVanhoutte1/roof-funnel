/**
 * Minimal GoHighLevel calendar client for the native booking step.
 * Needs a Private Integration Token with calendars (read), calendar events (write)
 * and contacts (write) scopes on the sub-account.
 */
const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-04-15";

export type GhlConfig = { token: string; locationId: string; calendarId: string };

export type SlotsByDate = Record<string, string[]>;

async function ghl<T>(cfg: GhlConfig, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Version: VERSION,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL ${init.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Free slots between two dates (inclusive), keyed by YYYY-MM-DD in the requested timezone. */
export async function freeSlots(cfg: GhlConfig, startMs: number, endMs: number, timezone: string): Promise<SlotsByDate> {
  const q = new URLSearchParams({ startDate: String(startMs), endDate: String(endMs), timezone });
  const data = await ghl<Record<string, unknown>>(cfg, `/calendars/${cfg.calendarId}/free-slots?${q}`);
  return normalizeSlots(data);
}

/** GHL answers `{ "2026-10-17": { slots: [iso, …] }, …, traceId }`; keep only the date keys. */
export function normalizeSlots(data: Record<string, unknown>): SlotsByDate {
  const out: SlotsByDate = {};
  for (const [k, v] of Object.entries(data)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    const slots = (v as { slots?: unknown })?.slots;
    if (Array.isArray(slots)) out[k] = slots.filter((s): s is string => typeof s === "string").sort();
  }
  return out;
}

export async function slotDurationMinutes(cfg: GhlConfig): Promise<number> {
  const data = await ghl<{ calendar?: { slotDuration?: number; slotDurationUnit?: string } }>(cfg, `/calendars/${cfg.calendarId}`);
  const d = data.calendar?.slotDuration ?? 30;
  const unit = (data.calendar?.slotDurationUnit ?? "mins").toLowerCase();
  return unit.startsWith("hour") ? d * 60 : d;
}

export async function upsertContact(
  cfg: GhlConfig,
  c: { firstName?: string; lastName?: string; email?: string; phone: string; timezone?: string; city?: string },
): Promise<string> {
  const data = await ghl<{ contact?: { id?: string } }>(cfg, "/contacts/upsert", {
    method: "POST",
    body: JSON.stringify({
      locationId: cfg.locationId,
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: c.phone,
      timezone: c.timezone,
      city: c.city,
      source: "startroofrejuvenating.com application",
    }),
  });
  const id = data.contact?.id;
  if (!id) throw new Error("GHL upsert returned no contact id");
  return id;
}

export async function createAppointment(
  cfg: GhlConfig,
  a: { contactId: string; startTime: string; endTime: string; title: string },
): Promise<string> {
  const data = await ghl<{ id?: string; appointmentStatus?: string }>(cfg, "/calendars/events/appointments", {
    method: "POST",
    body: JSON.stringify({
      calendarId: cfg.calendarId,
      locationId: cfg.locationId,
      contactId: a.contactId,
      startTime: a.startTime,
      endTime: a.endTime,
      title: a.title,
      appointmentStatus: "confirmed",
      ignoreDateRange: false,
      toNotify: true,
    }),
  });
  if (!data.id) throw new Error("GHL appointment returned no id");
  return data.id;
}

/* ---------------- contacts + custom fields (survey answers on the GHL contact) ---------------- */

export type ContactsConfig = { token: string; locationId: string };

/** Custom fields the funnel writes; created on first use if the sub-account lacks them. */
export const SURVEY_FIELDS = [
  { key: "timeline", name: "Survey: Timeline" },
  { key: "business_owner", name: "Survey: Business Owner" },
  { key: "capital", name: "Survey: Capital" },
  { key: "qualified", name: "Survey: Qualified" },
  { key: "city", name: "Survey: City" },
] as const;

let fieldIdCache: { locationId: string; ids: Record<string, string> } | null = null;

async function listCustomFields(cfg: ContactsConfig): Promise<Array<{ id: string; name: string }>> {
  const data = await ghl<{ customFields?: Array<{ id: string; name: string }> }>(cfg as GhlConfig, `/locations/${cfg.locationId}/customFields?model=contact`);
  return data.customFields ?? [];
}

/** Resolve (and if needed create) the survey custom fields; returns key → field id. */
export async function ensureSurveyFields(cfg: ContactsConfig): Promise<Record<string, string>> {
  if (fieldIdCache && fieldIdCache.locationId === cfg.locationId && Object.keys(fieldIdCache.ids).length === SURVEY_FIELDS.length) return fieldIdCache.ids;
  const existing = await listCustomFields(cfg);
  const ids: Record<string, string> = {};
  for (const f of SURVEY_FIELDS) {
    const found = existing.find((e) => e.name.trim().toLowerCase() === f.name.toLowerCase());
    if (found) { ids[f.key] = found.id; continue; }
    const created = await ghl<{ customField?: { id: string } }>(cfg as GhlConfig, `/locations/${cfg.locationId}/customFields`, {
      method: "POST",
      body: JSON.stringify({ name: f.name, dataType: "TEXT", model: "contact", placeholder: "" }),
    });
    if (created.customField?.id) ids[f.key] = created.customField.id;
  }
  fieldIdCache = { locationId: cfg.locationId, ids };
  return ids;
}

export type SurveyContact = {
  name?: string | null; email?: string | null; phone?: string | null; city?: string | null; timezone?: string | null;
  timeline?: string | null; business_owner?: string | null; capital?: string | null; qualified?: boolean | null;
};

/** Create or update the contact (GHL matches on email or phone) with the survey answers as custom fields. */
export async function upsertSurveyContact(cfg: ContactsConfig, c: SurveyContact): Promise<string> {
  let ids: Record<string, string> = {};
  try { ids = await ensureSurveyFields(cfg); } catch (err) { console.warn("[ghl] custom fields unavailable, contact saved without them:", String(err).slice(0, 160)); }
  const parts = (c.name ?? "").trim().split(/\s+/).filter(Boolean);
  const customFields: Array<{ id: string; field_value: string }> = [];
  const put = (key: string, value: string | null | undefined) => { if (ids[key] && value) customFields.push({ id: ids[key], field_value: value }); };
  put("timeline", c.timeline); put("business_owner", c.business_owner); put("capital", c.capital); put("city", c.city);
  if (c.qualified != null) put("qualified", c.qualified ? "Yes" : "No");
  const tags = ["funnel-application", ...(c.qualified == null ? [] : [c.qualified ? "qualified" : "not-qualified"]), ...(c.phone ? [] : ["email-only"])];
  const body: Record<string, unknown> = {
    locationId: cfg.locationId,
    ...(parts[0] ? { firstName: parts[0] } : {}),
    ...(parts.length > 1 ? { lastName: parts.slice(1).join(" ") } : {}),
    ...(c.email ? { email: c.email } : {}),
    ...(c.phone ? { phone: c.phone } : {}),
    ...(c.city ? { city: c.city } : {}),
    ...(c.timezone ? { timezone: c.timezone } : {}),
    source: "startroofrejuvenating.com application",
    tags,
    ...(customFields.length ? { customFields } : {}),
  };
  const data = await ghl<{ contact?: { id?: string } }>(cfg as GhlConfig, "/contacts/upsert", { method: "POST", body: JSON.stringify(body) });
  const id = data.contact?.id;
  if (!id) throw new Error("GHL upsert returned no contact id");
  return id;
}
