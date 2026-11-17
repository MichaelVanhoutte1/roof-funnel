/**
 * Abandoned survey starts → GHL.
 *
 * Android Chrome's autofill fills the hidden name / email / phone inputs while the visitor is still on the city
 * question (every step is in the DOM; only Safari hides inactive ones), and the phone field's idle save then banks
 * a partial lead with no answers. 41 such rows by 2026-11-17, none from iOS. They never reach the capital question,
 * so the qualified contact sync never touches them. Michael (2026-11-17): work them anyway — once the survey has had
 * time to be finished, push each one to GHL tagged `abandoned-survey` so a setter can call.
 *
 * Runs as its own cron (ABANDONED_CRON) so it never shares a subrequest budget with the outcome sync or the Cortana
 * pass. Per lead: one claim write, one GHL upsert, one result write (+ the one-off custom-field lookup).
 */
import { upsertSurveyContact, type ContactsConfig } from "./ghl.ts";

/** The third cron in wrangler.toml, verbatim. */
export const ABANDONED_CRON = "2-52/10 * * * *";
export const ABANDONED_TAG = "abandoned-survey";
/** Leads per pass: 15 × (1 fetch + 2 D1) + 2 selects + ≤ 2 field lookups ≈ 49 of the 50 subrequests. */
export const ABANDONED_BATCH = 15;
/** A visitor may still finish the survey; after this long a start with no capital answer counts as abandoned. */
export const SETTLE = "-30 minutes";
/** A failed or stranded claim is retried after this long. */
export const RETRY = "-6 hours";
/** Tries per lead before it is left alone. */
export const MAX_ATTEMPTS = 8;

const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export type AbandonedEnv = { DB: D1Database; GHL_PIT?: string; GHL_LOCATION_ID?: string; GHL_CONTACT_SYNC?: string };
export type AbandonedRow = {
  id: number; name: string | null; email: string | null; phone: string; city: string | null;
  timeline: string | null; business_owner: string | null;
};
export type AbandonedSummary = { candidates: number; synced: number; failed: number; skipped?: string };

/**
 * A partial save with no capital answer, old enough to count as abandoned, not yet in GHL, whose phone never
 * finished the survey in another row (then the full submit's own sync owns the contact), and not claimed recently.
 */
export const ABANDONED_WHERE = `l.status = 'partial' AND l.capital IS NULL AND l.ghl_contact_id IS NULL
  AND l.created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','${SETTLE}')
  AND l.ghl_abandoned_attempts < ${MAX_ATTEMPTS}
  AND (l.ghl_abandoned_at IS NULL OR l.ghl_abandoned_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','${RETRY}'))
  AND NOT EXISTS (SELECT 1 FROM leads o WHERE o.phone = l.phone AND o.id <> l.id AND (o.status = 'full' OR o.ghl_contact_id IS NOT NULL))`;

type Upsert = (cfg: ContactsConfig, c: Parameters<typeof upsertSurveyContact>[1]) => Promise<string>;

/** One pass: claim, upsert, record — per lead, oldest first. Never rejects; failures are counted and retried later. */
export async function syncAbandoned(env: AbandonedEnv, upsert: Upsert = upsertSurveyContact, batch: number = ABANDONED_BATCH): Promise<AbandonedSummary> {
  const summary: AbandonedSummary = { candidates: 0, synced: 0, failed: 0 };
  if ((env.GHL_CONTACT_SYNC ?? "qualified").toLowerCase() === "off") return { ...summary, skipped: "GHL_CONTACT_SYNC=off" };
  if (!env.GHL_PIT || !env.GHL_LOCATION_ID) return { ...summary, skipped: "no GHL token" };
  const cfg: ContactsConfig = { token: env.GHL_PIT, locationId: env.GHL_LOCATION_ID };
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.name, l.email, l.phone, l.city, l.timeline, l.business_owner FROM leads l WHERE ${ABANDONED_WHERE} ORDER BY l.id LIMIT ?1`,
  ).bind(batch).all<AbandonedRow>();
  summary.candidates = results.length;
  for (const row of results) {
    const claim = await env.DB.prepare(
      `UPDATE leads SET ghl_abandoned_at = ${SQL_NOW}, ghl_abandoned_attempts = ghl_abandoned_attempts + 1
       WHERE id = ?1 AND ghl_contact_id IS NULL AND (ghl_abandoned_at IS NULL OR ghl_abandoned_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','${RETRY}'))`,
    ).bind(row.id).run();
    if ((claim.meta.changes ?? 0) === 0) continue; // another pass has it
    try {
      const id = await upsert(cfg, {
        name: row.name, email: row.email, phone: row.phone, city: row.city,
        timeline: row.timeline, business_owner: row.business_owner, capital: null, qualified: null, tags: [ABANDONED_TAG],
      });
      await env.DB.prepare("UPDATE leads SET ghl_contact_id = ?1, ghl_error = NULL WHERE id = ?2").bind(id, row.id).run();
      summary.synced++;
      console.log("[abandoned] lead", row.id, "→ GHL contact", id);
    } catch (err) {
      summary.failed++;
      const text = String(err).slice(0, 300);
      await env.DB.prepare("UPDATE leads SET ghl_error = ?1 WHERE id = ?2").bind(text, row.id).run().catch(() => {});
      console.error("[abandoned] lead", row.id, "GHL upsert failed:", text);
    }
  }
  console.log("[abandoned]", JSON.stringify(summary));
  return summary;
}
