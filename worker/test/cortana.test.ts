import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const plain = (o: unknown) => ({ ...(o as Record<string, unknown>) });
import {
  eventPayload, MAX_ATTEMPTS, MILESTONE_EVENTS, milestoneAt, milestonePayload, milestoneWhere, relayEvent, relayMilestones, sendMilestoneOnce, webhookMap,
  type MilestoneRow,
} from "../src/cortana.ts";

const HOOKS = JSON.stringify({
  setter_self_booked: "https://use.example.com/hook/self",
  setter_qualified: "https://use.example.com/hook/sq",
  setter_disqualified: "",
  closer_booked: "https://use.example.com/hook/cb",
  qualified: "http://insecure.example.com/x",
});

function row(over: Partial<MilestoneRow> = {}): MilestoneRow {
  return {
    id: 7, name: "Billy Hood", email: "billy@example.com", phone: "+13125550100", city: "Tampa", timeline: "asap", business_owner: "yes",
    capital: "cash", tracking: '{"utm_source":"facebook","session_id":"s-1","fbclid":"abc"}', country: "US",
    pipeline_stage: null, pipeline_stage_at: null, booked_at: null, appointment_start: null, closer_start: null, ...over,
  };
}

test("webhookMap keeps https URLs only; eventPayload puts the lead at the top level with split names, country and tracking", () => {
  assert.deepEqual(Object.keys(webhookMap(HOOKS)), ["setter_self_booked", "setter_qualified", "closer_booked"]);
  assert.deepEqual(webhookMap("not json"), {});
  const p = eventPayload("phone", { name: "Billy Ray Hood", email: "b@x.com" }, { utm_source: "facebook" }, "US");
  assert.equal(p.event, "phone");
  assert.equal(p.first_name, "Billy");
  assert.equal(p.last_name, "Ray Hood");
  assert.equal(p.ip_country, "US");
  assert.equal(p.utm_source, "facebook");
  assert.ok(typeof p.timestamp === "string");
});

test("milestoneWhere follows the report's stage table; milestoneAt reads the time off the row", () => {
  assert.equal(milestoneWhere("setter_self_booked"), "booked_at IS NOT NULL");
  const sq = milestoneWhere("setter_qualified");
  for (const s of ["'setter qualified'", "'closer booked'", "'closer followup'", "'closer booked noshow'", "'won'"]) assert.ok(sq.includes(s), s);
  assert.ok(!sq.includes("'setter disqualified'") && !sq.includes("'setter booked'"));
  assert.ok(sq.includes("closer_appointment_id IS NOT NULL"));
  assert.equal(milestoneWhere("setter_disqualified"), "LOWER(TRIM(pipeline_stage)) IN ('setter disqualified')");
  const cb = milestoneWhere("closer_booked");
  assert.ok(cb.includes("'closer booked'") && cb.includes("'won'") && !cb.includes("'setter qualified'"));

  assert.equal(milestoneAt("setter_self_booked", row({ booked_at: "2026-11-01T10:00:00Z" })), "2026-11-01T10:00:00Z");
  assert.equal(milestoneAt("setter_qualified", row({ pipeline_stage: "Setter Qualified", pipeline_stage_at: "2026-11-02T10:00:00Z" })), "2026-11-02T10:00:00Z");
  // a closer call on the calendar while the card still says Setter Booked: the stage time is not the milestone's
  assert.equal(milestoneAt("setter_qualified", row({ pipeline_stage: "Setter Booked", pipeline_stage_at: "2026-11-02T10:00:00Z" })), null);
  assert.equal(milestoneAt("closer_booked", row({ pipeline_stage: "Won", pipeline_stage_at: "2026-11-03T10:00:00Z" })), "2026-11-03T10:00:00Z");
  assert.equal(milestoneAt("closer_booked", row({ pipeline_stage: "Setter Qualified", pipeline_stage_at: "2026-11-03T10:00:00Z" })), null);
});

test("milestonePayload: lead at the top level, tracking flattened, milestone time as the timestamp", () => {
  const p = milestonePayload("setter_self_booked", row({ booked_at: "2026-11-01T10:00:00Z", appointment_start: "2026-11-02T15:00:00Z" }));
  assert.equal(p.event, "setter_self_booked");
  assert.equal(p.timestamp, "2026-11-01T10:00:00Z");
  assert.equal(p.lead_id, 7);
  assert.equal(p.session_id, "s-1");
  assert.equal(p.email, "billy@example.com");
  assert.equal(p.phone, "+13125550100");
  assert.equal(p.first_name, "Billy");
  assert.equal(p.last_name, "Hood");
  assert.equal(p.utm_source, "facebook");
  assert.equal(p.fbclid, "abc");
  assert.equal(p.ip_country, "US");
  assert.equal(p.appointment_start, "2026-11-02T15:00:00Z");
  assert.equal("closer_start" in p, false);
  const q = milestonePayload("closer_booked", row({ tracking: "{bad", closer_start: "2026-11-05T15:00:00Z" }));
  assert.equal(q.closer_start, "2026-11-05T15:00:00Z");
  assert.notEqual(q.timestamp, null);
  assert.equal(q.session_id, undefined);
});

