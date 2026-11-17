-- Abandoned survey starts (a phone banked by autofill, capital never answered) are pushed to GHL by a cron pass
-- (worker/src/abandoned.ts). The claim stamp and attempt count keep one pass from racing the next and stop a
-- lead GHL keeps refusing after MAX_ATTEMPTS.
ALTER TABLE leads ADD COLUMN ghl_abandoned_at TEXT;
ALTER TABLE leads ADD COLUMN ghl_abandoned_attempts INTEGER NOT NULL DEFAULT 0;
