-- Admin page: editable disqualification rules and the outcome of every lead after the funnel.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,           -- 'rules' (disqualification rules JSON), 'sync_status' (last outcome sync)
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Why a completed application was turned away: 'answer:<question>' or 'credit:<rule>'. NULL = not disqualified.
ALTER TABLE leads ADD COLUMN dq_reason TEXT;
UPDATE leads SET dq_reason = 'answer:capital' WHERE route = 'dq' AND dq_reason IS NULL;

-- GHL Sales Pipeline (one opportunity per contact): setter disqualified, passed to closer, won, cash.
ALTER TABLE leads ADD COLUMN opportunity_id TEXT;
ALTER TABLE leads ADD COLUMN pipeline_stage TEXT;
ALTER TABLE leads ADD COLUMN pipeline_stage_at TEXT;
ALTER TABLE leads ADD COLUMN opportunity_status TEXT;
ALTER TABLE leads ADD COLUMN opportunity_value REAL;

-- Setter call (a phone call, from the GHL call log): attempts and the longest completed call in seconds.
ALTER TABLE leads ADD COLUMN setter_calls INTEGER;
ALTER TABLE leads ADD COLUMN setter_call_seconds INTEGER;
ALTER TABLE leads ADD COLUMN setter_calls_synced_at TEXT;

-- Closer call (Google Meet, booked in GHL by the setter) and who attended it.
ALTER TABLE leads ADD COLUMN closer_appointment_id TEXT;
ALTER TABLE leads ADD COLUMN closer_start TEXT;
ALTER TABLE leads ADD COLUMN closer_status TEXT;            -- GHL appointment status
ALTER TABLE leads ADD COLUMN closer_meet_code TEXT;
ALTER TABLE leads ADD COLUMN closer_attended TEXT;          -- 'showed' | 'no_show'; NULL = not known yet
ALTER TABLE leads ADD COLUMN closer_attended_source TEXT;   -- 'google_meet' | 'fathom'
ALTER TABLE leads ADD COLUMN closer_minutes INTEGER;
ALTER TABLE leads ADD COLUMN closer_checked_at TEXT;

CREATE INDEX IF NOT EXISTS leads_ghl_contact_idx ON leads(ghl_contact_id);