test("relayEvent: true on 2xx, false on an error status, a thrown fetch or a missing URL", async () => {
  const env = { CORTANA_WEBHOOKS: HOOKS };
  let seen: { url: string; body: string } | null = null;
  const ok = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), body: String(init?.body) };
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await relayEvent(env, "setter_qualified", { event: "setter_qualified", email: "a@b.c" }, ok), true);
  assert.equal(seen!.url, "https://use.example.com/hook/sq");
  assert.equal(JSON.parse(seen!.body).email, "a@b.c");
  const bad = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  assert.equal(await relayEvent(env, "setter_qualified", {}, bad), false);
  const boom = (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
  assert.equal(await relayEvent(env, "setter_qualified", {}, boom), false);
  assert.equal(await relayEvent(env, "setter_disqualified", {}, ok), false); // no URL
  assert.equal(await relayEvent(env, "qualified", {}, ok), false); // http:// is dropped
});

/* The real SQL on a real SQLite: the lead columns the pass reads, then migration 0012 as written. */
function realDb(): { db: DatabaseSync; d1: D1Database } {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE leads (
    id INTEGER PRIMARY KEY, updated_at TEXT NOT NULL DEFAULT '2026-11-01T00:00:00.000Z', name TEXT, email TEXT, phone TEXT NOT NULL, city TEXT,
    timeline TEXT, business_owner TEXT, capital TEXT, tracking TEXT, country TEXT, pipeline_stage TEXT, pipeline_stage_at TEXT,
    appointment_tz TEXT, appointment_start TEXT, closer_appointment_id TEXT, closer_start TEXT)`);
  db.exec(readFileSync(new URL("../migrations/0012_cortana_stage_events.sql", import.meta.url), "utf8"));
  const d1 = {
    prepare(sql: string) {
      const st = db.prepare(sql);
      return {
        bind(...args: Array<string | number | null>) {
          return {
            async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; },
            async all() { return { results: st.all(...args) }; },
            async first() { return st.get(...args) ?? null; },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, d1 };
}

function insertLead(db: DatabaseSync, l: Partial<MilestoneRow> & { id: number; appointment_tz?: string | null; closer_appointment_id?: string | null }): void {
  const r = row(l);
  db.prepare(`INSERT INTO leads (id, name, email, phone, city, timeline, business_owner, capital, tracking, country, pipeline_stage, pipeline_stage_at,
    appointment_tz, appointment_start, closer_appointment_id, closer_start, booked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(r.id, r.name, r.email, r.phone, r.city, r.timeline, r.business_owner, r.capital, r.tracking, r.country, r.pipeline_stage, r.pipeline_stage_at,
      l.appointment_tz ?? null, r.appointment_start, l.closer_appointment_id ?? null, r.closer_start, r.booked_at);
}

test("migration 0012 backfills booked_at for the funnel's own bookings only", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE leads (id INTEGER PRIMARY KEY, updated_at TEXT NOT NULL, appointment_id TEXT, appointment_tz TEXT)");
  db.exec("INSERT INTO leads VALUES (1, '2026-11-01T10:00:00Z', 'a1', 'America/New_York'), (2, '2026-11-02T10:00:00Z', 'a2', NULL), (3, '2026-11-03T10:00:00Z', NULL, NULL)");
  db.exec(readFileSync(new URL("../migrations/0012_cortana_stage_events.sql", import.meta.url), "utf8"));
  assert.deepEqual(db.prepare("SELECT id, booked_at FROM leads ORDER BY id").all().map(plain), [
    { id: 1, booked_at: "2026-11-01T10:00:00Z" }, { id: 2, booked_at: null }, { id: 3, booked_at: null },
  ]);
  assert.deepEqual(plain(db.prepare("SELECT COUNT(*) AS n FROM cortana_sent").get()), { n: 0 });
});

