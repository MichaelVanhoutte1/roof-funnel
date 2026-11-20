-- Funnel → CSP lead push (worker/src/csp-push.ts). D1 stays the funnel's working store and outbox; every lead and email
-- capture is pushed, signed, to the CSP, which keeps them as the system of record.
--
-- csp_changed_at is the row's change stamp and the CSP's ordering key (schema 2): the triggers below move it forward
-- on every write to a row, from any write site (the lead upsert, route, credit result, identity wipe, phone lookup,
-- GHL status, booking, outcome sync, manual outcomes), without touching updated_at, whose meaning other code relies on
-- (the credit problem notice counts rows by it). It is never behind updated_at, never NULL, and always moves forward,
-- at least by 1 ms. The pusher sends the row with it.
-- csp_synced_updated_at = the csp_changed_at the CSP last acknowledged (applied or unchanged); NULL = never pushed.
-- A row is pending while csp_synced_updated_at is NULL or older than csp_changed_at. Every row that exists when this
-- runs starts pending, so the push cron is also the one-off backfill of every historical row.
-- csp_sync_attempts / csp_sync_error = failed tries since the last success, and the last failure.
-- csp_next_attempt_at = a record the CSP refused is not retried before this (exponential backoff, at most 24 h); any
-- new write to the row clears it, so a corrected row goes straight away. NULL = due now.
ALTER TABLE leads ADD COLUMN csp_changed_at TEXT;
ALTER TABLE leads ADD COLUMN csp_synced_updated_at TEXT;
ALTER TABLE leads ADD COLUMN csp_sync_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN csp_sync_error TEXT;
ALTER TABLE leads ADD COLUMN csp_next_attempt_at TEXT;
UPDATE leads SET csp_changed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE email_captures ADD COLUMN csp_changed_at TEXT;
ALTER TABLE email_captures ADD COLUMN csp_synced_updated_at TEXT;
ALTER TABLE email_captures ADD COLUMN csp_sync_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_captures ADD COLUMN csp_sync_error TEXT;
ALTER TABLE email_captures ADD COLUMN csp_next_attempt_at TEXT;
UPDATE email_captures SET csp_changed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- A new row is stamped once it exists. ALTER TABLE cannot give the column a non-constant default. SQLite's max()
-- is NULL when any argument is, so an unparsable updated_at counts as 0 (the stamp is then simply "now").
CREATE TRIGGER IF NOT EXISTS leads_csp_stamp_insert AFTER INSERT ON leads
BEGIN
  UPDATE leads SET csp_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', max(julianday('now'), COALESCE(julianday(NEW.updated_at), 0)))
  WHERE id = NEW.id;
END;
-- Any update that leaves the five push columns alone is a change to the lead. The pusher's own writes always change
-- csp_synced_updated_at or csp_sync_attempts, and this trigger's write changes csp_changed_at, so neither re-fires it.
CREATE TRIGGER IF NOT EXISTS leads_csp_stamp_update AFTER UPDATE ON leads
WHEN NEW.csp_changed_at IS OLD.csp_changed_at AND NEW.csp_synced_updated_at IS OLD.csp_synced_updated_at
  AND NEW.csp_sync_attempts IS OLD.csp_sync_attempts AND NEW.csp_sync_error IS OLD.csp_sync_error
  AND NEW.csp_next_attempt_at IS OLD.csp_next_attempt_at
BEGIN
  UPDATE leads SET csp_next_attempt_at = NULL, csp_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', max(julianday('now'),
    COALESCE(julianday(NEW.updated_at), 0), COALESCE(julianday(OLD.csp_changed_at) + 1.0 / 86400000, 0)))
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS email_captures_csp_stamp_insert AFTER INSERT ON email_captures
BEGIN
  UPDATE email_captures SET csp_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', max(julianday('now'), COALESCE(julianday(NEW.updated_at), 0)))
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS email_captures_csp_stamp_update AFTER UPDATE ON email_captures
WHEN NEW.csp_changed_at IS OLD.csp_changed_at AND NEW.csp_synced_updated_at IS OLD.csp_synced_updated_at
  AND NEW.csp_sync_attempts IS OLD.csp_sync_attempts AND NEW.csp_sync_error IS OLD.csp_sync_error
  AND NEW.csp_next_attempt_at IS OLD.csp_next_attempt_at
BEGIN
  UPDATE email_captures SET csp_next_attempt_at = NULL, csp_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', max(julianday('now'),
    COALESCE(julianday(NEW.updated_at), 0), COALESCE(julianday(OLD.csp_changed_at) + 1.0 / 86400000, 0)))
  WHERE id = NEW.id;
END;

-- The pending scan (fewest failed tries first, then oldest change): a partial index holds only the pending rows, so
-- the scan never walks the rows already pushed. The query repeats this WHERE verbatim so the planner can use it; the
-- backoff filter (csp_next_attempt_at) is applied on top, inside the pending rows only.
CREATE INDEX IF NOT EXISTS leads_csp_pending_idx ON leads(csp_sync_attempts, csp_changed_at, id)
  WHERE csp_synced_updated_at IS NULL OR csp_synced_updated_at < csp_changed_at;
CREATE INDEX IF NOT EXISTS email_captures_csp_pending_idx ON email_captures(csp_sync_attempts, csp_changed_at, id)
  WHERE csp_synced_updated_at IS NULL OR csp_synced_updated_at < csp_changed_at;
