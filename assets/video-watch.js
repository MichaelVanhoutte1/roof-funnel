/*
 * Video watch tracking (no dependencies). Measures how much of each video a visitor watched and posts it to the roof
 * CSP (POST https://csp-api.startroofrejuvenating.com/public/video-watch), which stores it and links it to the lead
 * (2026-11-24: video tracking moved out of the funnel Worker into the CSP). The CSP accepts posts from this site's two
 * origins only, and only for the videos in its catalog (a new Wistia / Cortana video needs a line in the CSP's
 * backend/src/modules/leads/videos/lead-video-catalog.ts first).
 *
 * Tracked: every Cortana player (<div id="ckv_embed_<uuid>"> holding a plain <video>), every <wistia-player media-id>
 * web component (Wistia Aurora player.js: `time-update` / `play` / `pause` / `ended` / `seeking` / `seeked` events,
 * `currentTime` / `duration` / `muted` / `volume` / `state` properties), and the Vidalytics VSL
 * (<div id="vidalytics_embed_<embedId>"> holding a plain <video>). The players' own embeds are never touched.
 *
 * Per video: duration (s), max_pct = the furthest position reached while playing ÷ duration (0–100), watched_seconds
 * = the union of the played ranges (seeks and replays are not double-counted). Only AUDIBLE playback counts: Cortana
 * and Vidalytics start a silent muted preview on load, which is not watching. Ranges are kept in localStorage, so a
 * reload or a later visit on the same device adds to them instead of starting over.
 *
 * Identity: Cortana's ak_tid (cookie, legacy cookie ak_session_id, localStorage ak_fallback_ak_tid), our own visitor
 * id srr_vid (cookie on .startroofrejuvenating.com for a year + localStorage), and ?cid= (GHL contact id), ?email=,
 * ?phone= from the page URL.
 *
 * Sent every 15 s while a video plays, shortly after a pause or the end, and with sendBeacon when the page is hidden or
 * left; only videos whose figures moved. Never throws into the page. ?vw_debug=1 logs each payload to the console.
 *
 * Mount: <script src="/assets/video-watch.js" data-api="https://csp-api.startroofrejuvenating.com" defer></script>
 */
