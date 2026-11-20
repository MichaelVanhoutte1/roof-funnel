import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { chunk, CRON_BATCHES, CSP_PUSH_CRON, drainPending, PUSH_BATCH, pushConfig, pushOne, toRecord } from "../src/csp-push.ts";
import { signStandardWebhook, standardWebhookHeaders } from "../src/webhook-signature.ts";
import worker from "../src/index.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const SECRET = "test-secret-not-real";
const URL_ = "https://csp.example.test/webhook/funnel-leads";
const plain = (o: unknown) => ({ ...(o as Record<string, unknown>) });

/* The real migration chain on a real SQLite, behind the slice of the D1 API the Worker uses. */
function realDb(upTo = "9999"): { db: DatabaseSync; d1: D1Database } {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f.slice(0, 4) <= upTo).sort()) {
    db.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  }
  return { db, d1: wrap(db) };
}

function wrap(db: DatabaseSync): D1Database {
  const exec = (sql: string, args: Array<string | number | null>) => {
    const st = db.prepare(sql);
    return {
      async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      async all() { return { results: st.all(...args).map(plain) }; },
      async first() { const r = st.get(...args); return r ? plain(r) : null; },
    };
  };
  return {
    prepare(sql: string) {
      return { ...exec(sql, []), bind: (...args: Array<string | number | null>) => exec(sql, args) };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

function insertLead(db: DatabaseSync, i: number, extra: Record<string, string | number | null> = {}): void {
  const cols = { status: "full", phone: `+1312555${String(i).padStart(4, "0")}`, name: `Lead ${i}`, ...extra };
  db.prepare(`INSERT INTO leads (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map(() => "?").join(", ")})`).run(...Object.values(cols));
}

const on = (d1: D1Database) => ({ DB: d1, CSP_LEADS_PUSH_ENABLED: "true", CSP_LEADS_URL: URL_, FUNNEL_LEADS_SECRET: SECRET });

type Delivery = { url: string; headers: Record<string, string>; text: string; body: { source: string; schema: number; records: Array<{ kind: string; d1_id: number; row: Record<string, unknown> }> } };

/** A fake CSP: verifies nothing itself, records every delivery and answers `status` per record (or a whole-batch failure). */
function fakeCsp(answer: (r: { kind: string; d1_id: number }) => { status: string; error?: string } | null = () => ({ status: "applied" }), httpStatus = 200) {
  const deliveries: Delivery[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(init?.body);
    const body = JSON.parse(text) as Delivery["body"];
    deliveries.push({ url: String(url), headers: init?.headers as Record<string, string>, text, body });
    if (httpStatus !== 200) return new Response("down", { status: httpStatus });
    const results = body.records.map((r) => { const a = answer(r); return a ? { kind: r.kind, d1_id: r.d1_id, ...a } : null; }).filter(Boolean);
    return new Response(JSON.stringify({ results }), { status: 200 });
  }) as typeof fetch;
  return { deliveries, fetchImpl };
}

const pushState = (db: DatabaseSync, table = "leads") =>
  db.prepare(`SELECT id, csp_changed_at IS NOT NULL AS stamped, csp_synced_updated_at = csp_changed_at AS synced, csp_sync_attempts AS attempts, csp_sync_error AS error FROM ${table} ORDER BY id`).all().map(plain);

/* ---------------- migration 0014 ---------------- */

test("migration 0014 on the full chain: historical rows start pending, triggers stamp every write, push writes never re-stamp", () => {
  const { db } = realDb("0013");
  insertLead(db, 1);
  db.prepare("INSERT INTO email_captures (email) VALUES ('old@example.com')").run();
  db.exec(readFileSync(new URL("0014_csp_lead_push.sql", MIGRATIONS), "utf8"));
  // historical rows: stamped with their updated_at, never pushed → pending (the cron backfills them)
  const old = plain(db.prepare("SELECT updated_at, csp_changed_at, csp_synced_updated_at, csp_sync_attempts FROM leads").get());
  assert.equal(old.csp_changed_at, old.updated_at);
  assert.equal(old.csp_synced_updated_at, null);
  assert.equal(old.csp_sync_attempts, 0);
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
  db.prepare("UPDATE leads SET csp_sync_attempts = csp_sync_attempts + 1, csp_sync_error = 'http_503' WHERE id = 2").run();
  assert.equal(stamp(), s2);
  // email captures: the upsert path (ON CONFLICT DO UPDATE) stamps too
  const cap = () => String(plain(db.prepare("SELECT csp_changed_at FROM email_captures WHERE email = 'new@example.com'").get()).csp_changed_at);
  db.prepare("INSERT INTO email_captures (email, city) VALUES ('new@example.com', 'Tampa')").run();
  const c0 = cap();
  db.prepare("INSERT INTO email_captures (email, city) VALUES ('new@example.com', 'Ocala') ON CONFLICT(email) DO UPDATE SET city = excluded.city").run();
  assert.ok(c0 < cap());
});

test("the pending scan reads the partial index, for both tables", () => {
  const { db } = realDb();
  for (const t of ["leads", "email_captures"]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${t} WHERE (csp_synced_updated_at IS NULL OR csp_synced_updated_at < csp_changed_at) ORDER BY csp_sync_attempts, csp_changed_at, id LIMIT 100`).all().map(plain);
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

test("a record carries every column verbatim (tracking parsed), without the outbox bookkeeping", () => {
  const { db } = realDb();
  insertLead(db, 7, { tracking: '{"utm_source":"facebook","fbclid":"abc"}', credit_score: 701, credit_dti: 16.5, ghl_contact_id: "c-7" });
  insertLead(db, 8, { tracking: "not json" });
  const rows = db.prepare("SELECT * FROM leads ORDER BY id").all().map(plain);
  const r = toRecord("lead", rows[0]);
  assert.equal(r.kind, "lead");
  assert.equal(r.d1_id, 1);
  assert.equal(r.version, rows[0].csp_changed_at);
  assert.deepEqual(r.row.tracking, { utm_source: "facebook", fbclid: "abc" });
  assert.equal(r.row.credit_score, 701);
  assert.equal(r.row.credit_dti, 16.5);
  assert.equal(r.row.ghl_contact_id, "c-7");
  const columns = db.prepare("PRAGMA table_info(leads)").all().map((c) => String(plain(c).name));
  assert.deepEqual(Object.keys(r.row).sort(), columns.filter((c) => !["csp_synced_updated_at", "csp_sync_attempts", "csp_sync_error"].includes(c)).sort());
  assert.equal(columns.length, 79); // 0001–0013 + csp_changed_at + the three outbox columns
  assert.equal(toRecord("lead", rows[1]).row.tracking, null);
  assert.equal(toRecord("lead", { ...rows[1], tracking: null }).row.tracking, null);
  assert.equal(toRecord("lead", { ...rows[1], tracking: "[1,2]" }).row.tracking, null);
  const capCols = db.prepare("PRAGMA table_info(email_captures)").all().map((c) => String(plain(c).name));
  db.prepare("INSERT INTO email_captures (email, tracking) VALUES ('a@example.com', '{\"gclid\":\"g\"}')").run();
  const cap = toRecord("email_capture", plain(db.prepare("SELECT * FROM email_captures").get()));
  assert.deepEqual(Object.keys(cap.row).sort(), capCols.filter((c) => !c.startsWith("csp_sync")).sort());
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

test("pushConfig: off unless the switch is true, the URL is https and the secret is set", () => {
  const d1 = {} as D1Database;
  assert.deepEqual(pushConfig(on(d1)), { url: URL_, secret: SECRET });
  assert.equal(pushConfig({ ...on(d1), CSP_LEADS_PUSH_ENABLED: "false" }), null);
  assert.equal(pushConfig({ ...on(d1), CSP_LEADS_PUSH_ENABLED: undefined }), null);
  assert.equal(pushConfig({ ...on(d1), CSP_LEADS_URL: "" }), null);
  assert.equal(pushConfig({ ...on(d1), CSP_LEADS_URL: "http://csp.example.test/x" }), null);
  assert.equal(pushConfig({ ...on(d1), CSP_LEADS_URL: "not a url" }), null);
  assert.equal(pushConfig({ ...on(d1), FUNNEL_LEADS_SECRET: "" }), null);
});

/* ---------------- the push ---------------- */

test("drain: signed batch to CSP_LEADS_URL, acknowledged rows marked, nothing resent until a row changes", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1, { tracking: '{"utm_campaign":"roof"}' });
  insertLead(db, 2);
  db.prepare("INSERT INTO email_captures (email, name) VALUES ('cap@example.com', 'Cap Person')").run();
  const csp = fakeCsp((r) => ({ status: r.d1_id === 2 ? "unchanged" : "applied" }));
  assert.deepEqual(await drainPending(on(d1), csp.fetchImpl), { sent: 3, synced: 3, failed: 0 });
  assert.equal(csp.deliveries.length, 1);
  const d = csp.deliveries[0];
  assert.equal(d.url, URL_);
  assert.equal(d.headers["Content-Type"], "application/json");
  const expected = createHmac("sha256", SECRET).update(`${d.headers["webhook-id"]}.${d.headers["webhook-timestamp"]}.${d.text}`).digest("base64");
  assert.equal(d.headers["webhook-signature"], `v1,${expected}`);
  assert.ok(Math.abs(Number(d.headers["webhook-timestamp"]) - Date.now() / 1000) < 5);
  assert.equal(d.body.source, "roof-funnel");
  assert.equal(d.body.schema, 1);
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

  // a later write anywhere (here: the credit result) makes the row pending again, and only that row goes
  db.prepare("UPDATE leads SET credit_status = 'success', credit_score = 688 WHERE id = 2").run();
  assert.deepEqual(await drainPending(on(d1), csp.fetchImpl), { sent: 1, synced: 1, failed: 0 });
  assert.deepEqual(csp.deliveries[1].body.records.map((r) => [r.d1_id, r.row.credit_score]), [[2, 688]]);
});

test("a rejected record keeps its error and counts the try; the rest of the batch is acknowledged", async () => {
  const { db, d1 } = realDb();
  for (let i = 1; i <= 3; i++) insertLead(db, i);
  const csp = fakeCsp((r) => (r.d1_id === 2 ? { status: "rejected", error: "invalid_phone" } : { status: "applied" }));
  assert.deepEqual(await drainPending(on(d1), csp.fetchImpl), { sent: 3, synced: 2, failed: 1, error: "rejected: invalid_phone" });
  assert.deepEqual(pushState(db), [
    { id: 1, stamped: 1, synced: 1, attempts: 0, error: null },
    { id: 2, stamped: 1, synced: null, attempts: 1, error: "rejected: invalid_phone" },
    { id: 3, stamped: 1, synced: 1, attempts: 0, error: null },
  ]);
  // a missing or mismatched result is a failure too, never a silent success
  insertLead(db, 4);
  const lost = fakeCsp((r) => (r.d1_id === 4 ? null : { status: "applied" }));
  await drainPending(on(d1), lost.fetchImpl);
  assert.equal(pushState(db)[3].synced, null);
  // once the CSP accepts it, the count and error are cleared
  await drainPending(on(d1), fakeCsp().fetchImpl);
  assert.deepEqual(pushState(db).map((r) => [r.synced, r.attempts, r.error]), [[1, 0, null], [1, 0, null], [1, 0, null], [1, 0, null]]);
});

test("a CSP outage fails the whole batch, counts a try on each row, and ends the run after one request", async () => {
  const { db, d1 } = realDb();
  for (let i = 1; i <= PUSH_BATCH + 20; i++) insertLead(db, i);
  const down = fakeCsp(undefined, 503);
  const s = await drainPending(on(d1), down.fetchImpl);
  assert.deepEqual(s, { sent: PUSH_BATCH, synced: 0, failed: PUSH_BATCH, error: "http_503" });
  assert.equal(down.deliveries.length, 1);
  assert.equal(pushState(db).filter((r) => r.attempts === 1 && r.error === "http_503").length, PUSH_BATCH);
  // network errors and a body that is not the contract's shape fail the same way
  const boom = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.match(String((await drainPending(on(d1), boom)).error), /^network: TypeError: fetch failed/);
  const garbage = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
  assert.equal((await drainPending(on(d1), garbage)).error, "bad_response");
  // rows that failed sort behind the ones that never did: the 20 untouched rows went first on the retries
  assert.deepEqual(pushState(db).slice(PUSH_BATCH).map((r) => r.attempts), Array(20).fill(2));
});

test("cron: oldest first, PUSH_BATCH per request, CRON_BATCHES per run, leads before email captures; the backlog drains over runs", async () => {
  const { db, d1 } = realDb();
  for (let i = 1; i <= 250; i++) insertLead(db, i);
  for (let i = 1; i <= 80; i++) db.prepare("INSERT INTO email_captures (email) VALUES (?)").run(`c${i}@example.com`);
  const csp = fakeCsp();
  const first = await drainPending(on(d1), csp.fetchImpl);
  assert.equal(CRON_BATCHES, 3);
  assert.deepEqual(first, { sent: 300, synced: 300, failed: 0 });
  assert.deepEqual(csp.deliveries.map((d) => d.body.records.length), [100, 100, 100]);
  assert.deepEqual(csp.deliveries[0].body.records.slice(0, 3).map((r) => r.d1_id), [1, 2, 3]);
  // the third request: the last 50 leads, then the first 50 captures
  const third = csp.deliveries[2].body.records;
  assert.deepEqual([third[0].kind, third[0].d1_id, third[49].d1_id, third[50].kind, third[50].d1_id], ["lead", 201, 250, "email_capture", 1]);
  assert.deepEqual(await drainPending(on(d1), csp.fetchImpl), { sent: 30, synced: 30, failed: 0 });
  assert.deepEqual(await drainPending(on(d1), csp.fetchImpl), { sent: 0, synced: 0, failed: 0 });
  assert.equal(csp.deliveries.length, 4);
});

test("a row written while its push is in flight is not marked: it goes again with the newer data", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1);
  const deliveries: number[] = [];
  const racing = (async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Delivery["body"];
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

test("off switch, missing URL or secret: no request, no write", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1);
  const csp = fakeCsp();
  for (const env of [{ DB: d1 }, { ...on(d1), CSP_LEADS_PUSH_ENABLED: "false" }, { ...on(d1), CSP_LEADS_URL: "" }, { ...on(d1), FUNNEL_LEADS_SECRET: undefined }]) {
    assert.deepEqual(await drainPending(env, csp.fetchImpl), { sent: 0, synced: 0, failed: 0, skipped: "off" });
    assert.deepEqual(await pushOne(env, "lead", "id", 1, csp.fetchImpl), { sent: 0, synced: 0, failed: 0, skipped: "off" });
  }
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
  const down = await pushOne(on(d1), "lead", "id", 1, fakeCsp(undefined, 500).fetchImpl);
  assert.deepEqual(down, { sent: 1, synced: 0, failed: 1, error: "http_500" });
  // schema before 0014: the select fails, the call still resolves
  const { d1: before } = realDb("0013");
  const r = await pushOne(on(before), "lead", "id", 1, csp.fetchImpl);
  assert.match(String(r.error), /csp_synced_updated_at|no such column/);
  assert.match(String((await drainPending(on(before), csp.fetchImpl)).error), /no such column/);
});

/* ---------------- wiring in the Worker ---------------- */

function ctx() {
  const waits: Promise<unknown>[] = [];
  return { waits, ctx: { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext };
}

test("scheduled: the push cron runs the drain only (never the outcome sync)", async () => {
  const { d1 } = realDb();
  const c = ctx();
  await worker.scheduled!({ cron: CSP_PUSH_CRON, scheduledTime: Date.now(), noRetry() {} } as ScheduledController, { DB: d1 } as never, c.ctx);
  assert.equal(c.waits.length, 1);
  assert.deepEqual(await c.waits[0], { sent: 0, synced: 0, failed: 0, skipped: "off" });
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.ok(toml.includes(`"${CSP_PUSH_CRON}"`), "the cron is in wrangler.toml verbatim");
  assert.match(toml, /^CSP_LEADS_PUSH_ENABLED = "false"$/m);
  assert.match(toml, /^CSP_LEADS_URL = ""$/m);
});

test("POST /contact stores the capture and pushes it in the background; the visitor's answer does not wait on the CSP", async () => {
  const { db, d1 } = realDb();
  const seen: Delivery["body"][] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Delivery["body"];
    seen.push(body);
    return new Response(JSON.stringify({ results: body.records.map((r) => ({ kind: r.kind, d1_id: r.d1_id, status: "applied" })) }), { status: 200 });
  }) as typeof fetch;
  try {
    const env = { ...on(d1), ALLOWED_ORIGINS: "https://funnel.example.test", ALLOWED_COUNTRIES: "US", GHL_CONTACT_SYNC: "qualified" };
    const c = ctx();
    const res = await worker.fetch!(new Request("https://api.example.test/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://funnel.example.test", "cf-ipcountry": "US" },
      body: JSON.stringify({ email: "visitor@realmail.com", name: "Dana Rivers", city: "Tampa", tracking: { utm_source: "facebook" } }),
    }) as never, env as never, c.ctx);
    assert.equal(res.status, 202);
    await Promise.all(c.waits);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].records.map((r) => [r.kind, r.row.email, r.row.city]), [["email_capture", "visitor@realmail.com", "Tampa"]]);
    assert.deepEqual(seen[0].records[0].row.tracking, { utm_source: "facebook" });
    assert.equal(pushState(db, "email_captures")[0].synced, 1);
  } finally { globalThis.fetch = realFetch; }
});
