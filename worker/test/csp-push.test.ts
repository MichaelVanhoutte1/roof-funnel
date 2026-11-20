import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { backoffMs, chunk, CRON_BATCHES, drainPending, fairShare, PUSH_BATCH, pushConfig, pushOne, pushRecords, pushSetup, SCHEMA_VERSION, toRecord } from "../src/csp-push.ts";
import { HELD_BACK_COLUMNS, INTEGER_COLUMNS, SENT_COLUMNS } from "../src/csp-push-columns.ts";
import { signStandardWebhook, standardWebhookHeaders } from "../src/webhook-signature.ts";
import { fakeCsp, insertLead, MIGRATIONS, on, plain, pushState, realDb, SECRET, URL_ } from "./csp-push-helpers.ts";

/* ---------------- migration 0014 ---------------- */

test("migration 0014 on the full chain: historical rows start pending, triggers stamp every write, push writes never re-stamp", () => {
  const { db } = realDb("0013");
  insertLead(db, 1);
  db.prepare("INSERT INTO email_captures (email) VALUES ('old@example.com')").run();
  db.exec(readFileSync(new URL("0014_csp_lead_push.sql", MIGRATIONS), "utf8"));
  // historical rows: stamped with their updated_at, never pushed → pending (the cron backfills them)
  const old = plain(db.prepare("SELECT updated_at, csp_changed_at, csp_synced_updated_at, csp_sync_attempts, csp_next_attempt_at FROM leads").get());
  assert.equal(old.csp_changed_at, old.updated_at);
  assert.equal(old.csp_synced_updated_at, null);
  assert.equal(old.csp_sync_attempts, 0);
  assert.equal(old.csp_next_attempt_at, null);
  const oldCapture = plain(db.prepare("SELECT updated_at, csp_changed_at FROM email_captures").get());
  assert.equal(oldCapture.csp_changed_at, oldCapture.updated_at);

  // a new row is stamped on insert
  insertLead(db, 2);
  const stamp = () => String(plain(db.prepare("SELECT csp_changed_at FROM leads WHERE id = 2").get()).csp_changed_at);
  const s0 = stamp();
  assert.match(s0, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  // a write from any site that never touches updated_at (credit result, GHL status, outcome sync) moves it forward,
  // strictly, even twice inside the same millisecond
  db.prepare("UPDATE leads SET credit_status = 'success', credit_score = 712 WHERE id = 2").run();
  const s1 = stamp();
  db.prepare("UPDATE leads SET ghl_status = 'sent' WHERE id = 2").run();
  const s2 = stamp();
  assert.ok(s0 < s1 && s1 < s2, `${s0} < ${s1} < ${s2}`);
  // updated_at itself is untouched by the trigger (the credit problem notice counts rows by it)
  const u = plain(db.prepare("SELECT created_at, updated_at FROM leads WHERE id = 2").get());
  assert.equal(u.updated_at, u.created_at);
  // the pusher's own writes leave the stamp alone
  db.prepare("UPDATE leads SET csp_synced_updated_at = csp_changed_at, csp_sync_attempts = 0, csp_sync_error = NULL WHERE id = 2").run();
  db.prepare("UPDATE leads SET csp_sync_attempts = csp_sync_attempts + 1, csp_sync_error = 'rejected: x', csp_next_attempt_at = '2999-01-01T00:00:00.000Z' WHERE id = 2").run();
  assert.equal(stamp(), s2);
  // a real write clears the backoff, so a corrected row goes straight away
  db.prepare("UPDATE leads SET credit_income = 52000 WHERE id = 2").run();
  assert.ok(stamp() > s2);
  assert.equal(plain(db.prepare("SELECT csp_next_attempt_at FROM leads WHERE id = 2").get()).csp_next_attempt_at, null);
  // an unparsable updated_at never leaves the stamp NULL (SQLite's max() is NULL when any argument is)
  insertLead(db, 3, { updated_at: "garbage" });
  const s3 = () => plain(db.prepare("SELECT csp_changed_at FROM leads WHERE id = 3").get()).csp_changed_at;
  assert.match(String(s3()), /^\d{4}-/);
  db.prepare("UPDATE leads SET city = 'Ocala' WHERE id = 3").run();
  assert.match(String(s3()), /^\d{4}-/);
  // email captures: the upsert path (ON CONFLICT DO UPDATE) stamps too
  const cap = () => String(plain(db.prepare("SELECT csp_changed_at FROM email_captures WHERE email = 'new@example.com'").get()).csp_changed_at);
  db.prepare("INSERT INTO email_captures (email, city) VALUES ('new@example.com', 'Tampa')").run();
  const c0 = cap();
  db.prepare("INSERT INTO email_captures (email, city) VALUES ('new@example.com', 'Ocala') ON CONFLICT(email) DO UPDATE SET city = excluded.city").run();
  assert.ok(c0 < cap());
});

test("the pending scan reads the partial index, for both tables, with the backoff filter on top", () => {
  const { db } = realDb();
  for (const t of ["leads", "email_captures"]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM ${t} WHERE (csp_synced_updated_at IS NULL OR csp_synced_updated_at < csp_changed_at) AND (csp_next_attempt_at IS NULL OR csp_next_attempt_at <= ?) ORDER BY csp_sync_attempts, csp_changed_at, id LIMIT 100`).all("2026-01-01T00:00:00.000Z").map(plain);
    assert.ok(plan.some((p) => /USING INDEX \w+_csp_pending_idx/.test(String(p.detail))), JSON.stringify(plan));
    assert.ok(!plan.some((p) => /TEMP B-TREE/.test(String(p.detail))), "ordered by the index, no sort");
  }
});

/* ---------------- signing ---------------- */

test("Standard Webhooks v1 signature = base64 HMAC-SHA256 of id.timestamp.body keyed by the secret's UTF-8 bytes", async () => {
  const body = '{"records":[]}';
  const sig = await signStandardWebhook(SECRET, "msg_1", 1_763_000_000, body);
  assert.equal(sig, `v1,${createHmac("sha256", Buffer.from(SECRET, "utf8")).update(`msg_1.1763000000.${body}`).digest("base64")}`);
  const h = await standardWebhookHeaders(SECRET, body, 1_763_000_000_999);
  assert.match(h["webhook-id"], /^msg_[0-9a-f-]{36}$/);
  assert.equal(h["webhook-timestamp"], "1763000000");
  assert.equal(h["webhook-signature"], `v1,${createHmac("sha256", SECRET).update(`${h["webhook-id"]}.1763000000.${body}`).digest("base64")}`);
  assert.notEqual((await standardWebhookHeaders(SECRET, body))["webhook-id"], (await standardWebhookHeaders(SECRET, body))["webhook-id"]);
});

/* ---------------- records ---------------- */

test("every D1 column is classified: sent or held back, never both; a new column fails here until someone decides", () => {
  const { db } = realDb();
  for (const [kind, table] of [["lead", "leads"], ["email_capture", "email_captures"]] as const) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all().map(plain);
    const columns = info.map((c) => String(c.name)).sort();
    const sent = [...SENT_COLUMNS[kind]];
    const held = [...HELD_BACK_COLUMNS[kind]];
    assert.deepEqual(sent.filter((c) => held.includes(c)), [], `${table}: sent and held back`);
    assert.deepEqual([...sent, ...held].sort(), columns, `${table}: every column classified, nothing unknown`);
    // the integer list is exactly the INTEGER columns that are sent
    const ints = info.filter((c) => c.type === "INTEGER" && sent.includes(String(c.name))).map((c) => String(c.name)).sort();
    assert.deepEqual([...INTEGER_COLUMNS[kind]].sort(), ints, `${table}: INTEGER columns`);
  }
  assert.ok(HELD_BACK_COLUMNS.lead.includes("credit_identity"));
});

test("a record carries the allowlisted columns (tracking parsed, integers rounded), never credit_identity or bookkeeping", () => {
  const { db } = realDb();
  insertLead(db, 7, { tracking: '{"utm_source":"facebook","fbclid":"abc"}', credit_score: 701, credit_dti: 16.5, ghl_contact_id: "c-7", credit_identity: "abc123", credit_income: 52000.5 });
  insertLead(db, 8, { tracking: "not json" });
  const rows = db.prepare("SELECT * FROM leads ORDER BY id").all().map(plain);
  const r = toRecord("lead", rows[0]);
  assert.equal(r.kind, "lead");
  assert.equal(r.d1_id, 1);
  assert.equal(r.version, rows[0].csp_changed_at);
  assert.equal(r.row.csp_changed_at, rows[0].csp_changed_at); // the CSP's ordering key
  assert.deepEqual(r.row.tracking, { utm_source: "facebook", fbclid: "abc" });
  assert.equal(r.row.credit_score, 701);
  assert.equal(r.row.credit_dti, 16.5); // REAL stays REAL
  assert.equal(r.row.credit_income, 52001); // an INTEGER column holding a REAL is rounded
  assert.equal(r.row.ghl_contact_id, "c-7");
  assert.ok(!("credit_identity" in r.row));
  assert.deepEqual(Object.keys(r.row), [...SENT_COLUMNS.lead]);
  assert.equal(toRecord("lead", rows[1]).row.tracking, null);
  assert.equal(toRecord("lead", { ...rows[1], tracking: null }).row.tracking, null);
  assert.equal(toRecord("lead", { ...rows[1], tracking: "[1,2]" }).row.tracking, null);
  // a column outside the allowlist never ships, even when the row has it
  assert.ok(!("future_secret" in toRecord("lead", { ...rows[1], future_secret: "x" }).row));
  db.prepare("INSERT INTO email_captures (email, tracking) VALUES ('a@example.com', '{\"gclid\":\"g\"}')").run();
  const cap = toRecord("email_capture", plain(db.prepare("SELECT * FROM email_captures").get()));
  assert.deepEqual(Object.keys(cap.row), [...SENT_COLUMNS.email_capture]);
  assert.deepEqual(cap.row.tracking, { gclid: "g" });
});

test("chunk: at most PUSH_BATCH records and the byte cap per request", () => {
  const recs = Array.from({ length: 230 }, (_, i) => ({ kind: "lead" as const, d1_id: i, row: { pad: "x".repeat(1000) } }));
  assert.deepEqual(chunk(recs).map((c) => c.length), [100, 100, 30]);
  const small = chunk(recs, 10_500);
  assert.ok(small.every((c) => c.length <= 10));
  assert.equal(small.flat().length, 230);
  assert.deepEqual(chunk([{ kind: "lead", d1_id: 1, row: { pad: "x".repeat(5000) } }], 100).map((c) => c.length), [1]);
});

test("fairShare: half of a batch is kept for email captures; an idle kind gives its share away", () => {
  const n = (k: number, p: string) => Array.from({ length: k }, (_, i) => `${p}${i}`);
  const count = (xs: string[], p: string) => xs.filter((x) => x.startsWith(p)).length;
  const both = fairShare(n(100, "l"), n(100, "c"));
  assert.deepEqual([count(both, "l"), count(both, "c")], [50, 50]);
  const fewLeads = fairShare(n(30, "l"), n(100, "c"));
  assert.deepEqual([count(fewLeads, "l"), count(fewLeads, "c")], [30, 70]);
  const noCaptures = fairShare(n(100, "l"), []);
  assert.deepEqual([count(noCaptures, "l"), count(noCaptures, "c")], [100, 0]);
  assert.deepEqual(fairShare([], []), []);
});

test("backoff: 2 minutes doubling, capped at 24 hours", () => {
  assert.deepEqual([1, 2, 3, 10].map((a) => backoffMs(a) / 60_000), [2, 4, 8, 1024]);
  assert.equal(backoffMs(11), 24 * 60 * 60_000);
  assert.equal(backoffMs(500), 24 * 60 * 60_000);
});

test("pushConfig: off unless switched on, https on the roof CSP API host, and a secret of the CSP's minimum length", () => {
  const d1 = {} as D1Database;
  assert.deepEqual(pushConfig(on(d1)), { url: URL_, secret: SECRET });
  assert.deepEqual(pushConfig({ ...on(d1), FUNNEL_LEADS_SECRET: ` ${SECRET}\n` }), { url: URL_, secret: SECRET }); // trimmed, like the CSP
  const reason = (env: Record<string, unknown>) => { const s = pushSetup({ ...on(d1), ...env }); return "off" in s ? s.off : "on"; };
  assert.equal(reason({ CSP_LEADS_PUSH_ENABLED: "false" }), "off");
  assert.equal(reason({ CSP_LEADS_PUSH_ENABLED: undefined }), "off");
  assert.match(reason({ CSP_LEADS_URL: "" }), /^config: CSP_LEADS_URL missing/);
  assert.match(reason({ CSP_LEADS_URL: "not a url" }), /^config: CSP_LEADS_URL missing/);
  assert.match(reason({ CSP_LEADS_URL: "http://csp-api.startroofrejuvenating.com/webhook/funnel-leads" }), /not https/);
  // lead PII never goes to roof staging or a typo'd host
  assert.match(reason({ CSP_LEADS_URL: "https://csp-api-staging.startroofrejuvenating.com/webhook/funnel-leads" }), /not the roof CSP API host/);
  assert.match(reason({ CSP_LEADS_URL: "https://csp-api.startroofrejuvenating.com.evil.test/webhook/funnel-leads" }), /not the roof CSP API host/);
  assert.match(reason({ FUNNEL_LEADS_SECRET: "" }), /SECRET missing/);
  assert.match(reason({ FUNNEL_LEADS_SECRET: "x".repeat(31) }), /too short/);
  assert.equal(pushConfig({ ...on(d1), FUNNEL_LEADS_SECRET: "x".repeat(31) }), null);
});

/* ---------------- the push ---------------- */

test("drain: signed schema-2 batch to CSP_LEADS_URL, no redirects followed, acknowledged rows marked, nothing resent until a row changes", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1, { tracking: '{"utm_campaign":"roof"}' });
  insertLead(db, 2);
  db.prepare("INSERT INTO email_captures (email, name) VALUES ('cap@example.com', 'Cap Person')").run();
  const csp = fakeCsp();
  assert.deepEqual(await drainPending(on(d1), csp.fetchImpl), { sent: 3, synced: 3, failed: 0 });
  assert.equal(csp.deliveries.length, 1);
  const d = csp.deliveries[0];
  assert.equal(d.url, URL_);
  assert.equal(d.init.redirect, "manual");
  assert.equal(d.headers["Content-Type"], "application/json");
  const expected = createHmac("sha256", SECRET).update(`${d.headers["webhook-id"]}.${d.headers["webhook-timestamp"]}.${d.text}`).digest("base64");
  assert.equal(d.headers["webhook-signature"], `v1,${expected}`);
  assert.ok(Math.abs(Number(d.headers["webhook-timestamp"]) - Date.now() / 1000) < 5);
  assert.equal(d.body.source, "roof-funnel");
  assert.equal(d.body.schema, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 2);
  assert.deepEqual(d.body.records.map((r) => [r.kind, r.d1_id]), [["lead", 1], ["lead", 2], ["email_capture", 1]]);
  assert.deepEqual(d.body.records[0].row.tracking, { utm_campaign: "roof" });
  assert.equal(d.body.records[0].row.phone, "+13125550001");
  assert.equal(d.body.records[2].row.email, "cap@example.com");
  assert.ok(!("csp_sync_attempts" in d.body.records[0].row));
  assert.deepEqual(pushState(db).map((r) => r.synced), [1, 1]);
  assert.deepEqual(pushState(db, "email_captures").map((r) => r.synced), [1]);

  // nothing pending: no request at all
  assert.deepEqual(await drainPending(on(d1), csp.fetchImpl), { sent: 0, synced: 0, failed: 0 });
  assert.equal(csp.deliveries.length, 1);
});

test("later writes that never bump updated_at reach a CSP that orders on csp_changed_at: credit result, then an identity wipe", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1, { name: "Person A" });
  const csp = fakeCsp();
  await drainPending(on(d1), csp.fetchImpl);
  const updatedAt = plain(db.prepare("SELECT updated_at FROM leads WHERE id = 1").get()).updated_at;
  // the credit result lands (no updated_at bump): applied on the CSP, not "unchanged"
  db.prepare("UPDATE leads SET credit_status = 'success', credit_score = 688, credit_consent_ip = '203.0.113.9' WHERE id = 1").run();
  assert.deepEqual(await drainPending(on(d1), csp.fetchImpl), { sent: 1, synced: 1, failed: 0 });
  assert.equal(csp.held.get("lead:1")?.credit_score, 688);
  // the row is reused by someone else and the earlier person's credit data is wiped (still no updated_at bump)
  db.prepare("UPDATE leads SET credit_status = NULL, credit_score = NULL, credit_consent_ip = NULL WHERE id = 1").run();
  await drainPending(on(d1), csp.fetchImpl);
  assert.equal(csp.held.get("lead:1")?.credit_score, null);
  assert.equal(csp.held.get("lead:1")?.credit_consent_ip, null);
  assert.equal(plain(db.prepare("SELECT updated_at FROM leads WHERE id = 1").get()).updated_at, updatedAt);
  // a replay of an older version is acknowledged as unchanged and never overwrites the newer data
  const stale = { ...csp.deliveries[1].body.records[0] };
  const res = await csp.fetchImpl(URL_, { method: "POST", body: JSON.stringify({ source: "roof-funnel", schema: 2, records: [stale] }) });
  assert.equal(((await res.json()) as { results: Array<{ status: string }> }).results[0].status, "unchanged");
  assert.equal(csp.held.get("lead:1")?.credit_score, null);
});

test("a CSP that only speaks schema 1 answers 400: every row stays pending, nothing is lost as 'unchanged'", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1);
  const old = fakeCsp({ schema: 1 });
  const s = await drainPending(on(d1), old.fetchImpl);
  assert.deepEqual(s, { sent: 1, synced: 0, failed: 1, error: "http_400" });
  assert.deepEqual(pushState(db)[0], { id: 1, stamped: 1, synced: null, attempts: 1, error: "http_400" });
});

test("a redirect is a failure: the signed body is never re-posted to the Location host", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1);
  const calls: string[] = [];
  const redirecting = (async (u: unknown, init?: RequestInit) => {
    calls.push(String(u));
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 307, headers: { Location: "http://elsewhere.example.test/" } });
  }) as unknown as typeof fetch;
  assert.equal((await drainPending(on(d1), redirecting)).error, "http_307");
  assert.deepEqual(calls, [URL_]);
  assert.equal(pushState(db)[0].synced, null);
});

test("a refused record keeps its error, waits out its backoff, and does not stop the run; the rest is acknowledged", async () => {
  const { db, d1 } = realDb();
  for (let i = 1; i <= 3; i++) insertLead(db, i);
  const csp = fakeCsp({ refuse: (r) => (r.d1_id === 2 ? "invalid:phone" : null) });
  const t0 = Date.now();
  assert.deepEqual(await drainPending(on(d1), csp.fetchImpl), { sent: 3, synced: 2, failed: 1, error: "rejected: invalid:phone" });
  assert.deepEqual(pushState(db), [
    { id: 1, stamped: 1, synced: 1, attempts: 0, error: null },
    { id: 2, stamped: 1, synced: null, attempts: 1, error: "rejected: invalid:phone" },
    { id: 3, stamped: 1, synced: 1, attempts: 0, error: null },
  ]);
  const next = Date.parse(String(plain(db.prepare("SELECT csp_next_attempt_at FROM leads WHERE id = 2").get()).csp_next_attempt_at));
  assert.ok(next >= t0 + backoffMs(1) && next <= Date.now() + backoffMs(1));
  // inside the backoff the cron does not send it again
  assert.deepEqual(await drainPending(on(d1), csp.fetchImpl), { sent: 0, synced: 0, failed: 0 });
  // a missing or mismatched result is a failure too, never a silent success
  insertLead(db, 4);
  await drainPending(on(d1), fakeCsp({ omit: (r) => r.d1_id === 4 }).fetchImpl);
  assert.equal(pushState(db)[3].synced, null);
  assert.equal(pushState(db)[3].error, "no_result");
  // once the backoff is over (or the row changes) and the CSP accepts it, the count, error and wait are cleared
  db.prepare("UPDATE leads SET csp_next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = 4").run();
  db.prepare("UPDATE leads SET phone = '+13125559999' WHERE id = 2").run(); // corrected: due straight away
  await drainPending(on(d1), fakeCsp().fetchImpl);
  assert.deepEqual(pushState(db).map((r) => [r.synced, r.attempts, r.error]), [[1, 0, null], [1, 0, null], [1, 0, null], [1, 0, null]]);
  assert.equal(plain(db.prepare("SELECT COUNT(*) AS n FROM leads WHERE csp_next_attempt_at IS NOT NULL").get()).n, 0);
});

test("120 leads the CSP keeps refusing never starve email captures, and are not resent every run", async () => {
  const { db, d1 } = realDb();
  for (let i = 1; i <= 120; i++) insertLead(db, i);
  db.prepare("INSERT INTO email_captures (email) VALUES ('a@example.com')").run();
  const csp = fakeCsp({ refuse: (r) => (r.kind === "lead" ? "invalid:credit_income" : null) });
  const first = await drainPending(on(d1), csp.fetchImpl);
  assert.equal(first.synced, 1);
  assert.deepEqual(pushState(db, "email_captures").map((r) => r.synced), [1]);
  assert.equal(first.sent, 121); // the run went on past the refused records: every lead was tried once
  const sentBefore = csp.deliveries.length;
  for (let run = 0; run < 5; run++) await drainPending(on(d1), csp.fetchImpl);
  assert.equal(csp.deliveries.length, sentBefore, "refused leads wait out their backoff");
  assert.equal(plain(db.prepare("SELECT MAX(csp_sync_attempts) AS m FROM leads").get()).m, 1);
});

test("a CSP outage fails the whole batch, counts a try on each row, and ends the run after one request", async () => {
  const { db, d1 } = realDb();
  for (let i = 1; i <= PUSH_BATCH + 20; i++) insertLead(db, i);
  const down = fakeCsp({ httpStatus: 503 });
  const s = await drainPending(on(d1), down.fetchImpl);
  assert.deepEqual(s, { sent: PUSH_BATCH, synced: 0, failed: PUSH_BATCH, error: "http_503" });
  assert.equal(down.deliveries.length, 1);
  assert.equal(pushState(db).filter((r) => r.attempts === 1 && r.error === "http_503").length, PUSH_BATCH);
  // an outage does not back rows off: they are due again on the next run
  assert.equal(plain(db.prepare("SELECT COUNT(*) AS n FROM leads WHERE csp_next_attempt_at IS NOT NULL").get()).n, 0);
  // network errors and a body that is not the contract's shape fail the same way
  const boom = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.match(String((await drainPending(on(d1), boom)).error), /^network: TypeError: fetch failed/);
  const garbage = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
  assert.equal((await drainPending(on(d1), garbage)).error, "bad_response");
  // rows that failed sort behind the ones that never did: the 20 untouched rows went first on the retries
  assert.deepEqual(pushState(db).slice(PUSH_BATCH).map((r) => r.attempts), Array(20).fill(2));
});

test("cron: oldest first, PUSH_BATCH per request, CRON_BATCHES per run, each batch shared between leads and captures", async () => {
  const { db, d1 } = realDb();
  for (let i = 1; i <= 250; i++) insertLead(db, i);
  for (let i = 1; i <= 80; i++) db.prepare("INSERT INTO email_captures (email) VALUES (?)").run(`c${i}@example.com`);
  const csp = fakeCsp();
  const first = await drainPending(on(d1), csp.fetchImpl);
  assert.equal(CRON_BATCHES, 3);
  assert.deepEqual(first, { sent: 300, synced: 300, failed: 0 });
  assert.deepEqual(csp.deliveries.map((d) => d.body.records.length), [100, 100, 100]);
  const kinds = (i: number) => csp.deliveries[i].body.records.map((r) => r.kind);
  // 50 / 50 while both have rows; then the captures' leftover share (30 → 70 leads) goes to leads
  assert.deepEqual([0, 1, 2].map((i) => kinds(i).filter((k) => k === "lead").length), [50, 70, 100]);
  assert.deepEqual(csp.deliveries[0].body.records.slice(0, 3).map((r) => r.d1_id), [1, 2, 3]);
  assert.deepEqual(await drainPending(on(d1), csp.fetchImpl), { sent: 30, synced: 30, failed: 0 });
  assert.deepEqual(await drainPending(on(d1), csp.fetchImpl), { sent: 0, synced: 0, failed: 0 });
  assert.equal(csp.deliveries.length, 4);
});

test("a row written while its push is in flight is not marked: it goes again with the newer data", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1);
  const deliveries: number[] = [];
  const racing = (async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { records: Array<{ kind: string; d1_id: number; row: Record<string, unknown> }> };
    deliveries.push(Number(body.records[0].row.credit_score ?? 0));
    if (deliveries.length === 1) db.prepare("UPDATE leads SET credit_score = 640 WHERE id = 1").run(); // the credit result lands now
    return new Response(JSON.stringify({ results: body.records.map((r) => ({ kind: r.kind, d1_id: r.d1_id, status: "applied" })) }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await drainPending(on(d1), racing, 1), { sent: 1, synced: 1, failed: 0 });
  assert.equal(pushState(db)[0].synced, null); // acknowledged, but the stamp moved: not marked, still pending
  await drainPending(on(d1), racing, 1);
  assert.deepEqual(deliveries, [0, 640]);
  assert.equal(pushState(db)[0].synced, 1);
});

test("a late failure for an older version never touches a row that changed meanwhile", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1);
  const failing = (async () => {
    db.prepare("UPDATE leads SET city = 'Tampa' WHERE id = 1").run(); // a visitor write lands while the request is out
    return new Response("down", { status: 503 });
  }) as unknown as typeof fetch;
  await drainPending(on(d1), failing, 1);
  assert.deepEqual(pushState(db)[0], { id: 1, stamped: 1, synced: null, attempts: 0, error: null });
});

test("a record without a stamp is reported, never sent (it could never be marked synced)", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1);
  const raw = plain(db.prepare("SELECT * FROM leads WHERE id = 1").get());
  const csp = fakeCsp();
  const s = await pushRecords(on(d1), [toRecord("lead", { ...raw, csp_changed_at: null })], csp.fetchImpl);
  assert.deepEqual(s, { sent: 0, synced: 0, failed: 1, error: "no_version" });
  assert.equal(csp.deliveries.length, 0);
});

test("off switch, missing URL or secret: no request, no write", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1);
  const csp = fakeCsp();
  for (const env of [{ DB: d1 }, { ...on(d1), CSP_LEADS_PUSH_ENABLED: "false" }, { ...on(d1), CSP_LEADS_URL: "" }, { ...on(d1), FUNNEL_LEADS_SECRET: undefined }]) {
    assert.equal((await drainPending(env, csp.fetchImpl)).sent, 0);
    assert.deepEqual(await pushOne(env, "lead", "id", 1, csp.fetchImpl), { sent: 0, synced: 0, failed: 0, skipped: "off" });
  }
  assert.deepEqual(await drainPending({ DB: d1 }, csp.fetchImpl), { sent: 0, synced: 0, failed: 0, skipped: "off" });
  assert.match(String((await drainPending({ ...on(d1), FUNNEL_LEADS_SECRET: "short" }, csp.fetchImpl)).skipped), /^config: FUNNEL_LEADS_SECRET too short/);
  assert.equal(csp.deliveries.length, 0);
  assert.deepEqual(pushState(db)[0], { id: 1, stamped: 1, synced: null, attempts: 0, error: null });
});

test("pushOne: the one row by id or email, only while pending; never rejects (a Worker running before migration 0014)", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1);
  insertLead(db, 2);
  db.prepare("INSERT INTO email_captures (email) VALUES ('one@example.com')").run();
  const csp = fakeCsp();
  assert.deepEqual(await pushOne(on(d1), "lead", "id", 2, csp.fetchImpl), { sent: 1, synced: 1, failed: 0 });
  assert.deepEqual(csp.deliveries[0].body.records.map((r) => r.d1_id), [2]);
  assert.deepEqual(await pushOne(on(d1), "lead", "id", 2, csp.fetchImpl), { sent: 0, synced: 0, failed: 0 }); // already synced
  assert.deepEqual(await pushOne(on(d1), "email_capture", "email", "one@example.com", csp.fetchImpl), { sent: 1, synced: 1, failed: 0 });
  assert.equal(csp.deliveries.length, 2);
  const down = await pushOne(on(d1), "lead", "id", 1, fakeCsp({ httpStatus: 500 }).fetchImpl);
  assert.deepEqual(down, { sent: 1, synced: 0, failed: 1, error: "http_500" });
  // schema before 0014: the select fails, the call still resolves
  const { d1: before } = realDb("0013");
  const r = await pushOne(on(before), "lead", "id", 1, csp.fetchImpl);
  assert.match(String(r.error), /csp_changed_at|csp_sync_attempts|no such column/);
  assert.match(String((await drainPending(on(before), csp.fetchImpl)).error), /no such column/);
});
