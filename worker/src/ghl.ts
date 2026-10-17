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
