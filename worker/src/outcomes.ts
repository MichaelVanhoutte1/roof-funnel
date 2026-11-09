/**
 * Outcome sync: what happened to a lead after the funnel, copied onto its row so the report can count it.
 *
 *  1. Pipeline      GHL opportunity stage, status and value (setter disqualified, passed to closer, won, cash).
 *  2. Setter calls  GHL call log for booked leads (the setter call is a phone call): number of calls and the
 *                   longest completed one. The report treats a long call as "showed".
 *  3. Closer calls  The closer appointment the setter booked in GHL (a Google Meet), then who attended it:
 *                   Google Meet participants when a Google connection exists, else a Fathom recording.
 *
 * Every step is read-only towards GHL / Fathom / Google and is skipped when its credentials are missing.
 * A run is budgeted to stay well under the Worker's subrequest limit; whatever is left waits for the next run.
 */
import { ghl, type GhlConfig } from "./ghl.ts";

const OPPORTUNITIES_API = { Version: "2021-07-28" };
const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
/** A Fathom recording at least this long counts as a closer call that happened (a no-show wait is shorter). */
export const FATHOM_SHOW_MIN_MINUTES = 10;
/** With Google Meet: a second participant present at least this long counts as showed. */
export const MEET_SHOW_MIN_MINUTES = 5;

export type SyncEnv = {
  DB: D1Database;
  GHL_PIT?: string;
  GHL_LOCATION_ID?: string;
  /** Fathom API key of the roof business account (secret). Unset = no Fathom attendance. */
  FATHOM_API_KEY?: string;
  /** Google OAuth client + one refresh token per closer Google account (JSON array or comma-separated), scope meetings.space.readonly. */
  GOOGLE_MEET_CLIENT_ID?: string;
  GOOGLE_MEET_CLIENT_SECRET?: string;
  GOOGLE_MEET_REFRESH_TOKENS?: string;
};

export type SyncSummary = {
  at: string;
  pipeline?: { opportunities: number; updated: number } | { error: string };
  closerAppointments?: { events: number; updated: number } | { error: string };
  setterCalls?: { checked: number; failed: number; remaining: number } | { error: string };
  closerAttendance?: { source: "google_meet" | "fathom" | "none"; checked: number; resolved: number } | { error: string };
};

function ghlConfigOf(env: SyncEnv): GhlConfig | null {
  if (!env.GHL_PIT || !env.GHL_LOCATION_ID) return null;
  return { token: env.GHL_PIT, locationId: env.GHL_LOCATION_ID, calendarId: "" };
}

