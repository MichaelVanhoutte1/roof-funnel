import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ABANDONED_TAG, clearAbandonedTag, MAX_ATTEMPTS, syncAbandoned } from "../src/abandoned.ts";
import { upsertSurveyContact } from "../src/ghl.ts";

const plain = (o: unknown) => ({ ...(o as Record<string, unknown>) });

/* The real SQL on a real SQLite: the lead columns the pass reads, then migration 0013 as written. */
function realDb(): { db: DatabaseSync; d1: D1Database } {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE leads (
    id INTEGER PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours')), status TEXT NOT NULL,
    name TEXT, email TEXT, phone TEXT NOT NULL, city TEXT, timeline TEXT, business_owner TEXT, capital TEXT,
    ghl_contact_id TEXT, ghl_error TEXT)`);
  db.exec(readFileSync(new URL("../migrations/0013_abandoned_sync.sql", import.meta.url), "utf8"));
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

type L = { id: number; status?: string; phone?: string; capital?: string | null; ghl_contact_id?: string | null; age?: string; name?: string | null };
function insert(db: DatabaseSync, l: L): void {
  db.prepare(`INSERT INTO leads (id, created_at, status, name, email, phone, city, timeline, business_owner, capital, ghl_contact_id)
    VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now',?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(l.id, l.age ?? "-2 hours", l.status ?? "partial", l.name === undefined ? `Lead ${l.id}` : l.name, `l${l.id}@example.com`, l.phone ?? `+1312555${String(l.id).padStart(4, "0")}`,
      "Tampa", null, l.id % 2 ? "I own a business" : null, l.capital ?? null, l.ghl_contact_id ?? null);
}

const env = (d1: D1Database) => ({ DB: d1, GHL_PIT: "pit", GHL_LOCATION_ID: "loc" });

test("syncs settled abandoned starts only: fresh, answered, already-in-GHL and finished-elsewhere rows are left alone", async () => {
  const { db, d1 } = realDb();
  insert(db, { id: 1 });                                            // abandoned 2 h ago → sync
  insert(db, { id: 2, age: "-5 minutes" });                         // may still finish → wait
  insert(db, { id: 3, capital: "Yes, I have $20,000+ available right now." }); // answered → the qualified sync owns it
  insert(db, { id: 4, ghl_contact_id: "already" });                 // in GHL
  insert(db, { id: 5, phone: "+13125559999" });                     // same phone finished the survey in row 6
  insert(db, { id: 6, phone: "+13125559999", status: "full", capital: "No, I do not qualify to book a call." });
  insert(db, { id: 7 });                                            // abandoned → sync
  const calls: Array<Record<string, unknown>> = [];
  const upsert = async (_cfg: unknown, c: Record<string, unknown>) => { calls.push(c); return `ghl-${c.phone}`; };
  const s = await syncAbandoned(env(d1), upsert as never);
  assert.deepEqual(s, { candidates: 2, synced: 2, failed: 0 });
  assert.deepEqual(calls.map((c) => c.phone), ["+13125550001", "+13125550007"]);
  assert.deepEqual(calls[0].tags, [ABANDONED_TAG]);
  assert.equal(calls[0].qualified, null);
  assert.equal(calls[0].capital, null);
  assert.equal(calls[0].business_owner, "I own a business");
  assert.deepEqual(db.prepare("SELECT id, ghl_contact_id, ghl_abandoned_attempts FROM leads WHERE ghl_contact_id IS NOT NULL ORDER BY id").all().map(plain), [
    { id: 1, ghl_contact_id: "ghl-+13125550001", ghl_abandoned_attempts: 1 },
    { id: 4, ghl_contact_id: "already", ghl_abandoned_attempts: 0 },
    { id: 7, ghl_contact_id: "ghl-+13125550007", ghl_abandoned_attempts: 1 },
  ]);
  // a second pass finds nothing new
  assert.deepEqual(await syncAbandoned(env(d1), upsert as never), { candidates: 0, synced: 0, failed: 0 });
});

test("a failed upsert is recorded, retried after six hours, and given up after MAX_ATTEMPTS", async () => {
  const { db, d1 } = realDb();
  insert(db, { id: 1 });
  const failing = async () => { throw new Error("GHL POST /contacts/upsert → 422: bad email"); };
  assert.deepEqual(await syncAbandoned(env(d1), failing as never), { candidates: 1, synced: 0, failed: 1 });
  assert.deepEqual(plain(db.prepare("SELECT ghl_contact_id, ghl_abandoned_attempts, ghl_error FROM leads").get()),
    { ghl_contact_id: null, ghl_abandoned_attempts: 1, ghl_error: "Error: GHL POST /contacts/upsert → 422: bad email" });
  // still inside the retry hold: not a candidate
  assert.deepEqual(await syncAbandoned(env(d1), failing as never), { candidates: 0, synced: 0, failed: 0 });
  const age = (h: number) => db.prepare("UPDATE leads SET ghl_abandoned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now',?)").run(`-${h} hours`);
  age(7);
  assert.deepEqual(await syncAbandoned(env(d1), failing as never), { candidates: 1, synced: 0, failed: 1 });
  db.prepare("UPDATE leads SET ghl_abandoned_attempts = ?").run(MAX_ATTEMPTS);
  age(7);
  assert.deepEqual(await syncAbandoned(env(d1), failing as never), { candidates: 0, synced: 0, failed: 0 });
});

