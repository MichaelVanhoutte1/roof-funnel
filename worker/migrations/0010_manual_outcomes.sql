-- Outcomes set by hand on the admin Appointments page. NULL = automatic (call log / Meet / Fathom / GHL stage).
-- 'showed' | 'no_show' for the two calls; won_manual 0 overrides a GHL "Won" that did not happen, 1 records a close
-- GHL does not know about (with its amount and day).
ALTER TABLE leads ADD COLUMN setter_attended_manual TEXT;
ALTER TABLE leads ADD COLUMN closer_attended_manual TEXT;
ALTER TABLE leads ADD COLUMN won_manual INTEGER;
ALTER TABLE leads ADD COLUMN cash_manual REAL;
ALTER TABLE leads ADD COLUMN close_date_manual TEXT;
ALTER TABLE leads ADD COLUMN outcome_manual_at TEXT;
