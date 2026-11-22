import test from "node:test";
import assert from "node:assert/strict";
import { aggregateJson, linkLeadViewer, linkPendingWatches, parseWatchPost, recordWatch, refreshLeadAggregate, resolveLead, WATCH_MAX_VIDEOS } from "../src/video-watch.ts";
import { cspRow } from "../src/csp-push-columns.ts";
import { insertLead, plain, realDb } from "./csp-push-helpers.ts";

const CORTANA = "cortana:21b86bdd-8912-4522-825d-920c79c0f6ef";
const VID = "0f8e5a2c-1b3d-4e6f-8a9b-0c1d2e3f4a5b";
const VID2 = "11111111-2222-4333-8444-555555555555";
const AK = "ak_tid_abcdef123456";
const NOW = new Date("2026-11-22T12:00:00.000Z");
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

function post(extra: Record<string, unknown> = {}, videos: unknown[] = [{ key: CORTANA, duration: 523.2, max_pct: 40, watched_seconds: 200 }]) {
  const p = parseWatchPost({ srr_vid: VID, page: "/info/", videos, ...extra });
  assert.ok(p, "post parses");
  return p;
}

const rows = (db: ReturnType<typeof realDb>["db"]) =>
  db.prepare("SELECT * FROM video_watches ORDER BY viewer_key, video_key").all().map(plain);
const leadWatches = (db: ReturnType<typeof realDb>["db"], id: number) => {
  const r = plain(db.prepare("SELECT video_watches FROM leads WHERE id = ?").get(id));
  return r.video_watches == null ? null : JSON.parse(String(r.video_watches));
};

/* ---------------- validation ---------------- */

test("a post needs an object, a viewer id and a videos array within the cap", () => {
  assert.equal(parseWatchPost(null), null);
  assert.equal(parseWatchPost("x"), null);
  assert.equal(parseWatchPost([]), null);
  assert.equal(parseWatchPost({ videos: [] }), null, "no viewer id");
  assert.equal(parseWatchPost({ srr_vid: "not-a-uuid", ak_tid: "x", videos: [] }), null, "malformed ids count as none");
  assert.equal(parseWatchPost({ srr_vid: VID }), null, "videos missing");
  assert.equal(parseWatchPost({ srr_vid: VID, videos: {} }), null);
  const many = Array.from({ length: WATCH_MAX_VIDEOS + 1 }, (_, i) => ({ key: `wistia:media${String(i).padStart(3, "0")}`, duration: 60, max_pct: 1, watched_seconds: 1 }));
  assert.equal(parseWatchPost({ srr_vid: VID, videos: many }), null, "over the cap");
  assert.equal(parseWatchPost({ srr_vid: VID, videos: many.slice(0, WATCH_MAX_VIDEOS) })?.videos.length, WATCH_MAX_VIDEOS);
});

test("video entries: unknown key formats and unusable durations are dropped, numbers clamped, repeats keep the max", () => {
  const p = parseWatchPost({
    srr_vid: VID.toUpperCase(),
    videos: [
      { key: CORTANA, duration: 523.2, max_pct: 140, watched_seconds: 9999 },
      { key: "wistia:boadevlk4n", duration: 66.43, max_pct: -5, watched_seconds: -1 },
      { key: "wistia:boadevlk4n", duration: 66.43, max_pct: 30, watched_seconds: 20 },
      { key: "vidalytics:7onzlIo0E3caUFx4", duration: 107, max_pct: "50", watched_seconds: null },
      { key: "youtube:abc", duration: 10, max_pct: 1, watched_seconds: 1 },
      { key: "wistia:BAD KEY", duration: 10 },
      { key: "cortana:not-a-uuid", duration: 10 },
      { key: "wistia:dnia1boi8a", duration: 0, max_pct: 10, watched_seconds: 1 },
      { key: "wistia:9opihsdyc5", duration: Number.NaN },
      "junk",
      null,
    ],
  });
  assert.ok(p);
  assert.equal(p.viewerKey, `vid:${VID}`, "uuid lower-cased");
  assert.deepEqual(p.videos, [
    { key: CORTANA, duration: 523.2, maxPct: 100, watchedSeconds: 523.2 },
    { key: "wistia:boadevlk4n", duration: 66.43, maxPct: 30, watchedSeconds: 20 },
    { key: "vidalytics:7onzlIo0E3caUFx4", duration: 107, maxPct: 0, watchedSeconds: 0 },
  ]);
});