test("a visitor who finishes while the pass is working through the batch is not pushed as abandoned", async () => {
  const { db, d1 } = realDb();
  insert(db, { id: 1 });
  insert(db, { id: 2 });
  const calls: number[] = [];
  // While lead 1 is on its way to GHL, lead 2 completes the survey: the full submit rewrites the same row.
  const upsert = async (_cfg: unknown, c: Record<string, unknown>) => {
    calls.push(Number(String(c.phone).slice(-4)));
    db.prepare("UPDATE leads SET status = 'full', capital = 'Yes, I will use financing.' WHERE id = 2").run();
    return "ghl-1";
  };
  assert.deepEqual(await syncAbandoned(env(d1), upsert as never), { candidates: 2, synced: 1, failed: 0 });
  assert.deepEqual(calls, [1]);
  assert.deepEqual(plain(db.prepare("SELECT ghl_contact_id, ghl_abandoned_at, ghl_abandoned_attempts FROM leads WHERE id = 2").get()),
    { ghl_contact_id: null, ghl_abandoned_at: null, ghl_abandoned_attempts: 0 });
});

test("clearAbandonedTag removes the tag only from contacts this module pushed, and never throws", async () => {
  const { db, d1 } = realDb();
  insert(db, { id: 1, ghl_contact_id: "c-pushed" });
  db.prepare("UPDATE leads SET ghl_abandoned_at = '2026-11-17T00:00:00.000Z' WHERE id = 1").run();
  insert(db, { id: 2, ghl_contact_id: "c-qualified" });   // synced by the qualified path, never tagged
  insert(db, { id: 3 });                                    // not in GHL at all
  const removed: Array<[string, string[]]> = [];
  const remove = async (_cfg: unknown, id: string, tags: string[]) => { removed.push([id, tags]); };
  assert.equal(await clearAbandonedTag(env(d1), 1, remove as never), true);
  assert.equal(await clearAbandonedTag(env(d1), 2, remove as never), false);
  assert.equal(await clearAbandonedTag(env(d1), 3, remove as never), false);
  assert.equal(await clearAbandonedTag(env(d1), 99, remove as never), false);
  assert.deepEqual(removed, [["c-pushed", [ABANDONED_TAG]]]);
  assert.equal(await clearAbandonedTag(env(d1), 1, (async () => { throw new Error("GHL 500"); }) as never), false);
  assert.equal(await clearAbandonedTag({ DB: d1 }, 1, remove as never), false);
  // migration 0013 not applied yet: the missing column is swallowed, the capture path is unaffected
  const bare = new DatabaseSync(":memory:");
  bare.exec("CREATE TABLE leads (id INTEGER PRIMARY KEY, ghl_contact_id TEXT)");
  const bareD1 = { prepare: (sql: string) => ({ bind: (...a: Array<string | number | null>) => ({ async first() { return bare.prepare(sql).get(...a) ?? null; } }) }) } as unknown as D1Database;
  assert.equal(await clearAbandonedTag(env(bareD1), 1, remove as never), false);
});

test("batch limit and the off switch", async () => {
  const { db, d1 } = realDb();
  for (let i = 1; i <= 4; i++) insert(db, { id: i });
  const ok = async (_c: unknown, c: Record<string, unknown>) => `g-${c.phone}`;
  assert.deepEqual(await syncAbandoned(env(d1), ok as never, 3), { candidates: 3, synced: 3, failed: 0 });
  assert.deepEqual(await syncAbandoned(env(d1), ok as never, 3), { candidates: 1, synced: 1, failed: 0 });
  assert.deepEqual(await syncAbandoned({ ...env(d1), GHL_CONTACT_SYNC: "off" }, ok as never), { candidates: 0, synced: 0, failed: 0, skipped: "GHL_CONTACT_SYNC=off" });
  assert.deepEqual(await syncAbandoned({ DB: d1 }, ok as never), { candidates: 0, synced: 0, failed: 0, skipped: "no GHL token" });
});

test("upsertSurveyContact: extra tags ride along, no qualified tag when qualified is null", async () => {
  const seen: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (u.includes("/customFields")) return new Response(JSON.stringify({ customFields: [] }), { status: 200 });
    if (u.includes("/contacts/upsert")) return new Response(JSON.stringify({ contact: { id: "c-1" } }), { status: 200 });
    return new Response(JSON.stringify({ customField: { id: `f-${seen.length}` } }), { status: 200 });
  }) as typeof fetch;
  try {
    const id = await upsertSurveyContact({ token: "t", locationId: "loc-tags" }, { name: "Ada Lovelace", phone: "+13125550100", city: "Tampa", qualified: null, tags: [ABANDONED_TAG] });
    assert.equal(id, "c-1");
    const upsert = seen.find((s) => s.url.endsWith("/contacts/upsert"))!.body!;
    assert.deepEqual(upsert.tags, ["funnel-application", ABANDONED_TAG]);
    assert.equal(upsert.firstName, "Ada");
    assert.equal(upsert.lastName, "Lovelace");
  } finally { globalThis.fetch = realFetch; }
});
