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
import { MEET_SCOPE, parseServiceAccount, serviceAccountToken } from "./google.ts";
import { maskEmail } from "./log-mask.ts";

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
  /** The funnel's own booking calendar (the setter calls). */
  GHL_CALENDAR_ID?: string;
  /** Fathom API key of the roof business account (secret). Unset = no Fathom attendance. */
  FATHOM_API_KEY?: string;
  /** Google service-account key (JSON) with domain-wide delegation for meetings.space.readonly; acts as each call's host. */
  GOOGLE_MEET_SERVICE_ACCOUNT?: string;
  /**
   * JSON map of GHL user email → Workspace account to read that host's Meet calls as, for a closer whose GHL login
   * is not a Workspace address (e.g. {"michael@stonesystems.io":"mike@startroofrejuvenating.com"}). Optional var.
   */
  MEET_HOST_ALIASES?: string;
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
  return { token: env.GHL_PIT, locationId: env.GHL_LOCATION_ID, calendarId: env.GHL_CALENDAR_ID ?? "" };
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

/** One opportunity per contact: the most recently changed one. */
export function latestOpportunityPerContact(opportunities: Opportunity[]): Map<string, Opportunity> {
  const changed = (o: Opportunity): string => o.updatedAt ?? o.lastStageChangeAt ?? "";
  const best = new Map<string, Opportunity>();
  for (const o of opportunities) {
    if (!o.contactId) continue;
    const current = best.get(o.contactId);
    if (!current || changed(o) > changed(current)) best.set(o.contactId, o);
  }
  return best;
}