test("identity: ak_tid wins the viewer key; phone normalised, bad email / cid / page dropped", () => {
  const p = parseWatchPost({ ak_tid: AK, srr_vid: VID, cid: "AbCdEf0123456789wxyz", email: " Jo@Example.com ", phone: "(312) 555-0101", page: "/thankyou-page/", videos: [] });
  assert.ok(p);
  assert.equal(p.viewerKey, `ak:${AK}`);
  assert.equal(p.akTid, AK);
  assert.equal(p.srrVid, VID);
  assert.equal(p.cid, "AbCdEf0123456789wxyz");
  assert.equal(p.email, "Jo@Example.com");
  assert.equal(p.phone, "+13125550101");
  assert.equal(p.page, "/thankyou-page/");
  const bad = parseWatchPost({ srr_vid: VID, cid: "<script>", email: "nope", phone: "123", page: "https://evil.example/", ak_tid: "short", videos: [] });
  assert.ok(bad);
  assert.deepEqual([bad.viewerKey, bad.akTid, bad.cid, bad.email, bad.phone, bad.page], [`vid:${VID}`, null, null, null, null, null]);
});

/* ---------------- merge ---------------- */

test("merges are monotonic: a later, lower post never lowers max_pct or watched_seconds; first_at stays, last_at moves", async () => {
  const { db, d1 } = realDb();
  await recordWatch(d1, post({}, [{ key: CORTANA, duration: 523.2, max_pct: 40, watched_seconds: 200 }]), NOW);
  await recordWatch(d1, post({}, [{ key: CORTANA, duration: 523.2, max_pct: 10, watched_seconds: 50 }]), later(1));
  await recordWatch(d1, post({}, [{ key: CORTANA, duration: 523.2, max_pct: 55, watched_seconds: 180 }]), later(2));
  const [r] = rows(db);
  assert.equal(rows(db).length, 1);
  assert.equal(r.viewer_key, `vid:${VID}`);
  assert.equal(r.max_pct, 55);
  assert.equal(r.watched_seconds, 200);
  assert.equal(r.first_at, NOW.toISOString());
  assert.equal(r.last_at, later(2).toISOString());
  assert.equal(r.lead_id, null);
  assert.equal(r.page, "/info/");
});

test("the viewer key changing (the Cortana cookie arrives later) keeps both ids on every row of that viewer", async () => {
  const { db, d1 } = realDb();
  await recordWatch(d1, post({}, [{ key: CORTANA, duration: 523.2, max_pct: 10, watched_seconds: 50 }]), NOW);
  await recordWatch(d1, post({ ak_tid: AK }, [{ key: "wistia:boadevlk4n", duration: 66.4, max_pct: 100, watched_seconds: 66 }]), later(1));
  const all = rows(db);
  assert.deepEqual(all.map((r) => [r.viewer_key, r.video_key, r.ak_tid, r.srr_vid]), [
    [`ak:${AK}`, "wistia:boadevlk4n", AK, VID],
    [`vid:${VID}`, CORTANA, AK, VID],
  ]);
});

/* ---------------- resolution ---------------- */

test("resolution order: GHL contact id, then phone (or the superseded phone), then email in any case", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1, { ghl_contact_id: "ghlContact0000000001", email: "one@example.com" }); // id 1, phone +13125550001
  insertLead(db, 2, { email: "Two@Example.com", superseded_phone: "+13125559999" }); // id 2
  insertLead(db, 3, { email: "three@example.com" }); // id 3
  const p = (extra: Record<string, unknown>) => parseWatchPost({ srr_vid: VID, videos: [], ...extra })!;
  assert.equal(await resolveLead(d1, p({ cid: "ghlContact0000000001", phone: "+13125550002", email: "three@example.com" })), 1);
  assert.equal(await resolveLead(d1, p({ cid: "ghlContactUnknown001", phone: "+13125550002", email: "three@example.com" })), 2);
  assert.equal(await resolveLead(d1, p({ phone: "312-555-9999" })), 2, "superseded phone");
  assert.equal(await resolveLead(d1, p({ phone: "+13125550404", email: "TWO@example.COM" })), 2, "email, any case");
  assert.equal(await resolveLead(d1, p({ email: "nobody@example.com" })), null);
});

