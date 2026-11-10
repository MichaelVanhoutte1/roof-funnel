-- Setter appointment as GHL has it now (status follows reschedules/cancellations) and who it is assigned to.
ALTER TABLE leads ADD COLUMN appointment_status TEXT;
ALTER TABLE leads ADD COLUMN setter_host TEXT;
