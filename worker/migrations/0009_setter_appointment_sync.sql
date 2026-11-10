-- Setter appointment as GHL has it now (status follows reschedules/cancellations) and who it is assigned to.
ALTER TABLE leads ADD COLUMN appointment_status TEXT;
ALTER TABLE leads ADD COLUMN setter_host TEXT;
-- The admin Appointments / Leaderboard views select by appointment time.
CREATE INDEX IF NOT EXISTS leads_appointment_start_idx ON leads(appointment_start);
CREATE INDEX IF NOT EXISTS leads_closer_start_idx ON leads(closer_start);
