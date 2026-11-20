import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CSP_PUSH_CRON } from "../src/csp-push.ts";
import worker from "../src/index.ts";
import { ctx, fakeCsp, insertLead, on, plain, pushState, realDb, settleAll, URL_ } from "./csp-push-helpers.ts";

const ORIGIN = "https://funnel.example.test";

/** Routes the Worker's global fetch: the CSP to the fake CSP, GHL to canned answers, anything else fails the test. */
function withFetch(csp: ReturnType<typeof fakeCsp>, ghl: (path: string, init?: RequestInit) => unknown = () => { throw new Error("no GHL expected"); }) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    if (url === URL_) return csp.fetchImpl(url, init);
    if (url.startsWith("https://services.leadconnectorhq.com")) return new Response(JSON.stringify(ghl(url.slice("https://services.leadconnectorhq.com".length), init)), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

const post = (path: string, body: unknown) => new Request(`https://api.example.test${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN, "cf-ipcountry": "US", "CF-Connecting-IP": "203.0.113.7" },
  body: JSON.stringify(body),
});

test("scheduled: the push cron runs the drain only (never the outcome sync); wrangler.toml keeps it off", async () => {
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
  const csp = fakeCsp();
  const restore = withFetch(csp);
  try {
    const env = { ...on(d1), ALLOWED_ORIGINS: ORIGIN, ALLOWED_COUNTRIES: "US", GHL_CONTACT_SYNC: "qualified" };
    const c = ctx();
    const res = await worker.fetch!(post("/contact", { email: "visitor@realmail.com", name: "Dana Rivers", city: "Tampa", tracking: { utm_source: "facebook" } }) as never, env as never, c.ctx);
    assert.equal(res.status, 202);
    await settleAll(c.waits);
    assert.equal(csp.deliveries.length, 1);
    assert.deepEqual(csp.deliveries[0].body.records.map((r) => [r.kind, r.row.email, r.row.city]), [["email_capture", "visitor@realmail.com", "Tampa"]]);
    assert.deepEqual(csp.deliveries[0].body.records[0].row.tracking, { utm_source: "facebook" });
    assert.equal(pushState(db, "email_captures")[0].synced, 1);
  } finally { restore(); }
});

test("POST /lead pushes the stored lead once its route is settled, with the final route", async () => {
  const { db, d1 } = realDb();
  const csp = fakeCsp();
  const restore = withFetch(csp);
  try {
    const env = { ...on(d1), ALLOWED_ORIGINS: ORIGIN, ALLOWED_COUNTRIES: "US", GHL_CONTACT_SYNC: "off" };
    const c = ctx();
    const res = await worker.fetch!(post("/lead", {
      name: "Dana Rivers", email: "dana@realmail.com", phone: "(312) 867-2291", city: "Tampa",
      timeline: "Right away", business_owner: "I own a business", capital: "No, I do not qualify to book a call.",
    }) as never, env as never, c.ctx);
    assert.equal(res.status, 200);
    const answer = (await res.json()) as { route: string; lead_id: number };
    await settleAll(c.waits);
    const stored = plain(db.prepare("SELECT id, route, phone FROM leads").get());
    assert.equal(answer.lead_id, stored.id);
    const leads = csp.deliveries.flatMap((d) => d.body.records).filter((r) => r.kind === "lead");
    assert.ok(leads.length >= 1);
    const last = leads[leads.length - 1];
    assert.deepEqual([last.d1_id, last.row.route, last.row.phone], [stored.id, stored.route, "+13128672291"]);
    assert.equal(last.row.route, answer.route);
    assert.ok(!("credit_identity" in last.row));
    assert.equal(pushState(db)[0].synced, 1);
  } finally { restore(); }
});

test("POST /book pushes the lead with its booking (appointment and GHL contact id) right away", async () => {
  const { db, d1 } = realDb();
  insertLead(db, 1, { phone: "+13125550187", route: "calendar", qualified: 1, email: "dana@realmail.com", capital: "Yes, I will use financing." });
  db.prepare("UPDATE leads SET csp_synced_updated_at = csp_changed_at").run(); // already on the CSP before the booking
  const csp = fakeCsp();
  const restore = withFetch(csp, (path, init) => {
    if (path.startsWith("/calendars/events/appointments")) return { id: "appt-1" };
    if (path.startsWith("/calendars/")) return { calendar: { slotDuration: 30, slotDurationUnit: "mins" } };
    if (path.startsWith("/contacts/upsert")) return { contact: { id: "ct-1" } };
    if (path.includes("/customFields")) return init?.method === "POST" ? { customField: { id: "f" } } : { customFields: [] };
    throw new Error(`unexpected GHL ${path}`);
  });
  try {
    const env = { ...on(d1), ALLOWED_ORIGINS: ORIGIN, ALLOWED_COUNTRIES: "US", GHL_PIT: "pit-placeholder", GHL_LOCATION_ID: "loc-test", GHL_BOOKING_CALENDAR_ID: "cal-test" };
    const c = ctx();
    const start = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const res = await worker.fetch!(post("/book", { phone: "3125550187", start, tz: "America/Chicago" }) as never, env as never, c.ctx);
    assert.equal(res.status, 200);
    await settleAll(c.waits);
    assert.equal(csp.deliveries.length, 1);
    const [r] = csp.deliveries[0].body.records;
    assert.deepEqual([r.kind, r.d1_id, r.row.closer_appointment_id, r.row.ghl_contact_id, r.row.appointment_tz], ["lead", 1, "appt-1", "ct-1", "America/Chicago"]);
    assert.equal(pushState(db)[0].synced, 1);
  } finally { restore(); }
});
