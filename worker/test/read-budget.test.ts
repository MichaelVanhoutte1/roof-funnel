/**
 * D1 read budget (2026-11-24: an OR over nullable params made SQLite scan video_watches on every link, 7.2M rows read in
 * a day, over D1's free daily limit). Every hot lookup must SEARCH an index, never SCAN a table. The video watch lookups
 * left with the Worker's video code (tracking moved into the CSP, 2026-11-24).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { realDb } from "./csp-push-helpers.ts";

function plan(sql: string): string {
  const { db } = realDb();
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
}

const HOT: Array<[string, string]> = [
  ["outcome sync: lead by setter appointment", "SELECT MAX(id) FROM leads WHERE appointment_id = 'x'"],
  ["outcome sync: lead by closer appointment", "SELECT MAX(id) FROM leads WHERE closer_appointment_id = 'x'"],
];

for (const [name, sql] of HOT) {
  test(`${name}: an index search, not a table scan`, () => {
    const p = plan(sql);
    assert.doesNotMatch(p, /SCAN (video_watches|leads)\b(?! USING)/, p);
    assert.match(p, /USING (COVERING )?INDEX/, p);
  });
}
