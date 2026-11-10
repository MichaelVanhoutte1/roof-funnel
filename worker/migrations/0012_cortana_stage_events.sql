-- Cortana stage events: one row per (lead, event) once that step has been posted to Cortana.
-- sent_at NULL = claimed (in flight, or the webhook failed); a claim older than an hour is taken over by the next
-- pass, at most MAX_ATTEMPTS times, so a lead Cortana keeps refusing backs off hourly and then stops.
CREATE TABLE IF NOT EXISTS cortana_sent (
  lead_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  attempts INTEGER NOT NULL DEFAULT 1,
  sent_at TEXT,
  PRIMARY KEY (lead_id, event)
);
-- When the lead booked its own setter call through the funnel (POST /book). The GHL sync never sets
-- appointment_tz, /book always has, so that column tells the funnel's own bookings apart for the backfill.
-- updated_at is the closest stamp on hand (a later survey re-save bumps it too, so a few are late by that much).
ALTER TABLE leads ADD COLUMN booked_at TEXT;
UPDATE leads SET booked_at = updated_at WHERE appointment_tz IS NOT NULL AND booked_at IS NULL;
