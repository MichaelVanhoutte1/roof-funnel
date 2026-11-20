import { test } from "node:test";
import assert from "node:assert/strict";
import { drainPending } from "../src/csp-push.ts";
import { ALERT_EVERY_MS, OUTAGE_ALERT_AFTER_MS, pushReport, recordRun } from "../src/csp-push-health.ts";
import { fakeCsp, insertLead, on, plain, realDb } from "./csp-push-helpers.ts";

const SLACK = "https://hooks.slack.test/services/T000/B000/placeholder";

function slack() {
  const posts: Array<{ url: string; body: { text: string } }> = [];
  const fetchImpl = (async (u: unknown, init?: RequestInit) => {
    posts.push({ url: String(u), body: JSON.parse(String(init?.body)) as { text: string } });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  return { posts, fetchImpl };
}

const health = (db: ReturnType<typeof realDb>["db"]) => {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'csp_push_health'").get();
  return r ? JSON.parse(String(plain(r).value)) as Record<string, string | null> : null;
};

test("an outage reaches Slack once it has lasted 30 minutes, then at most every 6 hours; a success clears it", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1);
  const env = { ...on(d1), SLACK_LEAD_ALERTS_WEBHOOK: SLACK };
  const s = slack();
  const t0 = Date.parse("2026-11-20T12:00:00.000Z");
  await recordRun(env, { requestsOk: 0, requestsFailed: 1, error: "http_401" }, t0, s.fetchImpl);
  assert.equal(health(db)?.failing_since, "2026-11-20T12:00:00.000Z");
  await recordRun(env, { requestsOk: 0, requestsFailed: 1, error: "http_401" }, t0 + OUTAGE_ALERT_AFTER_MS - 1, s.fetchImpl);
  assert.equal(s.posts.length, 0);
  await recordRun(env, { requestsOk: 0, requestsFailed: 1, error: "http_401" }, t0 + OUTAGE_ALERT_AFTER_MS, s.fetchImpl);
  assert.equal(s.posts.length, 1);
  assert.equal(s.posts[0].url, SLACK);
  assert.match(s.posts[0].body.text, /not reaching the CSP.*http_401.*1 row\(s\) waiting/);
  assert.doesNotMatch(JSON.stringify(s.posts[0].body), /\+1312|Lead 1/); // counts and codes only, never lead data
  // throttled while it lasts
  await recordRun(env, { requestsOk: 0, requestsFailed: 1, error: "http_401" }, t0 + OUTAGE_ALERT_AFTER_MS + ALERT_EVERY_MS - 1, s.fetchImpl);
  assert.equal(s.posts.length, 1);
  await recordRun(env, { requestsOk: 0, requestsFailed: 1, error: "http_401" }, t0 + OUTAGE_ALERT_AFTER_MS + ALERT_EVERY_MS, s.fetchImpl);
  assert.equal(s.posts.length, 2);
  // a successful request ends the outage
  await recordRun(env, { requestsOk: 1, requestsFailed: 0 }, t0 + 8 * 3600_000, s.fetchImpl);
  assert.equal(health(db)?.failing_since, null);
  assert.equal(health(db)?.last_ok_at, new Date(t0 + 8 * 3600_000).toISOString());
});

test("records the CSP refuses reach Slack with their codes, throttled; a Slack failure is retried next run", async () => {
  const { db, d1 } = realDb();
  for (let i = 1; i <= 3; i++) insertLead(db, i);
  const env = { ...on(d1), SLACK_LEAD_ALERTS_WEBHOOK: SLACK };
  const posts: string[] = [];
  let slackUp = false;
  const csp = fakeCsp({ refuse: (r) => (r.d1_id !== 1 ? "too_long:tracking" : null) });
  const fetchImpl = (async (u: unknown, init?: RequestInit) => {
    if (String(u) === SLACK) {
      if (!slackUp) return new Response("no", { status: 500 });
      posts.push(String(init?.body));
      return new Response("ok");
    }
    return csp.fetchImpl(u as string, init);
  }) as unknown as typeof fetch;
  await drainPending(env, fetchImpl);
  assert.equal(posts.length, 0);
  assert.equal(health(db)?.rejected_alerted_at ?? null, null); // not sent: not throttled either
  slackUp = true;
  await drainPending(env, fetchImpl);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /refused 2 lead record\(s\) \(rejected: too_long:tracking\)/);
  await drainPending(env, fetchImpl);
  assert.equal(posts.length, 1, "at most every 6 hours");
});

test("switched on but misconfigured counts as failing, so it is reported like an outage", async () => {
  const { db, d1 } = realDb();
  const env = { ...on(d1), FUNNEL_LEADS_SECRET: "too-short" };
  const s = await drainPending(env);
  assert.match(String(s.skipped), /too short/);
  assert.match(String(health(db)?.last_error), /^config: FUNNEL_LEADS_SECRET too short/);
  assert.ok(health(db)?.failing_since);
  // switched off is not a problem and writes nothing
  const { db: db2, d1: d2 } = realDb();
  await drainPending({ DB: d2 });
  assert.equal(health(db2), null);
});

test("the admin report shows the backlog and the push state; before 0014 it is null, never an error", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1);
  insertLead(db, 2);
  db.prepare("INSERT INTO email_captures (email) VALUES ('x@example.com')").run();
  await drainPending(on(d1), fakeCsp({ refuse: (r) => (r.d1_id === 2 && r.kind === "lead" ? "invalid:phone" : null) }).fetchImpl);
  insertLead(db, 3);
  const r = await pushReport(on(d1));
  assert.deepEqual({ ...r, lastOkAt: typeof r?.lastOkAt }, {
    enabled: true, pending: 2, rejected: 1, rejectedCodes: ["rejected: invalid:phone"], failingSince: null, lastError: null, lastOkAt: "string",
  });
  assert.equal(await pushReport(on(realDb("0013").d1)), null);
});