test("resolution falls back to the viewer's earlier linked rows, then to a recent lead's tracking (first visit only)", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1, { tracking: JSON.stringify({ ak_tid: AK, utm_source: "facebook" }), created_at: NOW.toISOString() });
  // A first-time viewer whose ak_tid the survey stored → that lead.
  const first = parseWatchPost({ ak_tid: AK, srr_vid: VID, videos: [] })!;
  assert.equal(await resolveLead(d1, first, NOW), 1);
  // A lead created long ago is not scanned for.
  insertLead(db, 2, { tracking: JSON.stringify({ srr_vid: VID2 }), created_at: "2025-01-01T00:00:00.000Z" });
  assert.equal(await resolveLead(d1, parseWatchPost({ srr_vid: VID2, videos: [] })!, NOW), null);
  // Once linked, the same viewer resolves through its rows even without identity in the post.
  await recordWatch(d1, post({ phone: "+13125550001" }), NOW);
  assert.equal(await resolveLead(d1, parseWatchPost({ srr_vid: VID, videos: [] })!, NOW), 1);
});

test("a recorded post links the row, every earlier row of that viewer, and writes the lead aggregate", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1); // phone +13125550001
  await recordWatch(d1, post({}, [{ key: "vidalytics:7onzlIo0E3caUFx4", duration: 107, max_pct: 80, watched_seconds: 85 }]), NOW);
  assert.equal(rows(db)[0].lead_id, null);
  // The survey's thank-you redirect carries the phone.
  const touched = await recordWatch(d1, post({ phone: "+13125550001" }), later(5));
  assert.deepEqual(touched, [1]);
  assert.deepEqual(rows(db).map((r) => r.lead_id), [1, 1]);
  assert.deepEqual(leadWatches(db, 1), {
    [CORTANA]: { pct: 40, sec: 200, dur: 523.2, first: later(5).toISOString(), last: later(5).toISOString() },
    "vidalytics:7onzlIo0E3caUFx4": { pct: 80, sec: 85, dur: 107, first: NOW.toISOString(), last: NOW.toISOString() },
  });
});

test("a row's first link wins: a later post resolving to another lead does not move it", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1);
  insertLead(db, 2);
  await recordWatch(d1, post({ phone: "+13125550001" }), NOW);
  await recordWatch(d1, post({ phone: "+13125550002" }), later(1));
  assert.equal(rows(db)[0].lead_id, 1);
  assert.equal(leadWatches(db, 2), null);
});

/* ---------------- later linking ---------------- */

test("a lead saved with tracking.ak_tid / srr_vid picks up that viewer's earlier watches (the VSL before opting in)", async () => {
  const { db, d1 } = realDb();
  await recordWatch(d1, post({ ak_tid: AK }, [{ key: "vidalytics:7onzlIo0E3caUFx4", duration: 107, max_pct: 100, watched_seconds: 107 }]), NOW);
  await recordWatch(d1, parseWatchPost({ srr_vid: VID2, videos: [{ key: CORTANA, duration: 523.2, max_pct: 5, watched_seconds: 5 }] })!, NOW);
  insertLead(db, 1);
  assert.equal(await linkLeadViewer(d1, 1, { ak_tid: AK, srr_vid: VID, utm_source: "facebook" }), true);
  assert.deepEqual(rows(db).map((r) => [r.viewer_key, r.lead_id]), [[`ak:${AK}`, 1], [`vid:${VID2}`, null]]);
  assert.equal(leadWatches(db, 1)["vidalytics:7onzlIo0E3caUFx4"].pct, 100);
  assert.equal(await linkLeadViewer(d1, 1, { ak_tid: AK }), false, "nothing left to link");
  assert.equal(await linkLeadViewer(d1, 1, undefined), false);
  assert.equal(await linkLeadViewer(d1, 1, { ak_tid: "bad id!" }), false, "malformed ids never match");
});

