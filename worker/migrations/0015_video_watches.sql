-- Per-viewer video watch progress (POST /video-watch, worker/src/video-watch.ts), sent by assets/video-watch.js from
-- the opt-in page (Vidalytics VSL) and the thank-you pages (Cortana main video, Wistia question / equipment /
-- testimonial videos).
--
-- One row per (viewer, video). viewer_key = 'ak:<Cortana ak_tid>' when the Cortana cookie exists, else
-- 'vid:<srr_vid>' (our own first-party visitor id); 'cortana:<Cortana contact id>' for rows imported from Cortana's
-- own watch history (cid = the GHL contact id, aggregate_pending = 1). Both ids are kept as columns too, so a viewer whose key changed
-- (the Cortana cookie arrived after the first post) is still found by either id.
-- max_pct (0-100) = the furthest audibly watched position / duration; watched_seconds = the union of the audibly
-- played ranges on that device. Merges are monotonic: a post never lowers either.
-- lead_id = the leads row this viewer resolved to (GHL contact id, phone / email, or the ak_tid / srr_vid the
-- survey stored in leads.tracking); NULL until known, then linked by the lead save or the 10-minute cron pass.
CREATE TABLE IF NOT EXISTS video_watches (
  viewer_key TEXT NOT NULL,
  video_key TEXT NOT NULL,             -- cortana:<uuid> | wistia:<mediaId> | vidalytics:<embedId>
  lead_id INTEGER,
  ak_tid TEXT,
  srr_vid TEXT,
  cid TEXT,                            -- GHL contact id from the ?cid= link in GHL texts / emails
  duration REAL,                       -- seconds
  max_pct REAL NOT NULL DEFAULT 0,
  watched_seconds REAL NOT NULL DEFAULT 0,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  page TEXT,                           -- the path the post came from; 'import:cortana' for the one-off history import
  -- 1 = this row changed outside the live path (a bulk import, or set by hand to force a rebuild): the 10-minute cron
  -- recomputes leads.video_watches for its lead and clears the flag. Rows without a lead yet stay flagged until linked.
  aggregate_pending INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (viewer_key, video_key)
);
CREATE INDEX IF NOT EXISTS video_watches_lead_idx ON video_watches(lead_id);
CREATE INDEX IF NOT EXISTS video_watches_ak_tid_idx ON video_watches(ak_tid);
CREATE INDEX IF NOT EXISTS video_watches_srr_vid_idx ON video_watches(srr_vid);
-- The cron pass walks the recent unlinked rows only.
CREATE INDEX IF NOT EXISTS video_watches_unlinked_idx ON video_watches(last_at) WHERE lead_id IS NULL;
CREATE INDEX IF NOT EXISTS video_watches_pending_idx ON video_watches(lead_id) WHERE aggregate_pending = 1;

-- Lead resolution by the email in the thank-you link (any case) is an index lookup, not a scan per post.
CREATE INDEX IF NOT EXISTS leads_email_nocase_idx ON leads(email COLLATE NOCASE);

-- The lead's aggregate across every viewer key linked to it, pushed to the CSP (csp-push-columns.ts) as a JSON object:
-- {"<video_key>": {"pct": n, "sec": n, "dur": n, "first": iso, "last": iso}}. Rewritten only when it changes, so the
-- csp_changed_at trigger (0014) re-pushes the lead exactly when its watch data moved.
ALTER TABLE leads ADD COLUMN video_watches TEXT;