(function () {
  "use strict";
  try {
    var script = document.currentScript;
    var API = ((script && script.getAttribute("data-api")) || "https://csp-api.startroofrejuvenating.com").replace(/\/+$/, "");
    var ENDPOINT = API + "/public/video-watch";
    var DEBUG = /[?&]vw_debug=1\b/.test(window.location.search);
    var STORE_KEY = "srr_vw_v1";
    var VID_KEY = "srr_vid";
    var SEND_EVERY_MS = 15000;
    var SCAN_EVERY_MS = 4000;
    var MAX_STORED_VIDEOS = 40;
    var MAX_RANGES = 60;
    var MAX_VIDEOS_PER_POST = 30;
    var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    var log = function () { if (DEBUG) try { console.log.apply(console, ["[video-watch]"].concat([].slice.call(arguments))); } catch (e) {} };

    /* ---------------- storage + identity ---------------- */

    function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }

    function cookie(name) {
      try {
        var parts = document.cookie ? document.cookie.split("; ") : [];
        for (var i = 0; i < parts.length; i++) {
          var eq = parts[i].indexOf("=");
          if (eq > 0 && parts[i].slice(0, eq) === name) return decodeURIComponent(parts[i].slice(eq + 1));
        }
      } catch (e) {}
      return null;
    }

    function cleanId(v) { return typeof v === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(v) ? v : null; }

    function akTid() { return cleanId(cookie("ak_tid")) || cleanId(cookie("ak_session_id")) || cleanId(lsGet("ak_fallback_ak_tid")); }

    function newUuid() {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      var b = new Uint8Array(16);
      if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b); else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
      b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
      var h = []; for (var j = 0; j < 16; j++) h.push((b[j] + 256).toString(16).slice(1));
      return h.slice(0, 4).join("") + "-" + h.slice(4, 6).join("") + "-" + h.slice(6, 8).join("") + "-" + h.slice(8, 10).join("") + "-" + h.slice(10).join("");
    }

    var visitorId = null;
    function srrVid() {
      if (visitorId) return visitorId;
      var id = cookie(VID_KEY);
      if (!id || !UUID_RE.test(id)) id = lsGet(VID_KEY);
      if (!id || !UUID_RE.test(id)) id = newUuid();
      id = id.toLowerCase();
      lsSet(VID_KEY, id);
      try {
        var host = window.location.hostname;
        var domain = /(^|\.)startroofrejuvenating\.com$/.test(host) ? "; Domain=.startroofrejuvenating.com" : "";
        var secure = window.location.protocol === "https:" ? "; Secure" : "";
        document.cookie = VID_KEY + "=" + id + "; Max-Age=31536000; Path=/" + domain + "; SameSite=Lax" + secure;
      } catch (e) {}
      visitorId = id;
      return id;
    }
    srrVid(); // the survey reads it into the lead's tracking

    var params = (function () { try { return new URLSearchParams(window.location.search); } catch (e) { return null; } })();
    function param(k, max) { var v = params && params.get(k); return v && v.length <= max ? v : undefined; }
    var urlIdentity = { cid: param("cid", 64), email: param("email", 254), phone: param("phone", 40) };

    /* ---------------- per-video state ---------------- */

    var stored = {};
    try { stored = JSON.parse(lsGet(STORE_KEY) || "{}") || {}; } catch (e) { stored = {}; }
    var records = {}; // key → record

    function record(key) {
      var r = records[key];
      if (r) return r;
      var prior = stored[key] || {};
      r = records[key] = {
        key: key, ranges: Array.isArray(prior.r) ? prior.r.filter(function (x) { return Array.isArray(x) && x.length === 2 && x[1] > x[0]; }) : [],
        dur: typeof prior.d === "number" ? prior.d : 0, lastPos: null, playing: false, sentSig: null, el: null, read: null,
      };
      return r;
    }

    function addRange(r, a, b) {
      if (!(b > a)) return;
      var out = [], s = a, e = b;
      for (var i = 0; i < r.ranges.length; i++) {
        var x = r.ranges[i];
        if (x[1] < s - 0.5 || x[0] > e + 0.5) out.push(x); else { s = Math.min(s, x[0]); e = Math.max(e, x[1]); }
      }
      out.push([s, e]);
      out.sort(function (p, q) { return p[0] - q[0]; });
      while (out.length > MAX_RANGES) { // merge the two closest neighbours
        var best = 0, gap = Infinity;
        for (var k = 0; k + 1 < out.length; k++) { var g = out[k + 1][0] - out[k][1]; if (g < gap) { gap = g; best = k; } }
        out.splice(best, 2, [out[best][0], out[best + 1][1]]);
      }
      r.ranges = out;
    }

    function metrics(r) {
      var dur = r.dur;
      if (!(dur > 0)) return null;
      var sec = 0, furthest = 0;
      for (var i = 0; i < r.ranges.length; i++) {
        var a = Math.max(0, r.ranges[i][0]), b = Math.min(dur, r.ranges[i][1]);
        if (b > a) sec += b - a;
        if (b > furthest) furthest = b;
      }
      return {
        key: r.key, duration: Math.round(dur * 100) / 100,
        max_pct: Math.min(100, Math.round((furthest / dur) * 10000) / 100), watched_seconds: Math.round(Math.min(sec, dur) * 10) / 10,
      };
    }

    function persist() {
      try {
        var keys = Object.keys(records);
        for (var i = 0; i < keys.length; i++) {
          var r = records[keys[i]];
          if (r.ranges.length) stored[r.key] = { r: r.ranges.map(function (x) { return [Math.round(x[0] * 10) / 10, Math.round(x[1] * 10) / 10]; }), d: r.dur, at: Date.now() };
        }
        var all = Object.keys(stored);
        if (all.length > MAX_STORED_VIDEOS) {
          all.sort(function (a, b) { return (stored[a].at || 0) - (stored[b].at || 0); });
          for (var j = 0; j < all.length - MAX_STORED_VIDEOS; j++) delete stored[all[j]];
        }
        lsSet(STORE_KEY, JSON.stringify(stored));
      } catch (e) {}
    }

    /* A position update while playing: the stretch since the last update counts when it was audible and looks like
     * normal playback (no jump), else it is only the new starting point. */
    function advance(r) {
      var s = r.read && r.read();
      if (!s || !(s.t >= 0)) return;
      if (s.dur > 0) r.dur = s.dur;
      if (r.lastPos != null && s.playing && s.audible) {
        var d = s.t - r.lastPos;
        if (d > 0 && d <= 3 * Math.max(1, s.rate || 1)) addRange(r, r.lastPos, s.t);
      }
      r.lastPos = s.t;
      r.playing = s.playing;
    }

    function onEnded(r) {
      advance(r);
      if (r.lastPos != null && r.dur > 0 && r.dur - r.lastPos <= 3) addRange(r, r.lastPos, r.dur);
      r.lastPos = null;
      r.playing = false;
      soon();
    }

    function onStop(r) { advance(r); r.lastPos = null; r.playing = false; soon(); }
    function onSeek(r) { r.lastPos = null; }
    function onSeeked(r) { var s = r.read && r.read(); r.lastPos = s && s.t >= 0 ? s.t : null; }
    function onPlay(r) { var s = r.read && r.read(); r.lastPos = s && s.t >= 0 ? s.t : null; r.playing = true; }

    function listen(el, names, fn) {
      for (var i = 0; i < names.length; i++) el.addEventListener(names[i], function () { try { fn(); } catch (e) {} }, { passive: true });
    }

    function bind(r, el, read, names) {
      if (r.el === el) return;
      r.el = el; r.read = read; r.lastPos = null;
      listen(el, names.time, function () { advance(r); });
      listen(el, names.play, function () { onPlay(r); });
      listen(el, names.pause, function () { onStop(r); });
      listen(el, names.ended, function () { onEnded(r); });
      listen(el, names.seeking, function () { onSeek(r); });
      listen(el, names.seeked, function () { onSeeked(r); });
      listen(el, names.mute, function () { advance(r); });
      log("tracking", r.key);
    }

    var NATIVE = { time: ["timeupdate"], play: ["playing"], pause: ["pause"], ended: ["ended"], seeking: ["seeking"], seeked: ["seeked"], mute: ["volumechange"] };
    // Wistia Aurora <wistia-player> events (https://docs.wistia.com/docs/player-events).
    var WISTIA = { time: ["time-update"], play: ["play"], pause: ["pause"], ended: ["ended"], seeking: ["seeking"], seeked: ["seeked"], mute: ["mute-change", "volume-change"] };

    function nativeReader(v) {
      return function () {
        return { t: v.currentTime, dur: isFinite(v.duration) ? v.duration : 0, playing: !v.paused && !v.ended,
          audible: !v.muted && v.volume > 0, rate: v.playbackRate };
      };
    }

    function wistiaReader(w) {
      return function () {
        var dur = Number(w.duration);
        return { t: Number(w.currentTime), dur: isFinite(dur) ? dur : 0, playing: w.state === "playing",
          audible: !w.muted && !(Number(w.volume) === 0), rate: Number(w.playbackRate) || 1 };
      };
    }

    function scan() {
      try {
        var c = document.querySelectorAll('[id^="ckv_embed_"]');
        for (var i = 0; i < c.length; i++) {
          var id = c[i].id.slice("ckv_embed_".length), v = c[i].querySelector("video");
          if (v && UUID_RE.test(id)) bind(record("cortana:" + id.toLowerCase()), v, nativeReader(v), NATIVE);
        }
        var vd = document.querySelectorAll('[id^="vidalytics_embed_"]');
        for (var j = 0; j < vd.length; j++) {
          var eid = vd[j].id.slice("vidalytics_embed_".length), vv = vd[j].querySelector("video");
          if (vv && /^[A-Za-z0-9_-]{8,40}$/.test(eid)) bind(record("vidalytics:" + eid), vv, nativeReader(vv), NATIVE);
        }
        var w = document.querySelectorAll("wistia-player[media-id]");
        for (var k = 0; k < w.length; k++) {
          var mid = w[k].getAttribute("media-id");
          if (mid && /^[a-z0-9]{6,20}$/.test(mid)) bind(record("wistia:" + mid), w[k], wistiaReader(w[k]), WISTIA);
        }
      } catch (e) {}
    }

    /* ---------------- sending ---------------- */

    var soonTimer = null;
    function soon() { if (soonTimer) return; soonTimer = setTimeout(function () { soonTimer = null; send(false); }, 1000); }

    function payload() {
      var videos = [], sigs = [];
      var keys = Object.keys(records);
      for (var i = 0; i < keys.length && videos.length < MAX_VIDEOS_PER_POST; i++) {
        var r = records[keys[i]];
        var m = metrics(r);
        if (!m || m.watched_seconds <= 0) continue;
        var sig = Math.floor(m.watched_seconds) + "|" + Math.floor(m.max_pct);
        if (sig === r.sentSig) continue;
        videos.push(m); sigs.push([r, sig]);
      }
      if (!videos.length) return null;
      var body = { srr_vid: srrVid(), page: window.location.pathname, videos: videos };
      var ak = akTid(); if (ak) body.ak_tid = ak;
      if (urlIdentity.cid) body.cid = urlIdentity.cid;
      if (urlIdentity.email) body.email = urlIdentity.email;
      if (urlIdentity.phone) body.phone = urlIdentity.phone;
      return { body: body, sigs: sigs };
    }

    function markSent(sigs) { for (var i = 0; i < sigs.length; i++) sigs[i][0].sentSig = sigs[i][1]; }

    function send(leaving) {
      try {
        var keys = Object.keys(records);
        for (var i = 0; i < keys.length; i++) if (records[keys[i]].playing) advance(records[keys[i]]);
        persist();
        var p = payload();
        if (!p) return;
        var text = JSON.stringify(p.body);
        log(leaving ? "beacon" : "post", p.body);
        if (leaving && navigator.sendBeacon) {
          // A string body goes as text/plain: a CORS-safelisted type, so no preflight is needed while the page unloads.
          if (navigator.sendBeacon(ENDPOINT, text)) { markSent(p.sigs); return; }
        }
        fetch(ENDPOINT, { method: "POST", body: text, headers: { "Content-Type": "text/plain;charset=UTF-8" }, keepalive: true, credentials: "omit" })
          .then(function (res) { if (res.ok) markSent(p.sigs); }).catch(function () {});
      } catch (e) {}
    }

    function anyPlaying() { var k = Object.keys(records); for (var i = 0; i < k.length; i++) if (records[k[i]].playing) return true; return false; }

    setInterval(function () { if (anyPlaying()) send(false); }, SEND_EVERY_MS);
    setInterval(scan, SCAN_EVERY_MS);
    try {
      new MutationObserver(function () { if (!scan.pending) { scan.pending = true; setTimeout(function () { scan.pending = false; scan(); }, 1000); } })
        .observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") send(true); });
    window.addEventListener("pagehide", function () { send(true); });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan); else scan();

    if (DEBUG) window.__srrVideoWatch = { records: records, payload: function () { var p = payload(); return p && p.body; }, send: send };
  } catch (e) {}
})();
