-- D1 read budget (2026-11-24: the free daily row-read limit was exceeded). The outcome sync finds a lead by its setter /
-- closer appointment id (`WHERE appointment_id = ?` / `closer_appointment_id = ?`), which scanned every lead per call.
CREATE INDEX IF NOT EXISTS leads_appointment_id_idx ON leads(appointment_id);
CREATE INDEX IF NOT EXISTS leads_closer_appointment_id_idx ON leads(closer_appointment_id);
