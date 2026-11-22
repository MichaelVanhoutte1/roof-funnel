/**
 * Per-lead video watch tracking (migration 0015). The pages post what each viewer watched (assets/video-watch.js);
 * this module validates the post, merges it into `video_watches` (one row per viewer × video, monotonic), resolves
 * the viewer to a lead, and keeps `leads.video_watches` (the lead's aggregate, pushed to the CSP) current.
 *
 *   POST /video-watch  { ak_tid?, srr_vid?, cid?, email?, phone?, page?, videos: [{ key, duration, max_pct, watched_seconds }] }
 *
 * Lead resolution, in order: `cid` = leads.ghl_contact_id → phone (E.164, also superseded_phone) → email (any case)
 * → a lead this viewer's earlier rows are already linked to → a recent lead whose tracking carries the same ak_tid /
 * srr_vid (only for a viewer seen for the first time). Unresolved rows keep lead_id NULL and are linked later: by the
 * lead save (`linkLeadViewer`, the survey sends ak_tid + srr_vid in its tracking) and by the cron pass
 * (`linkPendingWatches`). A row's first link wins, so a lead's aggregate never goes stale behind its back.
 *
 * Nothing here is trusted: the post is public, so it can only ever raise a watch figure on a row, never lower it,
 * never read anything back, and is size-capped per post. Logs carry counts only (no ids, phones or emails).
 */
import { isValidEmail, normalizePhoneDigits10 } from "./validation.ts";

export const WATCH_MAX_BODY_BYTES = 8_192;
export const WATCH_MAX_VIDEOS = 30;
const MAX_DURATION_S = 6 * 3600;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const VIDEO_KEY_RE = new RegExp(`^(?:cortana:${UUID}|wistia:[a-z0-9]{6,20}|vidalytics:[A-Za-z0-9_-]{8,40})$`);
const SRR_VID_RE = new RegExp(`^${UUID}$`);
/** Cortana's ak_tid (and the legacy ak_session_id): an opaque token; kept to a safe charset and length. */
const AK_TID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
/** GHL contact ids are 20 alphanumerics; a little slack either way. */
const CID_RE = /^[A-Za-z0-9]{8,40}$/;
const PAGE_RE = /^\/[A-Za-z0-9/_.-]{0,80}$/;
/** How far back the cron pass and the first-visit tracking lookup look. */
const LINK_WINDOW_DAYS = 3;
const TRACKING_LOOKUP_DAYS = 60;
const MAX_AGGREGATES_PER_RUN = 50;

export type WatchVideo = { key: string; duration: number; maxPct: number; watchedSeconds: number };
export type WatchPost = {
  viewerKey: string;
  akTid: string | null;
  srrVid: string | null;
  cid: string | null;
  email: string | null;
  phone: string | null;
  page: string | null;
  videos: WatchVideo[];
};

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