test("the cron pass links recent rows by GHL contact id and by a recent lead's tracking, and skips old rows", async () => {
  const { db, d1 } = realDb();
  // A GHL text click (?cid=) before the lead row has its contact id.
  await recordWatch(d1, post({ cid: "ghlContact0000000001" }), NOW);
  // A viewer known only by srr_vid, whose lead row arrives later with that id in its tracking.
  await recordWatch(d1, parseWatchPost({ srr_vid: VID2, videos: [{ key: "wistia:boadevlk4n", duration: 66.4, max_pct: 50, watched_seconds: 33 }] })!, NOW);
  // An old unlinked row outside the window: its contact id is not looked up again.
  await recordWatch(d1, parseWatchPost({ ak_tid: AK, cid: "ghlContact0000000003", videos: [{ key: CORTANA, duration: 523.2, max_pct: 9, watched_seconds: 9 }] })!, new Date("2026-10-01T00:00:00.000Z"));
  assert.deepEqual(await linkPendingWatches(d1, later(1)), { linked: 0, leads: 0 });
  insertLead(db, 1, { ghl_contact_id: "ghlContact0000000001" });
  insertLead(db, 2, { tracking: JSON.stringify({ srr_vid: VID2 }), created_at: later(2).toISOString() });
  insertLead(db, 3, { tracking: "not json", ghl_contact_id: "ghlContact0000000003", created_at: later(2).toISOString() });
  assert.deepEqual(await linkPendingWatches(d1, later(3)), { linked: 2, leads: 2 });
  const byViewer = Object.fromEntries(rows(db).map((r) => [r.viewer_key, r.lead_id]));
  assert.deepEqual(byViewer, { [`vid:${VID}`]: 1, [`vid:${VID2}`]: 2, [`ak:${AK}`]: null });
  assert.equal(leadWatches(db, 1)[CORTANA].pct, 40);
  assert.equal(leadWatches(db, 2)["wistia:boadevlk4n"].sec, 33);
});

/* ---------------- aggregate ---------------- */

test("the aggregate merges every viewer key of a lead: max pct / sec / dur, min first, max last", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1);
  await recordWatch(d1, post({ phone: "+13125550001" }, [{ key: CORTANA, duration: 523.2, max_pct: 30, watched_seconds: 250 }]), NOW); // phone
  await recordWatch(d1, parseWatchPost({ ak_tid: AK, phone: "+13125550001", videos: [{ key: CORTANA, duration: 523.2, max_pct: 90.04, watched_seconds: 100.6 }] })!, later(10)); // laptop
  assert.deepEqual(leadWatches(db, 1), { [CORTANA]: { pct: 90, sec: 250, dur: 523.2, first: NOW.toISOString(), last: later(10).toISOString() } });
});

test("the aggregate is rewritten only when it changes, so the lead is re-pushed to the CSP exactly then; it ships as an object", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1);
  const stamp = () => String(plain(db.prepare("SELECT csp_changed_at FROM leads WHERE id = 1").get()).csp_changed_at);
  await recordWatch(d1, post({ phone: "+13125550001" }), NOW);
  const before = stamp();
  assert.equal(await refreshLeadAggregate(d1, 1), false, "same data → no write → no re-push");
  assert.equal(stamp(), before);
  await recordWatch(d1, post({}, [{ key: CORTANA, duration: 523.2, max_pct: 60, watched_seconds: 300 }]), later(1));
  assert.ok(stamp() > before, "new watch data moves csp_changed_at");
  const row = cspRow("lead", plain(db.prepare("SELECT * FROM leads WHERE id = 1").get()));
  assert.deepEqual(row.video_watches, { [CORTANA]: { pct: 60, sec: 300, dur: 523.2, first: NOW.toISOString(), last: later(1).toISOString() } });
  assert.equal(cspRow("lead", { id: 2, video_watches: null }).video_watches, null);
  assert.equal(cspRow("lead", { id: 2, video_watches: "garbage" }).video_watches, null);
  assert.equal(aggregateJson([]), null);
});

/* ---------------- Cortana history import ---------------- */

/** The INSERT shape the one-off import file uses (documented in the PR); rerunnable, monotonic like the live path. */
function importRow(db: ReturnType<typeof realDb>["db"], r: { contact: string; ghl: string; video: string; dur: number; pct: number; sec: number; first: string; last: string }) {
  db.prepare(
    `INSERT INTO video_watches (viewer_key, video_key, lead_id, cid, duration, max_pct, watched_seconds, first_at, last_at, page, aggregate_pending)
     VALUES ('cortana:' || ?1, ?2, (SELECT id FROM leads WHERE ghl_contact_id = ?3 ORDER BY id DESC LIMIT 1), ?3, ?4, ?5, ?6, ?7, ?8, 'import:cortana', 1)
     ON CONFLICT (viewer_key, video_key) DO UPDATE SET
       lead_id = COALESCE(video_watches.lead_id, excluded.lead_id), cid = COALESCE(excluded.cid, video_watches.cid),
       duration = excluded.duration, max_pct = MAX(video_watches.max_pct, excluded.max_pct),
       watched_seconds = MAX(video_watches.watched_seconds, excluded.watched_seconds),
       first_at = MIN(video_watches.first_at, excluded.first_at), last_at = MAX(video_watches.last_at, excluded.last_at),
       aggregate_pending = 1`,
  ).run(r.contact, r.video, r.ghl, r.dur, r.pct, r.sec, r.first, r.last);
}