export async function syncPipeline(db: D1Database, cfg: GhlConfig): Promise<{ opportunities: number; updated: number }> {
  const pipes = await ghl<{ pipelines?: Array<{ stages?: Array<{ id: string; name: string }> }> }>(
    cfg, `/opportunities/pipelines?locationId=${cfg.locationId}`, { headers: OPPORTUNITIES_API },
  );
  const stageName = new Map<string, string>();
  for (const p of pipes.pipelines ?? []) for (const s of p.stages ?? []) stageName.set(s.id, s.name);

  const opportunities: Opportunity[] = [];
  for (let page = 1; page <= 6; page++) {
    const data = await ghl<{ opportunities?: Opportunity[] }>(
      cfg, `/opportunities/search?location_id=${cfg.locationId}&limit=100&page=${page}`, { headers: OPPORTUNITIES_API },
    );
    const batch = data.opportunities ?? [];
    opportunities.push(...batch);
    if (batch.length < 100) break;
  }

  // A contact can have several lead rows (a returning applicant): the outcome is written to the newest one only,
  // so a close is never counted twice. Only rows whose stored values differ are written.
  const statements = [...latestOpportunityPerContact(opportunities).entries()].map(([contactId, o]) => {
    const stage = stageName.get(o.pipelineStageId ?? "") ?? null;
    const value = typeof o.monetaryValue === "number" && o.monetaryValue > 0 ? o.monetaryValue : null;
    return db.prepare(
      `UPDATE leads SET opportunity_id = ?1, pipeline_stage = ?2, pipeline_stage_at = ?3, opportunity_status = ?4, opportunity_value = ?5
       WHERE id = (SELECT MAX(id) FROM leads WHERE ghl_contact_id = ?6)
         AND (opportunity_id IS NOT ?1 OR pipeline_stage IS NOT ?2 OR opportunity_status IS NOT ?4 OR opportunity_value IS NOT ?5)`,
    ).bind(o.id, stage, o.lastStageChangeAt ?? o.updatedAt ?? null, o.status ?? null, value, contactId);
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
      failed++;
      const text = errorText(err);
      console.error("[sync] call log failed for lead", lead.id, text.replace(/contactId=[^ &]+/, "contactId=…"));
      // A contact GHL no longer has (deleted, merged: 400 / 404) is marked looked-at with no call data, so the
      // pipeline stage alone decides for that lead. Anything else (rate limit, timeout) is retried next run.
      if (/→ (400|404|422):/.test(text)) {
        statements.push(db.prepare(`UPDATE leads SET setter_calls_synced_at = ${SQL_NOW} WHERE id = ?1`).bind(lead.id));
      }
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

type CalendarEvent = { id: string; contactId?: string; appointmentStatus?: string; startTime?: string; address?: string | null; assignedUserId?: string | null };

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

/**
 * Calendars whose name contains "closer" hold the closer calls (Closer Calendar, Closer Followup Calendar); the one whose
 * name contains "setter" holds the funnel's own bookings, refreshed here so status, time and assigned setter follow GHL.
 */
export async function syncCloserAppointments(db: D1Database, cfg: GhlConfig, nowMs: number): Promise<{ events: number; updated: number }> {
  const calendars = await ghl<{ calendars?: Array<{ id: string; name?: string }> }>(cfg, `/calendars/?locationId=${cfg.locationId}`);
  const closer = (calendars.calendars ?? []).filter((c) => /closer/i.test(c.name ?? "")).slice(0, 4);
  // The setter calendar is the configured booking calendar (GHL_CALENDAR_ID); a "setter" name is the fallback.
  const setter = (calendars.calendars ?? []).filter((c) => (cfg.calendarId && c.id === cfg.calendarId) || /setter/i.test(c.name ?? "")).slice(0, 2);
  if (!setter.length) console.error("[sync] no setter calendar found (GHL_CALENDAR_ID unset and no calendar named *setter*); setter appointments not refreshed");
  const events: CalendarEvent[] = [], setterEvents: CalendarEvent[] = [];
  const start = nowMs - 30 * 86_400_000, end = nowMs + 30 * 86_400_000;
  // Setter calls older than a week do not move any more: a short look-back keeps the statement count small.
  const setterStart = nowMs - 7 * 86_400_000;
  for (const c of [...closer, ...setter]) {
    const isCloser = closer.includes(c);
    const data = await ghl<{ events?: CalendarEvent[] }>(cfg, `/calendars/events?locationId=${cfg.locationId}&calendarId=${c.id}&startTime=${isCloser ? start : setterStart}&endTime=${end}`);
    (isCloser ? events : setterEvents).push(...(data.events ?? []));
  }
  const picked = pickCloserEvents(events), pickedSetter = pickCloserEvents(setterEvents);
  // The host's email is what the Meet API is read as (domain-wide delegation acts as the host). One users call per sync.
  const hosts = await hostEmails(db, cfg, [...picked.values(), ...pickedSetter.values()].map((e) => e.assignedUserId ?? ""));
  // Setter appointments were written once at booking; GHL is the truth for reschedules, cancellations and the assigned setter.
  // The row that already holds this appointment wins (a returning applicant can have a newer row with the same GHL
  // contact id; copying the booking onto it would count the call twice). A genuinely new booking lands on the newest row.
  // At most one batch (50) per run, newest calls first; the rest catch up on the next tick.
  const setterStatements = [...pickedSetter.entries()]
    .sort((a, b) => (isoOrNull(b[1].startTime) ?? "").localeCompare(isoOrNull(a[1].startTime) ?? "")).slice(0, 50)
    .map(([contactId, e]) =>
      db.prepare(
        `UPDATE leads SET appointment_id = ?1, appointment_start = ?2, appointment_status = ?3, setter_host = COALESCE(?4, setter_host)
         WHERE id = COALESCE((SELECT MAX(id) FROM leads WHERE appointment_id = ?1), (SELECT MAX(id) FROM leads WHERE ghl_contact_id = ?5))
           AND (appointment_id IS NOT ?1 OR appointment_start IS NOT ?2 OR appointment_status IS NOT ?3 OR (?4 IS NOT NULL AND setter_host IS NOT ?4))`,
      ).bind(e.id, isoOrNull(e.startTime), e.appointmentStatus ?? null, hosts?.get(e.assignedUserId ?? "") ?? null, contactId));
  // "Showed" sticks (a follow-up call does not undo the first one). Otherwise a different appointment, or the
  // same one moved to another time, starts with unknown attendance again. The newest lead row per contact only.
  const keep = "((closer_appointment_id IS ?1 AND closer_start IS ?2) OR closer_attended = 'showed')";
  const statements = [...picked.entries()].map(([contactId, e]) =>
    db.prepare(
      `UPDATE leads SET closer_attended = CASE WHEN ${keep} THEN closer_attended ELSE NULL END,
         closer_attended_source = CASE WHEN ${keep} THEN closer_attended_source ELSE NULL END,
         closer_minutes = CASE WHEN ${keep} THEN closer_minutes ELSE NULL END,
         closer_checked_at = CASE WHEN ${keep} THEN closer_checked_at ELSE NULL END,
         closer_appointment_id = ?1, closer_start = ?2, closer_status = ?3, closer_meet_code = ?4, closer_host = COALESCE(?6, closer_host)
       WHERE id = (SELECT MAX(id) FROM leads WHERE ghl_contact_id = ?5)
         AND (closer_appointment_id IS NOT ?1 OR closer_start IS NOT ?2 OR closer_status IS NOT ?3 OR closer_meet_code IS NOT ?4 OR (?6 IS NOT NULL AND closer_host IS NOT ?6))`,
    ).bind(e.id, isoOrNull(e.startTime), e.appointmentStatus ?? null, meetCode(e.address), contactId, hosts?.get(e.assignedUserId ?? "") ?? null));
  // Separate batches: a D1 batch is atomic, and the setter columns only exist from migration 0009 on.
  const updated = await runBatches(db, statements);
  let setterUpdated = 0;
  try { setterUpdated = await runBatches(db, setterStatements); } catch (err) { console.error("[sync] setter appointment refresh failed (migration 0009 applied?):", errorText(err)); }
  return { events: events.length + setterEvents.length, updated: updated + setterUpdated };
}

type GhlUser = { id: string; email?: string | null; name?: string | null; firstName?: string | null; lastName?: string | null };

/**
 * GHL user id → lower-cased email for the ids given (needs the `users.readonly` scope on the PIT). Skipped (no request)
 * when no event names a host. On failure returns null and the stored hosts are left untouched (COALESCE in the write).
 */
async function hostEmails(db: D1Database, cfg: GhlConfig, userIds: string[]): Promise<Map<string, string> | null> {
  const out = new Map<string, string>();
  if (!userIds.some(Boolean)) return out;
  try {
    const data = await ghl<{ users?: GhlUser[] }>(cfg, `/users/?locationId=${cfg.locationId}`);
    const names: Record<string, string> = {};
    for (const u of data.users ?? []) {
      if (!u.id || !u.email) continue;
      const email = u.email.trim().toLowerCase();
      out.set(u.id, email);
      const name = (u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`).trim();
      if (name) names[email] = name;
    }
    // Display names for the leaderboard / appointments pages (emails are the keys everywhere else).
    await db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('ghl_users', ?1, ${SQL_NOW}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(JSON.stringify(names)).run();
    return out;
  } catch (err) {
    console.error("[sync] GHL users lookup failed; closer hosts left as they were:", errorText(err));
    return null;
  }
}

/* ---------------- 3b. closer attendance (Google Meet, else Fathom) ---------------- */

export type Attendance = { attended: "showed" | "no_show"; minutes: number };

/** A Meet link can be reused: only a recording / conference that started around the appointment counts. */
const WINDOW_BEFORE_MS = 2 * 3_600_000, WINDOW_AFTER_MS = 6 * 3_600_000;
function nearAppointment(startedIso: string | null | undefined, appointmentIso: string): boolean {
  const started = Date.parse(startedIso ?? ""), appointment = Date.parse(appointmentIso);
  return Number.isFinite(started) && Number.isFinite(appointment) && started >= appointment - WINDOW_BEFORE_MS && started <= appointment + WINDOW_AFTER_MS;
}

type FathomMeeting = { meeting_url?: string | null; recording_start_time?: string | null; recording_end_time?: string | null };

/** Attendance of one closer call from Fathom: the longest recording of that Meet link around the appointment decides. */
export function fathomAttendance(meetings: FathomMeeting[], code: string, appointmentIso: string): Attendance | null {
  let best: Attendance | null = null;
  for (const m of meetings) {
    if (meetCode(m.meeting_url) !== code || !nearAppointment(m.recording_start_time, appointmentIso)) continue;
    const start = Date.parse(m.recording_start_time ?? ""), end = Date.parse(m.recording_end_time ?? "");
    if (!Number.isFinite(end) || end < start) continue;
    const minutes = Math.round((end - start) / 60_000);
    if (!best || minutes > best.minutes) best = { attended: minutes >= FATHOM_SHOW_MIN_MINUTES ? "showed" : "no_show", minutes };
  }
  return best;
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

type MeetParticipant = {
  earliestStartTime?: string; latestEndTime?: string;
  signedinUser?: { user?: string; displayName?: string }; anonymousUser?: { displayName?: string }; phoneUser?: { displayName?: string };
};

const NOTETAKER = /notetaker|fathom|otter|fireflies|read\.ai|recorder|\bbot\b/i;

/**
 * showed = at least two PEOPLE (note-taking bots ignored), the second-longest present for MEET_SHOW_MIN_MINUTES or more.
 * A participant entry is one person in one conference record; the same person across several records of the call
 * (the host reopening the room) is one person, so minutes are summed per person before ranking.
 */
export function meetAttendance(participants: MeetParticipant[], nowMs: number): Attendance {
  const perPerson = new Map<string, number>();
  participants.forEach((p, i) => {
    const name = p.signedinUser?.displayName ?? p.anonymousUser?.displayName ?? p.phoneUser?.displayName ?? "";
    if (NOTETAKER.test(name)) return;
    // Signed-in users carry a stable id; guests only a name. An entry with neither is counted as its own person.
    const key = p.signedinUser?.user ?? (name ? `${p.signedinUser ? "s" : p.anonymousUser ? "a" : "p"}:${name}` : `#${i}`);
    const start = Date.parse(p.earliestStartTime ?? ""), end = p.latestEndTime ? Date.parse(p.latestEndTime) : nowMs;
    const minutes = Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 60_000 : 0;
    perPerson.set(key, (perPerson.get(key) ?? 0) + minutes);
  });
  const ranked = [...perPerson.values()].sort((a, b) => b - a);
  const second = Math.round(ranked[1] ?? 0);
  return { attended: second >= MEET_SHOW_MIN_MINUTES ? "showed" : "no_show", minutes: second };
}

/**
 * Google Meet REST API v2 (conferenceRecords), read as the call's host through domain-wide delegation.
 * Verified 2026-11-09 against the roof Workspace: records of a Meet code are visible to the host only, so a host
 * outside the delegated domain (a @stonesystems.io account) yields "unauthorized_client" and that call stays stage-based.
 * Participants of the one conference on that Meet link that started around the appointment, or null if this host has none.
 */
async function meetParticipants(accessToken: string, code: string, appointmentIso: string): Promise<MeetParticipant[] | null> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  const appointment = Date.parse(appointmentIso);
  const from = new Date(appointment - WINDOW_BEFORE_MS).toISOString(), to = new Date(appointment + WINDOW_AFTER_MS).toISOString();
  const filter = encodeURIComponent(`space.meeting_code = "${code}" AND start_time>="${from}" AND start_time<="${to}"`);
  const res = await fetch(`https://meet.googleapis.com/v2/conferenceRecords?filter=${filter}&pageSize=10`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Meet conferenceRecords → ${res.status}`);
  const records = ((await res.json()) as { conferenceRecords?: Array<{ name: string; startTime?: string }> }).conferenceRecords ?? [];
  // A call often has several records (the host opens the room, drops, reopens): merge the participants of every record
  // around the appointment (seen live: a 3-minute false start before the real 56-minute call). At most 2 records.
  const near = records.filter((r) => nearAppointment(r.startTime, appointmentIso)).sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? "")).slice(0, 2);
  if (!near.length) return null;
  const all: MeetParticipant[] = [];
  for (const record of near) {
    const p = await fetch(`https://meet.googleapis.com/v2/${record.name}/participants?pageSize=50`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!p.ok) throw new Error(`Meet participants → ${p.status}`);
    all.push(...(((await p.json()) as { participants?: MeetParticipant[] }).participants ?? []));
  }
  return all;
}

type CloserDue = { id: number; closer_meet_code: string; closer_start: string; closer_host: string | null };

/** The Workspace account to read a host's Meet calls as: the alias from MEET_HOST_ALIASES when there is one, else the host itself. */
export function hostSubject(host: string, aliasesRaw: string | undefined): string {
  if (!aliasesRaw) return host;
  try {
    const map = JSON.parse(aliasesRaw) as Record<string, unknown>;
    for (const [from, to] of Object.entries(map)) {
      if (from.trim().toLowerCase() === host.trim().toLowerCase() && typeof to === "string" && to.includes("@")) return to.trim().toLowerCase();
    }
  } catch {
    console.error("[sync] MEET_HOST_ALIASES is not a JSON object of email → email; ignored");
  }
  return host;
}

export async function syncCloserAttendance(env: SyncEnv, nowMs: number, max: number): Promise<{ source: "google_meet" | "fathom" | "none"; checked: number; resolved: number }> {
  const sa = parseServiceAccount(env.GOOGLE_MEET_SERVICE_ACCOUNT);
  if (env.GOOGLE_MEET_SERVICE_ACCOUNT && !sa) console.error("[sync] GOOGLE_MEET_SERVICE_ACCOUNT is set but is not a service-account key file; Meet attendance is off");
  const source = sa ? "google_meet" : env.FATHOM_API_KEY ? "fathom" : "none";
  if (source === "none") return { source, checked: 0, resolved: 0 };

  // Closer calls that started at least 45 minutes ago, in the last 28 days (Meet keeps records 30), with attendance still unknown.
  // With Meet, only calls whose host is known: the host is who the conference is read as.
  const { results: due } = await env.DB.prepare(
    `SELECT id, closer_meet_code, closer_start, closer_host FROM leads
     WHERE closer_meet_code IS NOT NULL AND closer_attended IS NULL AND IFNULL(closer_status, '') <> 'cancelled'
       AND closer_start < strftime('%Y-%m-%dT%H:%M:%fZ','now','-45 minutes') AND closer_start > strftime('%Y-%m-%dT%H:%M:%fZ','now','-28 days')
       AND (closer_checked_at IS NULL OR closer_checked_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours'))
       AND (?2 = 0 OR closer_host IS NOT NULL)
     ORDER BY closer_start DESC LIMIT ?1`,
  ).bind(max, sa ? 1 : 0).all<CloserDue>();
  if (!due.length) return { source, checked: 0, resolved: 0 };

  const found = new Map<number, Attendance>();
  const roomNeverOpened = new Set<number>();
  if (sa) {
    // One token per distinct host. A host the delegation cannot act as (outside the Workspace) is logged and skipped,
    // but a conference is also listed for everyone who joined it, so the other hosts' tokens are tried next (seen live:
    // a call hosted from a @stonesystems.io account was readable as the closer who sat in on it).
    // Tokens are keyed by the Workspace account read as (the host, or its MEET_HOST_ALIASES alias).
    const tokens = new Map<string, string | null>();
    for (const subject of new Set(due.map((l) => hostSubject(l.closer_host!, env.MEET_HOST_ALIASES)))) {
      try { tokens.set(subject, await serviceAccountToken(sa, subject, MEET_SCOPE, fetch, nowMs)); } catch (err) { tokens.set(subject, null); console.error("[sync] Google token failed:", errorText(err).replace(subject, maskEmail(subject))); }
    }
    for (const lead of due) {
      const own = hostSubject(lead.closer_host!, env.MEET_HOST_ALIASES);
      const order = [own, ...[...tokens.keys()].filter((h) => h !== own)];
      for (const host of order) {
        const token = tokens.get(host);
        if (!token) continue;
        try {
          const participants = await meetParticipants(token, lead.closer_meet_code, lead.closer_start);
          if (participants) { found.set(lead.id, meetAttendance(participants, nowMs)); break; }
          // The host's own account answered and has no record of the room: nobody ever opened it.
          if (host === own) roomNeverOpened.add(lead.id);
        } catch (err) {
          console.error("[sync] Meet lookup failed for lead", lead.id, "as", maskEmail(host), errorText(err));
        }
      }
    }
  }
  // Fathom for whatever Meet could not answer (or for everything when there is no Google connection): a closer who
  // records with Fathom, or a host the delegation cannot act as, still gets a result. One page when Meet already
  // spent most of the subrequest budget (seen live: calls hosted from an outside-Workspace account stayed unresolved).
  const viaFathom = new Set<number>();
  if (env.FATHOM_API_KEY && found.size < due.length) {
    try {
      const meetings = await fathomMeetings(env.FATHOM_API_KEY, new Date(nowMs - 15 * 86_400_000).toISOString(), sa ? 1 : 3);
      for (const lead of due) {
        if (found.has(lead.id)) continue;
        const a = fathomAttendance(meetings, lead.closer_meet_code, lead.closer_start);
        if (a) { found.set(lead.id, a); viaFathom.add(lead.id); }
      }
    } catch (err) {
      console.error("[sync] Fathom lookup failed:", errorText(err));
    }
  }
  // Michael's ruling (2026-11-10): a confirmed call whose room was never opened, with no recording anywhere, is a
  // no-show. Only when the host's own account could be read (an unreadable host stays unknown, not a no-show).
  for (const id of roomNeverOpened) if (!found.has(id)) found.set(id, { attended: "no_show", minutes: 0 });
  const statements = due.map((lead) => {
    const a = found.get(lead.id);
    return a
      ? env.DB.prepare(`UPDATE leads SET closer_attended = ?1, closer_attended_source = ?2, closer_minutes = ?3, closer_checked_at = ${SQL_NOW} WHERE id = ?4`).bind(a.attended, viaFathom.has(lead.id) ? "fathom" : source, a.minutes, lead.id)
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
    // Budget per run (Workers free plan: 50 subrequests, D1 calls included).
    // D1 ≈ 12: pipeline ceil(contacts/50) (~3), closer batch 1, setter batch 1, ghl_users 1, setter calls 3, attendance 2, sync_status 1.
    // Fetch: pipeline <= 7, calendars <= 8 (list, <= 4 closer, <= 2 setter, users), call logs 2 per lead, attendance <= 3 with
    // Fathom or <= 15 with Google Meet (<= 2 tokens + per lead: 1 list + <= 2 participants, then fallback 1 list + <= 2,
    // then 1 Fathom page for what Meet left unresolved).
    // Meet on: 7 + 8 + 4 + 15 = 34 fetch + 12 D1 = 46.
    const meetOn = !!parseServiceAccount(env.GOOGLE_MEET_SERVICE_ACCOUNT);
    const callLogs = meetOn ? 2 : 12;
    try { summary.setterCalls = await syncSetterCalls(env.DB, cfg, callLogs); } catch (err) { summary.setterCalls = { error: errorText(err) }; }
  }
  try { summary.closerAttendance = await syncCloserAttendance(env, nowMs, 2); } catch (err) { summary.closerAttendance = { error: errorText(err) }; }
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
