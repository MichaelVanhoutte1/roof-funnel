/**
 * D1 read budget (2026-11-24: an OR over nullable params made SQLite scan video_watches on every link, 7.2M rows read in
 * a day, over D1's free daily limit). Every hot lookup must SEARCH an index, never SCAN a table.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { realDb } from "./csp-push-helpers.ts";

function plan(sql: string): string {
  const { db } = realDb();
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
}

const HOT: Array<[string, string]> = [
  ["link by viewer key", "UPDATE video_watches SET lead_id = 1 WHERE viewer_key = 'x' AND lead_id IS NULL"],
  ["link by Cortana id", "UPDATE video_watches SET lead_id = 1 WHERE ak_tid = 'x' AND lead_id IS NULL"],
  ["link by visitor id", "UPDATE video_watches SET lead_id = 1 WHERE srr_vid = 'x' AND lead_id IS NULL"],
  ["linked leads of a viewer", "SELECT DISTINCT lead_id FROM (SELECT lead_id FROM video_watches WHERE viewer_key = 'x' AND lead_id IS NOT NULL UNION SELECT lead_id FROM video_watches WHERE ak_tid = 'y' AND lead_id IS NOT NULL) LIMIT 5"],
  ["outcome sync: lead by setter appointment", "SELECT MAX(id) FROM leads WHERE appointment_id = 'x'"],
  ["outcome sync: lead by closer appointment", "SELECT MAX(id) FROM leads WHERE closer_appointment_id = 'x'"],
];

for (const [name, sql] of HOT) {
  test(`${name}: an index search, not a table scan`, () => {
    const p = plan(sql);
    assert.doesNotMatch(p, /SCAN (video_watches|leads)\b(?! USING)/, p);
    assert.match(p, /USING (COVERING )?INDEX/, p);
    // Walking the lead_id index for `lead_id IS NULL` reads every unlinked row: the 2026-11-24 bug in disguise.
    assert.doesNotMatch(p, /video_watches_lead_idx \(lead_id=\?\)/, p);
  });
}