function errorText(err: unknown): string {
  return String(err).slice(0, 160);
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<number> {
  let changed = 0;
  for (let i = 0; i < statements.length; i += 50) {
    const results = await db.batch(statements.slice(i, i + 50));
    for (const r of results) changed += r.meta.changes ?? 0;
  }
  return changed;
}

/* ---------------- 1. pipeline ---------------- */

type Opportunity = {
  id: string; contactId?: string; pipelineStageId?: string; status?: string; monetaryValue?: number | null;
  lastStageChangeAt?: string; updatedAt?: string;
};

export async function syncPipeline(db: D1Database, cfg: GhlConfig): Promise<{ opportunities: number; updated: number }> {
  const pipes = await ghl<{ pipelines?: Array<{ stages?: Array<{ id: string; name: string }> }> }>(
    cfg, `/opportunities/pipelines?locationId=${cfg.locationId}`, { headers: OPPORTUNITIES_API },
  );
  const stageName = new Map<string, string>();
  for (const p of pipes.pipelines ?? []) for (const s of p.stages ?? []) stageName.set(s.id, s.name);

  const opportunities: Opportunity[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = await ghl<{ opportunities?: Opportunity[] }>(
      cfg, `/opportunities/search?location_id=${cfg.locationId}&limit=100&page=${page}`, { headers: OPPORTUNITIES_API },
    );
    const batch = data.opportunities ?? [];
    opportunities.push(...batch);
    if (batch.length < 100) break;
  }

  // Only rows whose stored values differ are written.
  const statements = opportunities.filter((o) => o.contactId).map((o) => {
    const stage = stageName.get(o.pipelineStageId ?? "") ?? null;
    const value = typeof o.monetaryValue === "number" && o.monetaryValue > 0 ? o.monetaryValue : null;
    return db.prepare(
      `UPDATE leads SET opportunity_id = ?1, pipeline_stage = ?2, pipeline_stage_at = ?3, opportunity_status = ?4, opportunity_value = ?5
       WHERE ghl_contact_id = ?6 AND (opportunity_id IS NOT ?1 OR pipeline_stage IS NOT ?2 OR opportunity_status IS NOT ?4 OR opportunity_value IS NOT ?5)`,
    ).bind(o.id, stage, o.lastStageChangeAt ?? o.updatedAt ?? null, o.status ?? null, value, o.contactId);
  });
  return { opportunities: opportunities.length, updated: await runBatches(db, statements) };
}

/* ---------------- 2. setter calls (GHL call log) ---------------- */

type GhlMessage = { messageType?: string; type?: unknown; status?: string; meta?: { call?: { duration?: number | null }; callDuration?: number | null } | null };

/** Number of call records and the longest completed one, in seconds. */
export function summarizeCalls(messages: GhlMessage[]): { calls: number; longestSeconds: number } {
  let calls = 0, longestSeconds = 0;
  for (const m of messages) {
    if (!/CALL/i.test(String(m.messageType ?? m.type ?? ""))) continue;
    calls++;
    if (m.status !== "completed") continue;
    const seconds = Number(m.meta?.call?.duration ?? m.meta?.callDuration ?? 0);
    if (Number.isFinite(seconds) && seconds > longestSeconds) longestSeconds = Math.round(seconds);
  }
  return { calls, longestSeconds };
}

async function callsForContact(cfg: GhlConfig, contactId: string): Promise<{ calls: number; longestSeconds: number }> {
  const found = await ghl<{ conversations?: Array<{ id: string }> }>(cfg, `/conversations/search?locationId=${cfg.locationId}&contactId=${encodeURIComponent(contactId)}`);
  const conversation = found.conversations?.[0];
  if (!conversation) return { calls: 0, longestSeconds: 0 };
  const data = await ghl<{ messages?: { messages?: GhlMessage[] } | GhlMessage[] }>(cfg, `/conversations/${conversation.id}/messages?limit=100`);
  const messages = Array.isArray(data.messages) ? data.messages : data.messages?.messages ?? [];
  return summarizeCalls(messages);
}

/** Booked leads whose call is in the past: never synced first, then calls from the last 3 days (stale by 2 h). */
export async function syncSetterCalls(db: D1Database, cfg: GhlConfig, max: number): Promise<{ checked: number; failed: number; remaining: number }> {
  const due = `appointment_id IS NOT NULL AND ghl_contact_id IS NOT NULL AND appointment_start <= ${SQL_NOW}
    AND (setter_calls_synced_at IS NULL OR (appointment_start > strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days')
         AND setter_calls_synced_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours')))`;
  const { results } = await db.prepare(
    `SELECT id, ghl_contact_id FROM leads WHERE ${due} ORDER BY setter_calls_synced_at IS NOT NULL, appointment_start DESC LIMIT ?1`,
  ).bind(max).all<{ id: number; ghl_contact_id: string }>();
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE ${due}`).first<{ n: number }>();
  const todo = results;
  const statements: D1PreparedStatement[] = [];
  let failed = 0;
  for (const lead of todo) {
    try {
      const c = await callsForContact(cfg, lead.ghl_contact_id);
      statements.push(db.prepare(
        `UPDATE leads SET setter_calls = ?1, setter_call_seconds = ?2, setter_calls_synced_at = ${SQL_NOW} WHERE id = ?3`,
      ).bind(c.calls, c.longestSeconds, lead.id));
    } catch (err) {
      // One contact GHL will not answer for (deleted, merged) must not block everyone behind it: mark it
      // looked-at with no call data, so the pipeline stage alone decides for that lead.
      failed++;
      console.error("[sync] call log failed for lead", lead.id, errorText(err).replace(/contactId=[^ &]+/, "contactId=…"));
      statements.push(db.prepare(`UPDATE leads SET setter_calls_synced_at = ${SQL_NOW} WHERE id = ?1`).bind(lead.id));
    }
  }
  await runBatches(db, statements);
  return { checked: todo.length, failed, remaining: Math.max(0, (total?.n ?? todo.length) - todo.length) };
}

/* ---------------- 3a. closer appointments (GHL) ---------------- */

export function meetCode(url: string | null | undefined): string | null {
  const m = /meet\.google\.com\/([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})/i.exec(url ?? "");
  return m ? m[1].toLowerCase() : null;
}

type CalendarEvent = { id: string; contactId?: string; appointmentStatus?: string; startTime?: string; address?: string | null };

function isoOrNull(v: string | undefined): string | null {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The newest closer appointment per contact; a live one wins over a cancelled one. */
export function pickCloserEvents(events: CalendarEvent[]): Map<string, CalendarEvent> {
  const best = new Map<string, CalendarEvent>();
  for (const e of events) {
    if (!e.contactId || !isoOrNull(e.startTime)) continue;
    const current = best.get(e.contactId);
    const live = e.appointmentStatus !== "cancelled";
    const currentLive = current ? current.appointmentStatus !== "cancelled" : false;
    if (!current || (live && !currentLive) || (live === currentLive && isoOrNull(e.startTime)! > isoOrNull(current.startTime)!)) best.set(e.contactId, e);
  }
  return best;
}

/** Calendars whose name contains "closer" hold the closer calls (Closer Calendar, Closer Followup Calendar). */
export async function syncCloserAppointments(db: D1Database, cfg: GhlConfig, nowMs: number): Promise<{ events: number; updated: number }> {
  const calendars = await ghl<{ calendars?: Array<{ id: string; name?: string }> }>(cfg, `/calendars/?locationId=${cfg.locationId}`);
  const closer = (calendars.calendars ?? []).filter((c) => /closer/i.test(c.name ?? "")).slice(0, 4);
  const events: CalendarEvent[] = [];
  const start = nowMs - 30 * 86_400_000, end = nowMs + 30 * 86_400_000;
  for (const c of closer) {
    const data = await ghl<{ events?: CalendarEvent[] }>(cfg, `/calendars/events?locationId=${cfg.locationId}&calendarId=${c.id}&startTime=${start}&endTime=${end}`);
    events.push(...(data.events ?? []));
  }
  const statements = [...pickCloserEvents(events).entries()].map(([contactId, e]) =>
    // A different appointment (a reschedule creates a new one) starts with unknown attendance again.
    db.prepare(
      `UPDATE leads SET closer_attended = CASE WHEN closer_appointment_id IS ?1 THEN closer_attended ELSE NULL END,
         closer_attended_source = CASE WHEN closer_appointment_id IS ?1 THEN closer_attended_source ELSE NULL END,
         closer_minutes = CASE WHEN closer_appointment_id IS ?1 THEN closer_minutes ELSE NULL END,
         closer_checked_at = CASE WHEN closer_appointment_id IS ?1 THEN closer_checked_at ELSE NULL END,
         closer_appointment_id = ?1, closer_start = ?2, closer_status = ?3, closer_meet_code = ?4
       WHERE ghl_contact_id = ?5 AND (closer_appointment_id IS NOT ?1 OR closer_start IS NOT ?2 OR closer_status IS NOT ?3 OR closer_meet_code IS NOT ?4)`,
    ).bind(e.id, isoOrNull(e.startTime), e.appointmentStatus ?? null, meetCode(e.address), contactId));
  return { events: events.length, updated: await runBatches(db, statements) };
}

/* ---------------- 3b. closer attendance (Google Meet, else Fathom) ---------------- */

export type Attendance = { attended: "showed" | "no_show"; minutes: number };

type FathomMeeting = { meeting_url?: string | null; recording_start_time?: string | null; recording_end_time?: string | null };

/** Meet code → attendance from Fathom recordings: the longest recording of that meeting decides. */
export function fathomAttendance(meetings: FathomMeeting[]): Map<string, Attendance> {
  const out = new Map<string, Attendance>();
  for (const m of meetings) {
    const code = meetCode(m.meeting_url);
    const start = Date.parse(m.recording_start_time ?? ""), end = Date.parse(m.recording_end_time ?? "");
    if (!code || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const minutes = Math.round((end - start) / 60_000);
    const previous = out.get(code);
    if (!previous || minutes > previous.minutes) out.set(code, { attended: minutes >= FATHOM_SHOW_MIN_MINUTES ? "showed" : "no_show", minutes });
  }
  return out;
}

async function fathomMeetings(apiKey: string, sinceIso: string, maxPages: number): Promise<FathomMeeting[]> {
  const items: FathomMeeting[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ created_after: sinceIso });
    if (cursor) q.set("cursor", cursor);
    const res = await fetch(`https://api.fathom.ai/external/v1/meetings?${q}`, { headers: { "X-Api-Key": apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Fathom GET /meetings → ${res.status}`);
    const data = (await res.json()) as { items?: FathomMeeting[]; next_cursor?: string | null };
    items.push(...(data.items ?? []));
    cursor = data.next_cursor ?? null;
    if (!cursor) break;
  }
  return items;
}

