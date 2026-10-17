-- Visitors who gave an email (and answers) but no phone yet. Once a phone arrives the lead row
-- takes over; GHL matches the two by email so the contact is updated, not duplicated.
CREATE TABLE IF NOT EXISTS email_captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  email TEXT NOT NULL UNIQUE,
  name TEXT, city TEXT, timeline TEXT, business_owner TEXT, capital TEXT,
  tracking TEXT, ip TEXT, country TEXT,
  ghl_contact_id TEXT, ghl_status TEXT, ghl_error TEXT
);
