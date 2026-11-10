-- Carrier lookup of the applicant's phone (Twilio Lookup v2, line_type_intelligence), done once per number when a
-- lead is saved: unassigned / invalid numbers are refused at the phone step, VoIP is recorded for the team.
ALTER TABLE leads ADD COLUMN phone_line_type TEXT;   -- mobile | landline | fixedVoip | nonFixedVoip | tollFree | unknown | invalid
ALTER TABLE leads ADD COLUMN phone_carrier TEXT;
ALTER TABLE leads ADD COLUMN phone_lookup_at TEXT;