test("imported Cortana history: the cron rebuilds the lead aggregate (merged with live rows), links old rows by GHL id, clears the flag", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1, { ghl_contact_id: "ghlContact0000000001" });
  // Live tracking already wrote an aggregate for lead 1.
  await recordWatch(d1, post({ cid: "ghlContact0000000001" }, [{ key: CORTANA, duration: 523.2, max_pct: 30, watched_seconds: 150 }]), NOW);
  const VSL = "cortana:03fa2c72-b560-4e7f-ace8-3a1a9ed960b0";
  importRow(db, { contact: "cortanaContactA", ghl: "ghlContact0000000001", video: CORTANA, dur: 523.2, pct: 95, sec: 480, first: "2026-11-10T10:00:00.000Z", last: "2026-11-11T10:00:00.000Z" });
  importRow(db, { contact: "cortanaContactA", ghl: "ghlContact0000000001", video: VSL, dur: 107, pct: 100, sec: 107, first: "2026-11-09T10:00:00.000Z", last: "2026-11-09T10:05:00.000Z" });
  // Re-running the file changes nothing it should not.
  importRow(db, { contact: "cortanaContactA", ghl: "ghlContact0000000001", video: VSL, dur: 107, pct: 50, sec: 20, first: "2026-11-09T10:00:00.000Z", last: "2026-11-09T10:05:00.000Z" });
  // A contact whose lead row arrives after the import (old last_at, outside the recent window), and many contacts with
  // no lead at all, which must not crowd it out.
  importRow(db, { contact: "cortanaContactB", ghl: "ghlContact0000000002", video: CORTANA, dur: 523.2, pct: 12, sec: 60, first: "2026-09-01T10:00:00.000Z", last: "2026-09-01T10:10:00.000Z" });
  for (let i = 0; i < 120; i++) importRow(db, { contact: `nolead${i}`, ghl: `ghlNoLead${String(i).padStart(11, "0")}`, video: CORTANA, dur: 523.2, pct: 5, sec: 5, first: "2026-11-01T00:00:00.000Z", last: "2026-11-01T00:00:00.000Z" });
  insertLead(db, 2, { ghl_contact_id: "ghlContact0000000002" });

  assert.equal(leadWatches(db, 1)[VSL], undefined, "not visible before the cron");
  await linkPendingWatches(d1, later(10));
  assert.deepEqual(leadWatches(db, 1), {
    [CORTANA]: { pct: 95, sec: 480, dur: 523.2, first: "2026-11-10T10:00:00.000Z", last: NOW.toISOString() },
    [VSL]: { pct: 100, sec: 107, dur: 107, first: "2026-11-09T10:00:00.000Z", last: "2026-11-09T10:05:00.000Z" },
  });
  assert.deepEqual(leadWatches(db, 2), { [CORTANA]: { pct: 12, sec: 60, dur: 523.2, first: "2026-09-01T10:00:00.000Z", last: "2026-09-01T10:10:00.000Z" } });
  const flags = plain(db.prepare("SELECT SUM(aggregate_pending = 1 AND lead_id IS NOT NULL) AS linked_pending, SUM(aggregate_pending = 1 AND lead_id IS NULL) AS unlinked_pending FROM video_watches").get());
  assert.deepEqual(flags, { linked_pending: 0, unlinked_pending: 120 }, "flags cleared once rebuilt; contacts without a lead stay flagged");
  const stamp = String(plain(db.prepare("SELECT csp_changed_at FROM leads WHERE id = 1").get()).csp_changed_at);
  assert.deepEqual(await linkPendingWatches(d1, later(20)), { linked: 0, leads: 0 }, "nothing left to do");
  assert.equal(String(plain(db.prepare("SELECT csp_changed_at FROM leads WHERE id = 1").get()).csp_changed_at), stamp);
});
