-- SimpleCheck soft credit check on qualified, completed applications.
-- credit_consent = the disclosure version shown under the submit button when the visitor submitted
-- (NULL = submitted without it, never checked). The consent IP is the row's existing `ip`.
ALTER TABLE leads ADD COLUMN credit_consent TEXT;
ALTER TABLE leads ADD COLUMN credit_consent_at TEXT;
-- 'pending' | 'success' | 'invalid' | 'queued' | 'skipped' | 'error'
ALTER TABLE leads ADD COLUMN credit_status TEXT;
ALTER TABLE leads ADD COLUMN credit_checked_at TEXT;
ALTER TABLE leads ADD COLUMN credit_error TEXT;
ALTER TABLE leads ADD COLUMN credit_prequal_id INTEGER;
ALTER TABLE leads ADD COLUMN credit_score INTEGER;
ALTER TABLE leads ADD COLUMN credit_offer_status TEXT;
ALTER TABLE leads ADD COLUMN credit_offer_amount_1 TEXT;
ALTER TABLE leads ADD COLUMN credit_offer_amount_2 TEXT;
ALTER TABLE leads ADD COLUMN credit_dti REAL;           -- percent (16 = 16%)
ALTER TABLE leads ADD COLUMN credit_income INTEGER;
ALTER TABLE leads ADD COLUMN credit_household_income INTEGER;
ALTER TABLE leads ADD COLUMN credit_freeze TEXT;