type MeetParticipant = { earliestStartTime?: string; latestEndTime?: string };

/** showed = at least two participants, the second-longest present for MEET_SHOW_MIN_MINUTES or more. */
export function meetAttendance(participants: MeetParticipant[], nowMs: number): Attendance {
  const minutes = participants
    .map((p) => {
      const start = Date.parse(p.earliestStartTime ?? ""), end = p.latestEndTime ? Date.parse(p.latestEndTime) : nowMs;
      return Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 60_000 : 0;
    })
    .sort((a, b) => b - a);
  const second = Math.round(minutes[1] ?? 0);
  return { attended: second >= MEET_SHOW_MIN_MINUTES ? "showed" : "no_show", minutes: second };
}

function refreshTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === "string" && !!t.trim());
  } catch { /* comma-separated */ }
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

/**
 * Google Meet REST API v2 (conferenceRecords). NOT yet exercised against a real account: it was written from
 * Google's reference while the roof business's Google connection did not exist. Verify on the first run.
 */
async function googleAccessToken(env: SyncEnv, refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_MEET_CLIENT_ID ?? "", client_secret: env.GOOGLE_MEET_CLIENT_SECRET ?? "", refresh_token: refreshToken, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Google token → ${res.status}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Google token response had no access_token");
  return data.access_token;
}

