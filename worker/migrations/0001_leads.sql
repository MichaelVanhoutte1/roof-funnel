CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- 'partial' = abandoned after the phone step, 'full' = completed survey
  status TEXT NOT NULL,
  -- 'calendar' | 'dq' (not a fit) ; NULL on partials
  route TEXT,
  qualified INTEGER,
  phone TEXT NOT NULL,          -- E.164
  superseded_phone TEXT,
  name TEXT,
  email TEXT,
  city TEXT,
  timeline TEXT,
  business_owner TEXT,
  capital TEXT,
  tracking TEXT,                -- JSON
  ip TEXT,
  country TEXT,
  user_agent TEXT,
  ghl_status TEXT,              -- 'sent' | 'failed' | 'skipped'
  ghl_error TEXT
);
CREATE INDEX IF NOT EXISTS leads_phone_idx ON leads(phone);
CREATE INDEX IF NOT EXISTS leads_created_idx ON leads(created_at);
CREATE INDEX IF NOT EXISTS leads_ip_created_idx ON leads(ip, created_at);
