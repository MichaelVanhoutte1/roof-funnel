import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAppointments, buildLeaderboard, UNASSIGNED, type SalesLead } from "../src/sales.ts";

const NOW = "2026-11-10T00:00:00.000Z";
const FROM = "2026-11-01T00:00:00.000Z", TO = "2026-12-01T00:00:00.000Z";
let nextId = 1;
const lead = (over: Partial<SalesLead> = {}): SalesLead => ({
  id: nextId++, name: "Lead", city: "Austin", status: "full", route: "calendar", dq_reason: null, timeline: "Right away",
  business_owner: "I own a business", capital: "Yes, I will use financing.", tracking: null, appointment_id: null, appointment_start: null,
  appointment_status: null, setter_host: "ernest@roof.test", pipeline_stage: null, pipeline_stage_at: null, opportunity_status: null,
  opportunity_value: null, setter_calls: null, setter_call_seconds: null, closer_appointment_id: null, closer_start: null, closer_status: null,
  closer_host: null, closer_attended: null, closer_attended_source: null, closer_minutes: null, credit_status: null, credit_score: null,
  credit_offer_amount_1: null, credit_offer_amount_2: null, ...over,
});
const CALVIN = "calvin@roof.test";

test("one row per appointment, placed by its own start, newest first, outside the range dropped", () => {
  const rows = buildAppointments([
    lead({ appointment_id: "s1", appointment_start: "2026-11-03T15:00:00.000Z", setter_calls: 1, setter_call_seconds: 400, closer_appointment_id: "c1", closer_start: "2026-11-05T17:00:00.000Z", closer_host: CALVIN, closer_attended: "showed", closer_attended_source: "google_meet", closer_minutes: 48, pipeline_stage: "Closer Booked" }),
    lead({ appointment_id: "s2", appointment_start: "2026-10-20T15:00:00.000Z", closer_appointment_id: "c2", closer_start: "2026-11-02T17:00:00.000Z", closer_host: CALVIN, pipeline_stage: "Closer Booked Noshow" }),
    lead({ appointment_id: "s3", appointment_start: "2026-10-01T15:00:00.000Z" }),
  ], FROM, TO, NOW);
  assert.deepEqual(rows.map((r) => [r.kind, r.start.slice(0, 10), r.status, r.evidence.kind, r.evidence.minutes]), [
    ["closer", "2026-11-05", "showed", "meet", 48],
    ["setter", "2026-11-03", "showed", "call", 7],
    ["closer", "2026-11-02", "no_show", "none", null],
  ]);
});

test("hand-set status and close show on the row as manual, with the hand-set amount and day", () => {
  const rows = buildAppointments([
    lead({ closer_appointment_id: "c", closer_start: "2026-11-04T15:00:00.000Z", closer_host: CALVIN, closer_status: "cancelled", closer_attended_manual: "showed", pipeline_stage: "Closer Booked", won_manual: 1, cash_manual: 25500, close_date_manual: "2026-11-06" }),
    lead({ closer_appointment_id: "c", closer_start: "2026-11-03T15:00:00.000Z", closer_host: CALVIN, closer_status: "confirmed", pipeline_stage: "Won", pipeline_stage_at: "2026-11-03T16:00:00.000Z", opportunity_value: 30000, won_manual: 0 }),
    lead({ appointment_id: "s", appointment_start: "2026-11-02T15:00:00.000Z", setter_call_seconds: 600, setter_attended_manual: "no_show" }),
  ], FROM, TO, NOW);
  assert.deepEqual(rows.map((r) => [r.status, r.evidence.kind, r.closed, r.cash, r.close_date, r.manual]), [
    ["showed", "manual", true, 25500, "2026-11-06", { status: true, close: true }],
    ["showed", "stage", false, 0, null, { status: false, close: true }],
    ["no_show", "none", false, 0, null, { status: true, close: false }],
  ]);
  const lb = buildLeaderboard(rows);
  assert.deepEqual([lb.totals.deals, lb.totals.cash, lb.closers[0].closed], [1, 25500, 1]);
});

test("status vocabulary: cancelled, confirmed (future), pending (past, unknown), closed carries cash and date", () => {
  const rows = buildAppointments([
    lead({ appointment_id: "s", appointment_start: "2026-11-03T15:00:00.000Z", appointment_status: "cancelled" }),
    lead({ appointment_id: "s", appointment_start: "2026-11-20T15:00:00.000Z", appointment_status: "confirmed" }),
    lead({ appointment_id: "s", appointment_start: "2026-11-03T15:00:00.000Z", appointment_status: "confirmed" }),
    lead({ closer_appointment_id: "c", closer_start: "2026-11-04T15:00:00.000Z", closer_host: CALVIN, closer_status: "confirmed", pipeline_stage: "Won", pipeline_stage_at: "2026-11-04T16:30:00.000Z", opportunity_value: 20500, credit_status: "success", credit_score: 712 }),
  ], FROM, TO, NOW);
  assert.deepEqual(rows.map((r) => r.status), ["confirmed", "showed", "cancelled", "pending"]);
  const won = rows[1];
  assert.deepEqual([won.closed, won.cash, won.close_date, won.credit_score, won.evidence.kind], [true, 20500, "2026-11-04T16:30:00.000Z", 712, "stage"]);
});

test("leaderboard: per rep counts, close attributed to the rep who held the call, unassigned bucket, totals", () => {
  const rows = buildAppointments([
    lead({ appointment_id: "s", appointment_start: "2026-11-03T15:00:00.000Z", setter_calls: 1, setter_call_seconds: 300, closer_appointment_id: "c", closer_start: "2026-11-04T15:00:00.000Z", closer_host: CALVIN, pipeline_stage: "Won", opportunity_value: 20500 }),
    lead({ appointment_id: "s", appointment_start: "2026-11-03T16:00:00.000Z", setter_calls: 1, setter_call_seconds: 300, closer_appointment_id: "c", closer_start: "2026-11-04T16:00:00.000Z", closer_host: CALVIN, pipeline_stage: "Closer Booked Noshow" }),
    lead({ appointment_id: "s", appointment_start: "2026-11-03T17:00:00.000Z", setter_calls: 2, setter_call_seconds: 20, pipeline_stage: "Setter Noshow" }),
    lead({ appointment_id: "s", appointment_start: "2026-11-03T18:00:00.000Z", setter_host: null, appointment_status: "cancelled" }),
    lead({ closer_appointment_id: "c", closer_start: "2026-11-06T16:00:00.000Z", closer_host: "mike@roof.test", closer_attended: "showed", closer_attended_source: "fathom", closer_minutes: 30, pipeline_stage: "Closer Followup" }),
  ], FROM, TO, NOW);
  const lb = buildLeaderboard(rows);
  assert.deepEqual(lb.closers, [
    { rep: CALVIN, booked: 2, showed: 1, closed: 1, cash: 20500 },
    { rep: "mike@roof.test", booked: 1, showed: 1, closed: 0, cash: 0 },
  ]);
  assert.deepEqual(lb.setters, [
    { rep: "ernest@roof.test", booked: 3, showed: 2, closed: 1, cash: 20500 },
    { rep: UNASSIGNED, booked: 1, showed: 0, closed: 0, cash: 0 },
  ]);
  assert.deepEqual(lb.totals, { cash: 20500, deals: 1, closerShowed: 2, closerBooked: 3, setterBooked: 4, setterShowed: 2 });
});