test("relayMilestones posts each reached milestone once per lead, oldest first, within the budget; nothing without webhooks", async () => {
  const calls: Array<{ url: string; lead: number; event: string; timestamp: string }> = [];
  const fetchOk = (async (url: string | URL | Request, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    calls.push({ url: String(url), lead: b.lead_id, event: b.event, timestamp: b.timestamp });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const { db, d1 } = realDb();
  insertLead(db, { id: 1, booked_at: "2026-11-01T00:00:00Z" });
  insertLead(db, { id: 2, booked_at: "2026-11-02T00:00:00Z", pipeline_stage: "Closer Booked", pipeline_stage_at: "2026-11-03T00:00:00Z" });
  insertLead(db, { id: 3, pipeline_stage: "Setter Disqualified", pipeline_stage_at: "2026-11-03T00:00:00Z" }); // no URL for that step
  insertLead(db, { id: 4, pipeline_stage: " setter qualified ", pipeline_stage_at: "2026-11-04T00:00:00Z" });
  insertLead(db, { id: 5, pipeline_stage: "Setter Booked", closer_appointment_id: "c5", closer_start: "2026-11-09T00:00:00Z" }); // closer call booked, card not moved
  insertLead(db, { id: 6, pipeline_stage: "New Lead" });
  const env = { DB: d1, CORTANA_WEBHOOKS: HOOKS };

  const first = await relayMilestones(env, 3, fetchOk);
  assert.deepEqual({ events: first.events, sent: first.sent, failed: first.failed, skipped: first.skipped }, { events: 3, sent: 3, failed: 0, skipped: 0 });
  assert.deepEqual(calls.map((c) => `${c.event}:${c.lead}`), ["setter_self_booked:1", "setter_self_booked:2", "setter_qualified:2"]);
  assert.equal(calls[2].url, "https://use.example.com/hook/sq");
  assert.equal(calls[2].timestamp, "2026-11-03T00:00:00Z");

  // the budget ran out; the next pass finishes the rest and posts nothing twice
  const second = await relayMilestones(env, 14, fetchOk);
  assert.deepEqual({ sent: second.sent, failed: second.failed, skipped: second.skipped }, { sent: 4, failed: 0, skipped: 0 });
  assert.deepEqual(calls.map((c) => `${c.event}:${c.lead}`).slice(3), ["setter_qualified:4", "setter_qualified:5", "closer_booked:2", "closer_booked:5"]);
  assert.notEqual(calls[4].timestamp, "2026-11-03T00:00:00Z"); // lead 5: the card never said so, stamped now
  const third = await relayMilestones(env, 14, fetchOk);
  assert.deepEqual({ sent: third.sent, failed: third.failed }, { sent: 0, failed: 0 });
  assert.equal(calls.length, 7);
  assert.deepEqual(plain(db.prepare("SELECT COUNT(*) AS n FROM cortana_sent WHERE sent_at IS NOT NULL AND attempts = 1").get()), { n: 7 });

  const none = await relayMilestones({ DB: d1, CORTANA_WEBHOOKS: "{}" }, 14, fetchOk);
  assert.equal(none.note, "no milestone webhooks configured");
  assert.equal(calls.length, 7);
});

test("a failed post keeps its claim: retried an hour later, at most MAX_ATTEMPTS times; a sent one is never posted again", async () => {
  const { db, d1 } = realDb();
  insertLead(db, { id: 5, booked_at: "2026-11-01T00:00:00Z" });
  const env = { DB: d1, CORTANA_WEBHOOKS: HOOKS };
  let posts = 0;
  const down = (async () => { posts++; return new Response("x", { status: 502 }); }) as unknown as typeof fetch;
  const up = (async () => { posts++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  const age = (hours: number) => db.prepare("UPDATE cortana_sent SET claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now',?)").run(`-${hours} hours`);

  assert.equal(await sendMilestoneOnce(env, 5, "setter_self_booked", { event: "setter_self_booked" }, down), "failed");
  assert.deepEqual(plain(db.prepare("SELECT attempts, sent_at FROM cortana_sent").get()), { attempts: 1, sent_at: null });
  // within the hour: the claim is still held, nobody retries
  assert.equal((await relayMilestones(env, 14, up)).skipped + (await relayMilestones(env, 14, up)).sent, 0);
  assert.equal(await sendMilestoneOnce(env, 5, "setter_self_booked", {}, up), "skipped");
  assert.equal(posts, 1);
  // an hour on: the pass takes the claim over and the post goes through
  age(2);
  assert.deepEqual((({ sent, failed, skipped }) => ({ sent, failed, skipped }))(await relayMilestones(env, 14, up)), { sent: 1, failed: 0, skipped: 0 });
  assert.deepEqual(plain(db.prepare("SELECT attempts, sent_at IS NOT NULL AS sent FROM cortana_sent").get()), { attempts: 2, sent: 1 });
  assert.equal(posts, 2);
  // sent: not again, however old the row
  age(48);
  assert.equal(await sendMilestoneOnce(env, 5, "setter_self_booked", {}, up), "skipped");
  assert.equal((await relayMilestones(env, 14, up)).sent, 0);
  assert.equal(posts, 2);

  // a lead Cortana keeps refusing: one try an hour, then left alone
  db.exec("DELETE FROM cortana_sent");
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    assert.equal((await relayMilestones(env, 14, down)).failed, 1, `attempt ${i + 1}`);
    age(2);
  }
  assert.equal((await relayMilestones(env, 14, down)).failed, 0);
  assert.deepEqual(plain(db.prepare("SELECT attempts, sent_at FROM cortana_sent").get()), { attempts: MAX_ATTEMPTS, sent_at: null });

  // a request path and the pass share the claim: whoever is first posts, the other skips
  insertLead(db, { id: 6, booked_at: "2026-11-02T00:00:00Z" });
  assert.equal(await sendMilestoneOnce(env, 6, "setter_self_booked", milestonePayload("setter_self_booked", row({ id: 6 })), up), "sent");
  assert.equal((await relayMilestones(env, 14, up)).sent, 0);
  // no URL for the step → nothing claimed
  assert.equal(await sendMilestoneOnce(env, 6, "setter_disqualified", {}, up), "skipped");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cortana_sent WHERE event = 'setter_disqualified'").get()!.n, 0);
  assert.equal(MILESTONE_EVENTS.length, 4);
});