async function meetParticipants(accessToken: string, code: string): Promise<MeetParticipant[] | null> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  const filter = encodeURIComponent(`space.meeting_code = "${code}"`);
  const res = await fetch(`https://meet.googleapis.com/v2/conferenceRecords?filter=${filter}`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Meet conferenceRecords → ${res.status}`);
  const records = ((await res.json()) as { conferenceRecords?: Array<{ name: string }> }).conferenceRecords ?? [];
  if (!records.length) return null; // this account did not host that meeting, or it has not happened
  const all: MeetParticipant[] = [];
  for (const record of records.slice(0, 2)) {
    const p = await fetch(`https://meet.googleapis.com/v2/${record.name}/participants?pageSize=50`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!p.ok) throw new Error(`Meet participants → ${p.status}`);
    all.push(...(((await p.json()) as { participants?: MeetParticipant[] }).participants ?? []));
  }
  return all;
}

type CloserDue = { id: number; closer_meet_code: string };

export async function syncCloserAttendance(env: SyncEnv, nowMs: number, max: number): Promise<{ source: "google_meet" | "fathom" | "none"; checked: number; resolved: number }> {
  const tokens = env.GOOGLE_MEET_CLIENT_ID && env.GOOGLE_MEET_CLIENT_SECRET ? refreshTokens(env.GOOGLE_MEET_REFRESH_TOKENS) : [];
  const source = tokens.length ? "google_meet" : env.FATHOM_API_KEY ? "fathom" : "none";
  if (source === "none") return { source, checked: 0, resolved: 0 };

  // Closer calls that started at least 45 minutes ago, in the last 14 days, with attendance still unknown.
  const { results: due } = await env.DB.prepare(
    `SELECT id, closer_meet_code FROM leads
     WHERE closer_meet_code IS NOT NULL AND closer_attended IS NULL AND IFNULL(closer_status, '') <> 'cancelled'
       AND closer_start < strftime('%Y-%m-%dT%H:%M:%fZ','now','-45 minutes') AND closer_start > strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days')
       AND (closer_checked_at IS NULL OR closer_checked_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours'))
     ORDER BY closer_start DESC LIMIT ?1`,
  ).bind(max).all<CloserDue>();
  if (!due.length) return { source, checked: 0, resolved: 0 };

  const found = new Map<number, Attendance>();
  if (source === "google_meet") {
    const access: string[] = [];
    for (const t of tokens.slice(0, 4)) access.push(await googleAccessToken(env, t));
    for (const lead of due) {
      for (const token of access) {
        const participants = await meetParticipants(token, lead.closer_meet_code);
        if (participants) { found.set(lead.id, meetAttendance(participants, nowMs)); break; }
      }
    }
  } else {
    const byCode = fathomAttendance(await fathomMeetings(env.FATHOM_API_KEY!, new Date(nowMs - 15 * 86_400_000).toISOString(), 3));
    for (const lead of due) {
      const a = byCode.get(lead.closer_meet_code);
      if (a) found.set(lead.id, a);
    }
  }
  const statements = due.map((lead) => {
    const a = found.get(lead.id);
    return a
      ? env.DB.prepare(`UPDATE leads SET closer_attended = ?1, closer_attended_source = ?2, closer_minutes = ?3, closer_checked_at = ${SQL_NOW} WHERE id = ?4`).bind(a.attended, source, a.minutes, lead.id)
      : env.DB.prepare(`UPDATE leads SET closer_checked_at = ${SQL_NOW} WHERE id = ?1`).bind(lead.id);
  });
  await runBatches(env.DB, statements);
  return { source, checked: due.length, resolved: found.size };
}

