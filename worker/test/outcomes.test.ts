import { test } from "node:test";
import assert from "node:assert/strict";
import { fathomAttendance, meetAttendance, meetCode, pickCloserEvents, summarizeCalls } from "../src/outcomes.ts";

test("summarizeCalls counts call records and keeps the longest completed one", () => {
  const r = summarizeCalls([
    { messageType: "TYPE_SMS", status: "delivered" },
    { messageType: "TYPE_CALL", status: "completed", meta: { call: { duration: 41 } } },
    { messageType: "TYPE_CALL", status: "completed", meta: { call: { duration: 364 } } },
    { messageType: "TYPE_CALL", status: "failed", meta: { call: { duration: 900 } } },
    { messageType: "TYPE_CALL", status: "completed", meta: { callDuration: 12 } },
    { messageType: "TYPE_CALL", status: "completed", meta: null },
  ]);
  assert.deepEqual(r, { calls: 5, longestSeconds: 364 });
  assert.deepEqual(summarizeCalls([]), { calls: 0, longestSeconds: 0 });
});

test("meetCode reads the code out of a Meet link", () => {
  assert.equal(meetCode("https://meet.google.com/abc-defg-hij"), "abc-defg-hij");
  assert.equal(meetCode("https://meet.google.com/ABC-defg-hij?authuser=0"), "abc-defg-hij");
  assert.equal(meetCode("+1 813 555 0142"), null);
  assert.equal(meetCode(null), null);
});

test("pickCloserEvents keeps one appointment per contact: live beats cancelled, then the newest", () => {
  const picked = pickCloserEvents([
    { id: "old", contactId: "c1", appointmentStatus: "confirmed", startTime: "2026-11-01T10:00:00-05:00" },
    { id: "new", contactId: "c1", appointmentStatus: "confirmed", startTime: "2026-11-05T10:00:00-05:00" },
    { id: "cancelled-later", contactId: "c1", appointmentStatus: "cancelled", startTime: "2026-11-08T10:00:00-05:00" },
    { id: "only-cancelled", contactId: "c2", appointmentStatus: "cancelled", startTime: "2026-11-02T10:00:00-05:00" },
    { id: "no-contact", appointmentStatus: "confirmed", startTime: "2026-11-02T10:00:00-05:00" },
    { id: "bad-time", contactId: "c3", appointmentStatus: "confirmed", startTime: "soon" },
  ]);
  assert.deepEqual([...picked.entries()].map(([c, e]) => [c, e.id]), [["c1", "new"], ["c2", "only-cancelled"]]);
});

test("fathomAttendance: a long recording of the meeting is a show, a short one a no-show, the longest decides", () => {
  const m = fathomAttendance([
    { meeting_url: "https://meet.google.com/aaa-bbbb-ccc", recording_start_time: "2026-11-01T15:00:00Z", recording_end_time: "2026-11-01T15:04:00Z" },
    { meeting_url: "https://meet.google.com/aaa-bbbb-ccc", recording_start_time: "2026-11-01T15:10:00Z", recording_end_time: "2026-11-01T15:52:00Z" },
    { meeting_url: "https://meet.google.com/ddd-eeee-fff", recording_start_time: "2026-11-01T15:00:00Z", recording_end_time: "2026-11-01T15:06:00Z" },
    { meeting_url: "https://zoom.us/j/123", recording_start_time: "2026-11-01T15:00:00Z", recording_end_time: "2026-11-01T16:00:00Z" },
    { meeting_url: "https://meet.google.com/ggg-hhhh-iii", recording_start_time: null, recording_end_time: null },
  ]);
  assert.deepEqual([...m.entries()], [
    ["aaa-bbbb-ccc", { attended: "showed", minutes: 42 }],
    ["ddd-eeee-fff", { attended: "no_show", minutes: 6 }],
  ]);
});

test("meetAttendance: showed needs a second participant present for five minutes", () => {
  const now = Date.parse("2026-11-01T16:00:00Z");
  assert.deepEqual(meetAttendance([
    { earliestStartTime: "2026-11-01T15:00:00Z", latestEndTime: "2026-11-01T15:45:00Z" },
    { earliestStartTime: "2026-11-01T15:02:00Z", latestEndTime: "2026-11-01T15:44:00Z" },
  ], now), { attended: "showed", minutes: 42 });
  assert.deepEqual(meetAttendance([{ earliestStartTime: "2026-11-01T15:00:00Z", latestEndTime: "2026-11-01T15:12:00Z" }], now), { attended: "no_show", minutes: 0 });
  assert.deepEqual(meetAttendance([
    { earliestStartTime: "2026-11-01T15:00:00Z", latestEndTime: "2026-11-01T15:12:00Z" },
    { earliestStartTime: "2026-11-01T15:01:00Z", latestEndTime: "2026-11-01T15:03:00Z" },
  ], now), { attended: "no_show", minutes: 2 });
  assert.deepEqual(meetAttendance([], now), { attended: "no_show", minutes: 0 });
});