function num(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

function token(v: unknown, re: RegExp): string | null {
  return typeof v === "string" && re.test(v.trim()) ? v.trim() : null;
}

export function validAkTid(v: unknown): string | null { return token(v, AK_TID_RE); }
export function validSrrVid(v: unknown): string | null { return token(typeof v === "string" ? v.toLowerCase() : v, SRR_VID_RE); }

/**
 * The post, or null when it is malformed: not an object, no viewer id, `videos` not an array or over the cap.
 * Single video entries that are malformed (unknown key format, no usable duration) are dropped; numbers are clamped
 * (max_pct 0–100, watched_seconds 0–duration); a key sent twice keeps the larger figures.
 */
export function parseWatchPost(raw: unknown): WatchPost | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const akTid = validAkTid(b.ak_tid);
  const srrVid = validSrrVid(b.srr_vid);
  if (!akTid && !srrVid) return null;
  if (!Array.isArray(b.videos) || b.videos.length > WATCH_MAX_VIDEOS) return null;
  const byKey = new Map<string, WatchVideo>();
  for (const v of b.videos) {
    if (!v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    const key = typeof e.key === "string" && VIDEO_KEY_RE.test(e.key) ? e.key : null;
    const duration = num(e.duration, 0, MAX_DURATION_S);
    if (!key || !duration) continue;
    const maxPct = round(num(e.max_pct, 0, 100) ?? 0, 2);
    const watchedSeconds = round(num(e.watched_seconds, 0, duration) ?? 0, 1);
    const prior = byKey.get(key);
    byKey.set(key, prior
      ? { key, duration: Math.max(prior.duration, duration), maxPct: Math.max(prior.maxPct, maxPct), watchedSeconds: Math.max(prior.watchedSeconds, watchedSeconds) }
      : { key, duration: round(duration, 2), maxPct, watchedSeconds });
  }
  const digits = typeof b.phone === "string" && b.phone.length <= 40 ? normalizePhoneDigits10(b.phone) : null;
  const email = typeof b.email === "string" && isValidEmail(b.email) ? b.email.trim() : null;
  return {
    viewerKey: akTid ? `ak:${akTid}` : `vid:${srrVid}`,
    akTid,
    srrVid,
    cid: token(b.cid, CID_RE),
    email,
    phone: digits ? `+1${digits}` : null,
    page: token(b.page, PAGE_RE),
    videos: [...byKey.values()],
  };
}

type Db = D1Database;

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

async function leadIdBy(db: Db, sql: string, ...args: Array<string | number>): Promise<number | null> {
  const row = await db.prepare(sql).bind(...args).first<{ id: number }>();
  return row ? Number(row.id) : null;
}

/** The lead a post belongs to (see the order at the top), or null. */
export async function resolveLead(db: Db, post: WatchPost, now = new Date()): Promise<number | null> {
  if (post.cid) {
    const id = await leadIdBy(db, "SELECT id FROM leads WHERE ghl_contact_id = ?1 ORDER BY id DESC LIMIT 1", post.cid);
    if (id) return id;
  }
  if (post.phone) {
    const id = await leadIdBy(db, "SELECT id FROM leads WHERE phone = ?1 ORDER BY id DESC LIMIT 1", post.phone)
      ?? await leadIdBy(db, "SELECT id FROM leads WHERE superseded_phone = ?1 ORDER BY id DESC LIMIT 1", post.phone);
    if (id) return id;
  }
  if (post.email) {
    const id = await leadIdBy(db, "SELECT id FROM leads WHERE email = ?1 COLLATE NOCASE ORDER BY id DESC LIMIT 1", post.email);
    if (id) return id;
  }
  // The viewer's earlier rows: linked → that lead; seen before but unlinked → leave it to the lead save / cron.
  const prior = await db.prepare(
    `SELECT lead_id FROM video_watches WHERE viewer_key = ?1 OR (?2 IS NOT NULL AND ak_tid = ?2) OR (?3 IS NOT NULL AND srr_vid = ?3)
     ORDER BY lead_id IS NULL, last_at DESC LIMIT 1`,
  ).bind(post.viewerKey, post.akTid, post.srrVid).first<{ lead_id: number | null }>();
  if (prior) return prior.lead_id == null ? null : Number(prior.lead_id);
  return leadByTracking(db, post.akTid, post.srrVid, daysAgo(now, TRACKING_LOOKUP_DAYS));
}

/** A lead created since `since` whose tracking (the survey's) carries this ak_tid or srr_vid. */
async function leadByTracking(db: Db, akTid: string | null, srrVid: string | null, since: string): Promise<number | null> {
  if (!akTid && !srrVid) return null;
  return leadIdBy(db,
    `SELECT id FROM leads WHERE created_at > ?3 AND tracking IS NOT NULL
       AND ((?1 <> '' AND instr(tracking, ?1) > 0) OR (?2 <> '' AND instr(tracking, ?2) > 0)) AND json_valid(tracking)
       AND ((?1 <> '' AND json_extract(tracking, '$.ak_tid') = ?1) OR (?2 <> '' AND json_extract(tracking, '$.srr_vid') = ?2))
     ORDER BY id DESC LIMIT 1`,
    akTid ?? "", srrVid ?? "", since);
}

/**
 * Merges a validated post into video_watches and refreshes the aggregate of every lead it touches. Returns the lead
 * ids whose rows were touched (for tests and logs).
 */
export async function recordWatch(db: Db, post: WatchPost, now = new Date()): Promise<number[]> {
  if (!post.videos.length) return [];
  const leadId = await resolveLead(db, post, now);
  const at = now.toISOString();
  const statements: D1PreparedStatement[] = post.videos.map((v) => db.prepare(
    `INSERT INTO video_watches (viewer_key, video_key, lead_id, ak_tid, srr_vid, cid, duration, max_pct, watched_seconds, first_at, last_at, page)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)
     ON CONFLICT (viewer_key, video_key) DO UPDATE SET
       lead_id = COALESCE(video_watches.lead_id, excluded.lead_id),
       ak_tid = COALESCE(video_watches.ak_tid, excluded.ak_tid),
       srr_vid = COALESCE(video_watches.srr_vid, excluded.srr_vid),
       cid = COALESCE(excluded.cid, video_watches.cid),
       duration = excluded.duration,
       max_pct = MAX(video_watches.max_pct, excluded.max_pct),
       watched_seconds = MAX(video_watches.watched_seconds, excluded.watched_seconds),
       last_at = excluded.last_at,
       page = COALESCE(excluded.page, video_watches.page)`,
  ).bind(post.viewerKey, v.key, leadId, post.akTid, post.srrVid, post.cid, v.duration, v.maxPct, v.watchedSeconds, at, post.page));
  if (post.akTid && post.srrVid) {
    // The same viewer under its other key (the Cortana cookie arrived after the first post): carry both ids.
    statements.push(db.prepare("UPDATE video_watches SET ak_tid = ?1 WHERE srr_vid = ?2 AND ak_tid IS NULL").bind(post.akTid, post.srrVid));
    statements.push(db.prepare("UPDATE video_watches SET srr_vid = ?2 WHERE ak_tid = ?1 AND srr_vid IS NULL").bind(post.akTid, post.srrVid));
  }
  if (leadId) {
    statements.push(db.prepare(
      `UPDATE video_watches SET lead_id = ?1 WHERE lead_id IS NULL
         AND (viewer_key = ?2 OR (?3 IS NOT NULL AND ak_tid = ?3) OR (?4 IS NOT NULL AND srr_vid = ?4))`,
    ).bind(leadId, post.viewerKey, post.akTid, post.srrVid));
  }
  await db.batch(statements);
  const linked = await db.prepare(
    `SELECT DISTINCT lead_id FROM video_watches WHERE lead_id IS NOT NULL
       AND (viewer_key = ?1 OR (?2 IS NOT NULL AND ak_tid = ?2) OR (?3 IS NOT NULL AND srr_vid = ?3)) LIMIT 5`,
  ).bind(post.viewerKey, post.akTid, post.srrVid).all<{ lead_id: number }>();
  const leads = (linked.results ?? []).map((r) => Number(r.lead_id));
  for (const id of leads) await refreshLeadAggregate(db, id);
  return leads;
}

type AggregateRow = { video_key: string; pct: number; sec: number; dur: number | null; first: string; last: string };

/** The lead's aggregate as stored: keys sorted, numbers rounded, so the same watch data always gives the same text. */
export function aggregateJson(rows: AggregateRow[]): string | null {
  if (!rows.length) return null;
  const out: Record<string, { pct: number; sec: number; dur: number | null; first: string; last: string }> = {};
  for (const r of [...rows].sort((a, b) => (a.video_key < b.video_key ? -1 : a.video_key > b.video_key ? 1 : 0))) {
    out[r.video_key] = { pct: round(Number(r.pct), 1), sec: Math.round(Number(r.sec)), dur: r.dur == null ? null : round(Number(r.dur), 1), first: r.first, last: r.last };
  }
  return JSON.stringify(out);
}

/**
 * Recomputes leads.video_watches from every row linked to the lead, merged across viewer keys (max pct, max sec,
 * max duration, min first, max last). Written only when it differs, so the 0014 trigger re-pushes the lead to the
 * CSP exactly when its watch data moved. True when the lead row changed.
 */
export async function refreshLeadAggregate(db: Db, leadId: number): Promise<boolean> {
  const rows = await db.prepare(
    `SELECT video_key, MAX(max_pct) AS pct, MAX(watched_seconds) AS sec, MAX(duration) AS dur, MIN(first_at) AS first, MAX(last_at) AS last
     FROM video_watches WHERE lead_id = ?1 GROUP BY video_key`,
  ).bind(leadId).all<AggregateRow>();
  const value = aggregateJson(rows.results ?? []);
  const res = await db.prepare("UPDATE leads SET video_watches = ?1 WHERE id = ?2 AND video_watches IS NOT ?1").bind(value, leadId).run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * A lead was just saved with the survey's tracking: link that visitor's earlier, unlinked watch rows (the opt-in
 * VSL watched before opting in, or a thank-you page watched in another tab) and refresh the aggregate.
 */
export async function linkLeadViewer(db: Db, leadId: number, tracking: Record<string, unknown> | undefined): Promise<boolean> {
  const akTid = validAkTid(tracking?.ak_tid);
  const srrVid = validSrrVid(tracking?.srr_vid);
  if (!akTid && !srrVid) return false;
  const res = await db.prepare(
    `UPDATE video_watches SET lead_id = ?1 WHERE lead_id IS NULL
       AND ((?2 IS NOT NULL AND ak_tid = ?2) OR (?3 IS NOT NULL AND srr_vid = ?3))`,
  ).bind(leadId, akTid, srrVid).run();
  if ((res.meta.changes ?? 0) === 0) return false;
  await refreshLeadAggregate(db, leadId);
  return true;
}

/**
 * Cron pass (every 10 minutes, with the Cortana milestones):
 *  1. links unlinked rows whose GHL contact id belongs to a lead: recent rows (the contact id is written a few seconds
 *     after the lead save) and flagged rows of any age (the Cortana history import). A join, so contact ids with no
 *     lead row (GHL contacts that never came through the funnel) never crowd out the ones that resolve;
 *  2. links rows of a viewer whose ak_tid / srr_vid a recent lead's tracking carries (a backstop for `linkLeadViewer`);
 *  3. rebuilds the aggregate of every lead with flagged rows (`aggregate_pending = 1`: the import, or set by hand) and
 *     clears the flag, at most MAX_AGGREGATES_PER_RUN leads per run (the rest follow on the next runs).
 * Index lookups only.
 */
export async function linkPendingWatches(db: Db, now = new Date()): Promise<{ linked: number; leads: number }> {
  const since = daysAgo(now, LINK_WINDOW_DAYS);
  const touched = new Set<number>();
  let linked = 0;
  const applyBatch = async (statements: D1PreparedStatement[], ids: number[]) => {
    if (!statements.length) return;
    const results = (await db.batch(statements)) as Array<{ meta?: { changes?: number } }>;
    results.forEach((res, i) => { const n = res?.meta?.changes ?? 0; if (n > 0) { linked += n; touched.add(ids[i]); } });
  };

  const byCid = await db.prepare(
    `SELECT w.cid AS cid, MAX(l.id) AS id FROM video_watches w JOIN leads l ON l.ghl_contact_id = w.cid
     WHERE w.lead_id IS NULL AND w.cid IS NOT NULL AND (w.last_at > ?1 OR w.aggregate_pending = 1)
     GROUP BY w.cid LIMIT 100`,
  ).bind(since).all<{ cid: string; id: number }>();
  const cidRows = byCid.results ?? [];
  await applyBatch(
    cidRows.map((r) => db.prepare("UPDATE video_watches SET lead_id = ?1 WHERE lead_id IS NULL AND cid = ?2").bind(Number(r.id), r.cid)),
    cidRows.map((r) => Number(r.id)),
  );

  const recent = await db.prepare(
    `SELECT id, json_extract(tracking, '$.ak_tid') AS ak, json_extract(tracking, '$.srr_vid') AS vid FROM leads
     WHERE created_at > ?1 AND tracking IS NOT NULL AND json_valid(tracking)
       AND (json_extract(tracking, '$.ak_tid') IS NOT NULL OR json_extract(tracking, '$.srr_vid') IS NOT NULL)
     ORDER BY id DESC LIMIT 200`,
  ).bind(since).all<{ id: number; ak: unknown; vid: unknown }>();
  const statements: D1PreparedStatement[] = [];
  const ids: number[] = [];
  for (const r of recent.results ?? []) {
    const akTid = validAkTid(r.ak);
    const srrVid = validSrrVid(r.vid);
    if (!akTid && !srrVid) continue;
    ids.push(Number(r.id));
    statements.push(db.prepare(
      `UPDATE video_watches SET lead_id = ?1 WHERE lead_id IS NULL
         AND ((?2 IS NOT NULL AND ak_tid = ?2) OR (?3 IS NOT NULL AND srr_vid = ?3))`,
    ).bind(Number(r.id), akTid, srrVid));
  }
  await applyBatch(statements, ids);

  const leads = [...touched].slice(0, MAX_AGGREGATES_PER_RUN);
  for (const id of leads) await refreshLeadAggregate(db, id);
  const flagged = await db.prepare(
    "SELECT DISTINCT lead_id FROM video_watches WHERE aggregate_pending = 1 AND lead_id IS NOT NULL LIMIT ?1",
  ).bind(MAX_AGGREGATES_PER_RUN).all<{ lead_id: number }>();
  for (const { lead_id } of flagged.results ?? []) {
    const id = Number(lead_id);
    if (!touched.has(id)) await refreshLeadAggregate(db, id);
    await db.prepare("UPDATE video_watches SET aggregate_pending = 0 WHERE lead_id = ?1 AND aggregate_pending = 1").bind(id).run();
    touched.add(id);
  }
  return { linked, leads: touched.size };
}