/* ---------------- run ---------------- */

export async function runOutcomeSync(env: SyncEnv, nowMs: number = Date.now()): Promise<SyncSummary> {
  const summary: SyncSummary = { at: new Date(nowMs).toISOString() };
  const cfg = ghlConfigOf(env);
  if (cfg) {
    try { summary.pipeline = await syncPipeline(env.DB, cfg); } catch (err) { summary.pipeline = { error: errorText(err) }; }
    try { summary.closerAppointments = await syncCloserAppointments(env.DB, cfg, nowMs); } catch (err) { summary.closerAppointments = { error: errorText(err) }; }
    // 2 GHL calls per lead; 12 leads keeps a whole run under ~45 subrequests.
    try { summary.setterCalls = await syncSetterCalls(env.DB, cfg, 12); } catch (err) { summary.setterCalls = { error: errorText(err) }; }
  }
  try { summary.closerAttendance = await syncCloserAttendance(env, nowMs, 4); } catch (err) { summary.closerAttendance = { error: errorText(err) }; }
  try {
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('sync_status', ?1, ${SQL_NOW})
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(summary)).run();
  } catch (err) {
    console.error("[sync] could not store the summary:", errorText(err));
  }
  console.log("[sync]", JSON.stringify(summary));
  return summary;
}
