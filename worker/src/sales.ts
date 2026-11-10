/**
 * Sales Leaderboard and Appointments for the admin page, shaped like CSP's `/commission-tracker` and
 * `/sales-appointments`. Pure functions over lead rows so they are unit tested.
 *
 * Two appointments can hang off one lead: the SETTER call (booked by the funnel, refreshed from the Setter Calendar)
 * and the CLOSER call (booked by the setter on a closer calendar). Each becomes one row here, placed in the range by
 * its own start time. A close (Won) is attributed to the closer and setter who held that lead's calls.
 */
import { leadOutcome, type Outcome, type ReportLead } from "./report.ts";

export type SalesLead = ReportLead & {
  id: number;
  name: string | null;
  city: string | null;
  setter_host: string | null;
  closer_host: string | null;
  closer_attended_source: string | null;
  closer_minutes: number | null;
  pipeline_stage_at: string | null;
};

export type AppointmentRow = {
  kind: "setter" | "closer";
  lead_id: number;
  name: string | null;
  city: string | null;
  /** Rep email (GHL user) or null when GHL never told us. */
  closer: string | null;
  setter: string | null;
  start: string;
  /** GHL appointment status as stored (confirmed, cancelled, showed, noshow, ...). */
  ghl_status: string | null;
  /** What this page shows: showed / no_show / cancelled / confirmed / pending(unknown yet) */
  status: "showed" | "no_show" | "cancelled" | "confirmed" | "pending";
  closed: boolean;
  cash: number;
  close_date: string | null;
  credit_score: number | null;
  stage: string | null;
  /** How the show was established, for the "Recording / note" column. */
  evidence: { kind: "call" | "meet" | "fathom" | "stage" | "ghl" | "none"; minutes: number | null };
};

const CANCELLED = /^cancel/i;

function isUpcoming(startIso: string, nowIso: string): boolean {
  return startIso > nowIso;
}

function setterRow(l: SalesLead, o: Outcome, nowIso: string): AppointmentRow {
  const cancelled = CANCELLED.test(l.appointment_status ?? "");
  const seconds = l.setter_call_seconds ?? 0;
  const status: AppointmentRow["status"] = cancelled && !o.setterShowed ? "cancelled" : o.setterShowed ? "showed" : o.setterNoShow ? "no_show" : isUpcoming(l.appointment_start!, nowIso) ? "confirmed" : "pending";
  const evidence: AppointmentRow["evidence"] = !o.setterShowed
    ? { kind: "none", minutes: null }
    : seconds >= 120 ? { kind: "call", minutes: Math.round(seconds / 60) } : /^showed$/i.test(l.appointment_status ?? "") && !o.won ? { kind: "ghl", minutes: null } : { kind: "stage", minutes: null };
  return { kind: "setter", lead_id: l.id, name: l.name, city: l.city, closer: l.closer_host, setter: l.setter_host, start: l.appointment_start!, ghl_status: l.appointment_status, status, closed: o.won, cash: o.cash, close_date: o.won ? l.pipeline_stage_at : null, credit_score: l.credit_status === "success" ? l.credit_score : null, stage: l.pipeline_stage, evidence };
}

function closerRow(l: SalesLead, o: Outcome, nowIso: string): AppointmentRow {
  const cancelled = CANCELLED.test(l.closer_status ?? "");
  const status: AppointmentRow["status"] = cancelled && !o.closerShowed ? "cancelled" : o.closerShowed ? "showed" : o.closerNoShow ? "no_show" : isUpcoming(l.closer_start!, nowIso) ? "confirmed" : "pending";
  const src = l.closer_attended_source;
  const evidence: AppointmentRow["evidence"] = !o.closerShowed
    ? { kind: "none", minutes: null }
    : src === "google_meet" ? { kind: "meet", minutes: l.closer_minutes } : src === "fathom" ? { kind: "fathom", minutes: l.closer_minutes }
    : /^showed$/i.test(l.closer_status ?? "") && !o.won ? { kind: "ghl", minutes: null } : { kind: "stage", minutes: null };
  return { kind: "closer", lead_id: l.id, name: l.name, city: l.city, closer: l.closer_host, setter: l.setter_host, start: l.closer_start!, ghl_status: l.closer_status, status, closed: o.won, cash: o.cash, close_date: o.won ? l.pipeline_stage_at : null, credit_score: l.credit_status === "success" ? l.credit_score : null, stage: l.pipeline_stage, evidence };
}

/** One row per appointment whose start falls in [from, to), newest first. */
export function buildAppointments(leads: SalesLead[], fromIso: string, toIso: string, nowIso: string): AppointmentRow[] {
  const rows: AppointmentRow[] = [];
  for (const l of leads) {
    const o = leadOutcome(l, nowIso);
    if (l.appointment_id && l.appointment_start && l.appointment_start >= fromIso && l.appointment_start < toIso) rows.push(setterRow(l, o, nowIso));
    if (l.closer_appointment_id && l.closer_start && l.closer_start >= fromIso && l.closer_start < toIso) rows.push(closerRow(l, o, nowIso));
  }
  return rows.sort((a, b) => b.start.localeCompare(a.start) || a.lead_id - b.lead_id);
}

export type RepRow = { rep: string; booked: number; showed: number; closed: number; cash: number };

export type Leaderboard = {
  closers: RepRow[];
  setters: RepRow[];
  /** CSP's StatStrip: cash collected, deals, close rate (deals ÷ closer shows), AOV. */
  totals: { cash: number; deals: number; closerShowed: number; closerBooked: number; setterBooked: number; setterShowed: number };
};

export const UNASSIGNED = "(unassigned)";

/**
 * Per rep, from the appointment rows of the range. Closer: booked = closer calls (cancelled ones included, as in CSP),
 * showed = attended, closed = that lead won, cash = its value. Setter: the same over setter calls. A lead's close counts
 * once per table, on the rep who held that call. Closers sort by cash (the client re-ranks by the chosen score).
 */
export function buildLeaderboard(rows: AppointmentRow[]): Leaderboard {
  const closers = new Map<string, RepRow>(), setters = new Map<string, RepRow>();
  const bump = (m: Map<string, RepRow>, rep: string | null, r: AppointmentRow) => {
    const key = rep ?? UNASSIGNED;
    const row = m.get(key) ?? { rep: key, booked: 0, showed: 0, closed: 0, cash: 0 };
    row.booked++;
    if (r.status === "showed") row.showed++;
    if (r.closed) { row.closed++; row.cash += r.cash; }
    m.set(key, row);
  };
  for (const r of rows) (r.kind === "closer" ? bump(closers, r.closer, r) : bump(setters, r.setter, r));
  const byCash = (a: RepRow, b: RepRow) => b.cash - a.cash || b.closed - a.closed || b.showed - a.showed || a.rep.localeCompare(b.rep);
  const byActivity = (a: RepRow, b: RepRow) => (b.booked + b.showed + b.closed) - (a.booked + a.showed + a.closed) || a.rep.localeCompare(b.rep);
  const c = [...closers.values()].sort(byCash), s = [...setters.values()].sort(byActivity);
  const sum = (xs: RepRow[], k: keyof Omit<RepRow, "rep">) => xs.reduce((n, x) => n + x[k], 0);
  return {
    closers: c,
    setters: s,
    totals: { cash: sum(c, "cash"), deals: sum(c, "closed"), closerShowed: sum(c, "showed"), closerBooked: sum(c, "booked"), setterBooked: sum(s, "booked"), setterShowed: sum(s, "showed") },
  };
}
