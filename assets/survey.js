/**
 * Dealer application survey — vanilla port of the Stone Systems opt-in survey.
 *
 * Mount: <div id="dealer-survey" data-api="https://api.example.com" data-calendar="<GHL booking widget URL>">
 *
 * Flow: 3 tap questions → city → phone → email → name → POST /lead → calendar (GHL) | not-a-fit | thanks.
 * Partial save (POST /lead/partial) once a valid phone exists and the visitor leaves or idles.
 */
(function () {
  "use strict";

  var mount = document.getElementById("dealer-survey");
  if (!mount) return;

  var API = (mount.getAttribute("data-api") || "").replace(/\/+$/, "");
  var CALENDAR_URL = mount.getAttribute("data-calendar") || "";
  var THANKYOU_URL = mount.getAttribute("data-thankyou") || "/thankyou-page/";
  var HONEYPOT_FIELD = "contact_fax";

  var STEPS = [
    { key: "city", type: "text", q: "What city are you located in?", placeholder: "e.g. Tampa, FL", autocomplete: "address-level2", aria: "Your city" },
    { key: "timeline", type: "choice", q: "How soon are you planning to become a dealer/applicator in your city?",
      options: ["Right away", "Within 30 days", "More than 30 days"], aria: "Timeline" },
    { key: "business_owner", type: "choice", q: "Are you currently a business owner or looking to start one?",
      options: ["I own a business", "I want to start one"], aria: "Business owner" },
    { key: "capital", type: "choice",
      q: "To launch a roof rejuvenation business properly, you must have a minimum of $20,000 in accessible capital. Do you currently have this available?",
      options: ["Yes, I have $20,000+ available right now.", "Yes, I will use financing.", "No, I do not qualify to book a call."], aria: "Capital" },
    { key: "name", type: "text", q: "What is your full name?", placeholder: "First and last name", autocomplete: "name", aria: "Your name" },
    { key: "email", type: "email", q: "What is your email?", placeholder: "you@example.com", autocomplete: "email", aria: "Your email" },
    { key: "phone", type: "tel", q: "What is your personal phone number?", placeholder: "(555) 123-4567", autocomplete: "tel-national", aria: "Your mobile phone", submit: true },
  ];
  var TOTAL = STEPS.length;
  var PHONE_STEP = 6;
  var ENDOWED_PROGRESS = [50, 60, 70, 78, 86, 92, 98];
  var AUTO_ADVANCE_MS = 250;
  var SURVEY_ABANDON_MS = 300000;
  var PHONE_SETTLE_MS = 6000;

  /* ---------------- tracking capture (first touch, sessionStorage) ---------------- */
  var TRACK_KEY = "funnel_tracking";
  var SESSION_KEY = "funnel_session_id";
  var TRACK_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid",
    "campaign_id", "medium_id", "content_id", "fbc_id", "h_ad_id"];

  function sessionGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function sessionSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  function sessionId() {
    var id = sessionGet(SESSION_KEY);
    if (!id) {
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "s" + Date.now() + "-" + Math.random().toString(36).slice(2, 11);
      sessionSet(SESSION_KEY, id);
    }
    return id;
  }

  function inferredSource(referrer, href) {
    if (/facebook\.com|fb\.com/.test(referrer) || href.indexOf("fbclid") !== -1) return "facebook";
    if (/google\./.test(referrer)) return "google";
    return undefined;
  }

  function contextTracking() {
    var w = window.innerWidth;
    var out = { viewport_width: w, viewport_height: window.innerHeight,
      device_type: w < 768 ? "mobile" : w < 1024 ? "tablet" : "desktop", session_id: sessionId() };
    try { out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    if (document.referrer) out.referrer = document.referrer;
    return out;
  }

  function urlTracking() {
    var params = new URLSearchParams(window.location.search);
    var out = { landing_url: window.location.href, entry_page: window.location.pathname };
    TRACK_PARAMS.forEach(function (k) { var v = params.get(k); if (v) out[k] = v; });
    return out;
  }

  function captureTracking() {
    var fromUrl = urlTracking();
    var referrer = document.referrer || "";
    if (!fromUrl.utm_source) { var s = inferredSource(referrer, window.location.href); if (s) fromUrl.utm_source = s; }
    var existing = null;
    try { existing = JSON.parse(sessionGet(TRACK_KEY) || "null"); } catch (e) {}
    var hasParams = !!(fromUrl.utm_source || fromUrl.utm_medium || fromUrl.fbclid || fromUrl.gclid);
    var merged;
    if (existing && existing.landing_url && !hasParams) merged = Object.assign({}, existing, contextTracking());
    else merged = Object.assign({}, existing || {}, fromUrl, contextTracking(), {
      landing_url: fromUrl.landing_url || (existing && existing.landing_url),
      entry_page: fromUrl.entry_page || (existing && existing.entry_page),
      referrer: referrer || (existing && existing.referrer) });
    // Callix session (attribution pixel already on the page) when present.
    try { var cs = window.localStorage && localStorage.getItem("callix_sid"); if (cs) merged.callix_sid = cs; } catch (e) {}
    sessionSet(TRACK_KEY, JSON.stringify(merged));
  }

  function trackingForSubmit() {
    var stored = null;
    try { stored = JSON.parse(sessionGet(TRACK_KEY) || "null"); } catch (e) {}
    var fromUrl = urlTracking();
    var out = Object.assign({}, contextTracking(), fromUrl, stored || {});
    out.landing_url = (stored && stored.landing_url) || fromUrl.landing_url;
    out.entry_page = (stored && stored.entry_page) || fromUrl.entry_page;
    out.utm_source = (stored && stored.utm_source) || fromUrl.utm_source || inferredSource(document.referrer || "", window.location.href);
    out.referrer = (stored && stored.referrer) || document.referrer || undefined;
    out.submitted_at = new Date().toISOString();
    Object.keys(out).forEach(function (k) { if (out[k] === undefined || out[k] === "") delete out[k]; });
    return out;
  }

  captureTracking();
  window.addEventListener("load", captureTracking);

  /* ---------------- validation (client side; the API re-checks everything) ---------------- */
  function nationalDigits(v) { var d = (v || "").replace(/\D/g, ""); return d.length === 11 && d.charAt(0) === "1" ? d.slice(1) : d; }
  function formatPhone(d) {
    d = d.replace(/\D/g, "");
    if (d.length > 10) return d;
    if (d.length <= 3) return d.length ? "(" + d : "";
    if (d.length <= 6) return "(" + d.slice(0, 3) + ") " + d.slice(3);
    return "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
  }
  /** NANP shape: 10 digits, area + exchange start 2–9, no 555-01XX; toll-free passes here (ghosted server-side). */
  function phoneE164(digits) {
    if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
    if (digits.slice(0, 3) === "555" && digits.slice(3, 5) === "01") return null;
    return "+1" + digits;
  }
  function isValidEmail(v) { v = (v || "").trim(); return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }

  /* ---------------- DOM ---------------- */
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  var isSafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(navigator.userAgent);
  mount.classList.add("sv");
  if (isSafari) mount.classList.add("is-safari");

  var state = { step: 0, advancing: false, submitting: false, answers: {}, phone: "" };
  var refs = { inputs: {}, errors: {}, choices: {} };
  var advanceTimer = null, abandonTimer = null;
  var partialSent = false, fullSent = false, partialPhone = null, phoneEditedAt = 0;

  var form = el("form", { novalidate: true, autocomplete: "on" });
  var back = el("button", { type: "button", class: "sv-back", text: "← Back", hidden: true });
  var hp = el("div", { class: "sv-hp", "aria-hidden": "true" });
  hp.appendChild(el("label", { for: HONEYPOT_FIELD, text: "Fax" }));
  var hpInput = el("input", { id: HONEYPOT_FIELD, name: HONEYPOT_FIELD, type: "text", tabindex: "-1", autocomplete: "off" });
  hp.appendChild(hpInput);
  var mirrors = {};
  ["timeline", "business_owner", "capital"].forEach(function (k) {
    mirrors[k] = el("input", { type: "text", name: k, tabindex: "-1", autocomplete: "off", readonly: true });
    hp.appendChild(mirrors[k]);
  });

  var progressWrap = el("div", { class: "sv-progress-wrap" });
  var progressFill = el("div", { class: "sv-progress-fill" });
  var progressLabel = el("span", { class: "sv-progress-label" });
  progressFill.appendChild(progressLabel);
  progressFill.appendChild(el("span", { class: "sv-progress-stripes" }));
  var progress = el("div", { class: "sv-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" }, [progressFill]);
  progressWrap.appendChild(progress);

  var viewport = el("div", { class: "sv-viewport" });
  var track = el("div", { class: "sv-track" });
  viewport.appendChild(track);

  STEPS.forEach(function (s, idx) {
    var slide = el("section", { class: "sv-slide", "aria-label": s.aria });
    slide.appendChild(el("h3", { class: "sv-q", text: s.q }));
    if (s.type === "choice") {
      var list = el("div", { class: "sv-choices" });
      refs.choices[s.key] = [];
      s.options.forEach(function (opt) {
        var b = el("button", { type: "button", class: "sv-choice", text: opt });
        b.addEventListener("click", function () { pickChoice(idx, s.key, opt); });
        refs.choices[s.key].push(b);
        list.appendChild(b);
      });
      slide.appendChild(list);
    } else {
      var input = el("input", {
        id: "sv-" + s.key, name: s.key, type: s.type === "tel" ? "tel" : s.type, class: "sv-field",
        placeholder: s.placeholder, autocomplete: s.autocomplete, enterkeyhint: "done",
        inputmode: s.type === "tel" ? "numeric" : s.type === "email" ? "email" : undefined, "aria-label": s.aria,
      });
      if (s.type === "tel") {
        input.addEventListener("input", function () {
          var d = nationalDigits(input.value);
          state.phone = d;
          phoneEditedAt = Date.now();
          input.value = formatPhone(d);
          setError(s.key, "");
        });
      } else {
        input.addEventListener("input", function () { setError(s.key, ""); });
      }
      refs.inputs[s.key] = input;
      slide.appendChild(el("label", { for: "sv-" + s.key, class: "sv-hp", text: s.aria }));
      slide.appendChild(input);
      var err = el("p", { class: "sv-error", role: "alert", id: "sv-" + s.key + "-error" });
      refs.errors[s.key] = err;
      slide.appendChild(err);
      slide.appendChild(el("button", { type: "submit", class: "sv-cta", text: s.submit ? "Check My Eligibility" : "Continue" }));
      if (s.type === "tel") slide.appendChild(el("p", { class: "sv-hint", text: "We'll only use this to confirm your strategy session." }));
    }
    track.appendChild(slide);
  });

  form.appendChild(back);
  form.appendChild(hp);
  form.appendChild(progressWrap);
  form.appendChild(viewport);
  mount.appendChild(form);

  /* ---------------- layout: pixel-measured strip (non-Safari) ---------------- */
  var slidePx = 0;
  function layout() {
    if (isSafari) {
      Array.prototype.forEach.call(track.children, function (sl, i) { sl.classList.toggle("is-active", i === state.step); });
      return;
    }
    var w = viewport.getBoundingClientRect().width;
    if (w > 0) slidePx = w;
    Array.prototype.forEach.call(track.children, function (sl) { sl.style.width = slidePx + "px"; sl.style.flex = "0 0 " + slidePx + "px"; });
    track.style.width = slidePx * TOTAL + "px";
    track.style.transform = "translate3d(-" + state.step * slidePx + "px,0,0)";
  }
  if (!isSafari && window.ResizeObserver) new ResizeObserver(layout).observe(viewport);
  window.addEventListener("resize", layout);

  function render() {
    var pct = ENDOWED_PROGRESS[Math.min(state.step, TOTAL - 1)];
    progressFill.style.width = pct + "%";
    progressLabel.textContent = pct + "%";
    progress.setAttribute("aria-valuenow", String(pct));
    progress.setAttribute("aria-label", "Survey progress " + pct + " percent");
    back.hidden = state.step < 1;
    mount.classList.toggle("has-back", state.step >= 1);
    layout();
  }

  function setError(key, msg) {
    var e = refs.errors[key], i = refs.inputs[key];
    if (e) e.textContent = msg || "";
    if (i) { i.classList.toggle("is-error", !!msg); i.setAttribute("aria-invalid", msg ? "true" : "false"); }
  }

  function focusStep(step) {
    var s = STEPS[step];
    if (!s || s.type === "choice") return;
    var i = refs.inputs[s.key];
    var f = function () { try { i.focus({ preventScroll: true }); } catch (e) { i.focus(); } };
    f(); setTimeout(f, 50); setTimeout(f, 200);
  }

  function goTo(step) {
    state.step = Math.max(0, Math.min(TOTAL - 1, step));
    render();
    if (state.step >= PHONE_STEP) scheduleAbandonTimer(); else clearAbandonTimer();
  }

  function pickChoice(idx, key, value) {
    if (state.advancing) return;
    state.answers[key] = value;
    mirrors[key].value = value;
    refs.choices[key].forEach(function (b) { b.classList.toggle("is-selected", b.textContent === value); });
    state.advancing = true;
    refs.choices[key].forEach(function (b) { b.disabled = true; });
    focusStep(idx + 1); // inside the tap so iOS raises the keyboard for the next typing step
    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(function () {
      state.advancing = false;
      refs.choices[key].forEach(function (b) { b.disabled = false; });
      goTo(idx + 1);
      focusStep(idx + 1);
    }, AUTO_ADVANCE_MS);
  }

  back.addEventListener("click", function () {
    clearTimeout(advanceTimer); state.advancing = false;
    Object.keys(refs.choices).forEach(function (k) { refs.choices[k].forEach(function (b) { b.disabled = false; }); });
    goTo(state.step - 1);
  });

  /* ---------------- contact read + partial save ---------------- */
  function readContact() {
    var digits = nationalDigits(refs.inputs.phone.value || state.phone);
    return {
      name: (refs.inputs.name.value || "").trim(),
      email: (refs.inputs.email.value || "").trim(),
      city: (refs.inputs.city.value || "").trim(),
      digits: digits,
      phone: phoneE164(digits),
    };
  }

  function payloadBase() {
    var c = readContact();
    var p = {};
    ["timeline", "business_owner", "capital"].forEach(function (k) { if (state.answers[k]) p[k] = state.answers[k]; });
    if (c.city) p.city = c.city;
    if (c.name) p.name = c.name;
    if (c.email) p.email = c.email;
    if (c.phone) p.phone = c.phone;
    p[HONEYPOT_FIELD] = hpInput.value || "";
    p.tracking = trackingForSubmit();
    return p;
  }

  function sendPartial(force) {
    if (partialSent || fullSent) return;
    var c = readContact();
    if (!c.phone || c.digits.length !== 10) return;
    if (!force && Date.now() - phoneEditedAt < PHONE_SETTLE_MS) return;
    var body = payloadBase();
    body.survey_partial = true;
    try {
      fetch(API + "/lead/partial", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true })
        .then(function (r) { if (r.ok) { partialSent = true; partialPhone = c.phone; } }).catch(function () {});
    } catch (e) {}
  }

  function clearAbandonTimer() { if (abandonTimer) { clearTimeout(abandonTimer); abandonTimer = null; } }
  function scheduleAbandonTimer() {
    clearAbandonTimer();
    abandonTimer = setTimeout(function fire() {
      if (Date.now() - phoneEditedAt < PHONE_SETTLE_MS) { abandonTimer = setTimeout(fire, PHONE_SETTLE_MS); return; }
      abandonTimer = null;
      sendPartial(false);
    }, SURVEY_ABANDON_MS);
  }
  window.addEventListener("pagehide", function () { if (state.step >= PHONE_STEP) sendPartial(true); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden" && state.step >= PHONE_STEP) sendPartial(false);
  });

  /* ---------------- typing steps ---------------- */
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var s = STEPS[state.step];
    if (!s || s.type === "choice" || state.submitting) return;
    var c = readContact();
    if (s.key === "city") {
      if (c.city.length < 2) { setError("city", "Please enter your city."); return; }
      setError("city", ""); goTo(state.step + 1); focusStep(state.step); return;
    }
    if (s.key === "name") {
      if (!c.name) { setError("name", "Please enter your full name"); return; }
      setError("name", ""); goTo(state.step + 1); focusStep(state.step); return;
    }
    if (s.key === "email") {
      if (!isValidEmail(c.email)) { setError("email", "Please enter a valid email address"); return; }
      setError("email", ""); goTo(state.step + 1); focusStep(state.step); return;
    }
    if (s.key === "phone") {
      if (!c.phone) { setError("phone", "Enter a valid 10-digit phone number"); return; }
      setError("phone", ""); submitSurvey(); return;
    }
  });

  /* ---------------- final submit + routing ---------------- */
  function setSubmitting(on) {
    state.submitting = on;
    var btn = track.lastElementChild.querySelector(".sv-cta");
    if (btn) { btn.disabled = on; btn.textContent = on ? "Submitting…" : "Check My Eligibility"; }
  }

  function submitSurvey() {
    var c = readContact();
    if (!c.phone) { setError("phone", "Enter a valid 10-digit phone number"); goTo(PHONE_STEP); return; }
    if (!state.answers.timeline || !state.answers.business_owner || !state.answers.capital) { goTo(0); return; }
    setSubmitting(true);
    var body = payloadBase();
    if (partialPhone && partialPhone !== c.phone) body.superseded_phone = partialPhone;
    fetch(API + "/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) { return { res: res, data: data || {} }; });
      })
      .then(function (r) {
        if (!r.res.ok) {
          var msg = typeof r.data.error === "string" ? r.data.error
            : r.res.status === 429 ? "Too many submissions. Please wait a moment and try again." : "Something went wrong. Please try again.";
          setError("phone", msg);
          return;
        }
        fullSent = true; clearAbandonTimer();
        if (r.data.silent) showPanel("thanks", c);
        else if (r.data.route === "dq") showPanel("dq", c);
        else startBooking(c);
      })
      .catch(function () { setError("phone", "Something went wrong. Please try again."); })
      .then(function () { setSubmitting(false); });
  }

  function firstName(c) { return (c.name || "").trim().split(/\s+/)[0] || ""; }

  function showPanel(kind, c) {
    form.remove();
    var panel = el("div", { class: "sv-panel", role: "status" });
    if (kind === "dq") {
      panel.appendChild(el("div", { class: "sv-panel-icon", text: "🙏" }));
      panel.appendChild(el("h3", { text: "Thanks for your honesty" + (firstName(c) ? ", " + firstName(c) : "") + "." }));
      panel.appendChild(el("p", { html: "Our dealer program requires a minimum of <strong>$20,000 in accessible capital</strong>, so a strategy session wouldn't be a good use of your time right now. When that changes, come back and apply again — we'd love to talk." }));
    } else {
      panel.appendChild(el("div", { class: "sv-panel-icon", text: "✅" }));
      panel.appendChild(el("h3", { text: "Your application is in" + (firstName(c) ? ", " + firstName(c) : "") + "!" }));
      panel.appendChild(el("p", { html: "Someone from our team will reach out to you shortly at <strong>" + (c.phone ? formatPhone(c.digits) : "the number you entered") + "</strong> to go over your territory and next steps." }));
    }
    mount.appendChild(panel);
    scrollIntoView();
  }

  /* ---------------- native booking calendar (slots + book via the API) ---------------- */
  var TZ_CHOICES = [
    ["America/New_York", "Eastern"], ["America/Chicago", "Central"], ["America/Denver", "Mountain"], ["America/Phoenix", "Arizona"],
    ["America/Los_Angeles", "Pacific"], ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"],
    ["America/Halifax", "Atlantic"], ["America/St_Johns", "Newfoundland"], ["America/Toronto", "Toronto"], ["America/Vancouver", "Vancouver"],
    ["America/Edmonton", "Edmonton"], ["America/Winnipeg", "Winnipeg"]
  ];
  var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  function browserTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"; } catch (e) { return "America/New_York"; } }
  function tzLabel(tz) {
    var city = tz.split("/").pop().replace(/_/g, " ");
    var off = "";
    try {
      var parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date());
      var p = parts.filter(function (x) { return x.type === "timeZoneName"; })[0];
      if (p) off = p.value.replace("GMT", "UTC");
    } catch (e) {}
    return city + (off ? " (" + off + ")" : "");
  }
  function fmtInTz(iso, tz, opts) { return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: tz }, opts)).format(new Date(iso)); }
  function ymdInTz(iso, tz) {
    var parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
    var o = {}; parts.forEach(function (x) { o[x.type] = x.value; });
    return o.year + "-" + o.month + "-" + o.day;
  }
  function hmsInTz(iso, tz) {
    var parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(iso));
    var o = {}; parts.forEach(function (x) { o[x.type] = x.value; });
    return (o.hour === "24" ? "00" : o.hour) + ":" + o.minute + ":" + o.second;
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(y, m, d) { return y + "-" + pad(m + 1) + "-" + pad(d); }

  function startBooking(c) {
    if (!API) { return CALENDAR_URL ? showCalendar(c) : showPanel("thanks", c); }
    var tz = browserTz();
    var now = new Date();
    fetch(API + "/slots?start=" + ymd(now.getFullYear(), now.getMonth(), 1) + "&end=" + ymd(now.getFullYear(), now.getMonth(), new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()) + "&tz=" + encodeURIComponent(tz))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && d.configured) renderBooking(c, tz, { y: now.getFullYear(), m: now.getMonth(), dates: d.dates || {} });
        else if (CALENDAR_URL) showCalendar(c);
        else showPanel("thanks", c);
      })
      .catch(function () { if (CALENDAR_URL) showCalendar(c); else showPanel("thanks", c); });
  }

  function renderBooking(c, tz, first) {
    form.remove();
    var st = { tz: tz, y: first.y, m: first.m, dates: first.dates, day: null, slot: null, loading: false };
    var cache = {}; cache[st.y + "-" + st.m + "-" + tz] = first.dates;

    var root = el("div", { class: "sv-cal" });
    var left = el("div", { class: "sv-cal-left" });
    left.appendChild(el("div", { class: "sv-cal-thanks" }, [el("h3", { text: "Thank you!" }), el("p", { text: "Your submission has been received." })]));
    var nav = el("div", { class: "sv-cal-nav" });
    var prevBtn = el("button", { type: "button", class: "sv-cal-arrow", "aria-label": "Previous month", text: "‹" });
    var monthLbl = el("span", { class: "sv-cal-month" });
    var nextBtn = el("button", { type: "button", class: "sv-cal-arrow", "aria-label": "Next month", text: "›" });
    nav.appendChild(prevBtn); nav.appendChild(monthLbl); nav.appendChild(nextBtn);
    left.appendChild(nav);
    var grid = el("div", { class: "sv-cal-grid", role: "grid" });
    left.appendChild(grid);
    var foot = el("div", { class: "sv-cal-foot" });
    var tzSel = el("select", { class: "sv-cal-tz", "aria-label": "Time zone" });
    var choices = TZ_CHOICES.slice();
    if (!choices.some(function (x) { return x[0] === tz; })) choices.unshift([tz, tz.split("/").pop().replace(/_/g, " ")]);
    choices.forEach(function (x) { var o = el("option", { value: x[0], text: "🌐 " + tzLabel(x[0]) }); if (x[0] === tz) o.selected = true; tzSel.appendChild(o); });
    var clock = el("span", { class: "sv-cal-now" });
    foot.appendChild(tzSel); foot.appendChild(clock);
    left.appendChild(foot);

    var right = el("div", { class: "sv-cal-right" });
    var dayH = el("h3", { class: "sv-cal-day" });
    var countP = el("p", { class: "sv-cal-count" });
    var times = el("div", { class: "sv-cal-times" });
    var err = el("p", { class: "sv-error", role: "alert" });
    var selectBtn = el("button", { type: "button", class: "sv-cta sv-cal-select", text: "Select Timeslot", disabled: true });
    right.appendChild(dayH); right.appendChild(countP); right.appendChild(times); right.appendChild(err); right.appendChild(selectBtn);
    root.appendChild(left); root.appendChild(right);
    mount.appendChild(root);

    function tick() { clock.textContent = fmtInTz(new Date(), st.tz, { hour: "numeric", minute: "2-digit" }); }
    tick(); var clockTimer = setInterval(tick, 30000);

    function todayYmd() { return ymdInTz(new Date(), st.tz); }
    function slotsFor(day) { return (st.dates[day] || []).filter(function (iso) { return new Date(iso).getTime() > Date.now(); }); }

    function drawMonth() {
      monthLbl.textContent = MONTHS[st.m] + " " + st.y;
      grid.innerHTML = "";
      ["S", "M", "T", "W", "T", "F", "S"].forEach(function (d) { grid.appendChild(el("div", { class: "sv-cal-dow", text: d })); });
      var firstDow = new Date(st.y, st.m, 1).getDay();
      var daysIn = new Date(st.y, st.m + 1, 0).getDate();
      var prevDays = new Date(st.y, st.m, 0).getDate();
      var today = todayYmd();
      for (var i = 0; i < 42; i++) {
        var n = i - firstDow + 1;
        var cell;
        if (n < 1) cell = el("div", { class: "sv-cal-cell is-outside", text: String(prevDays + n) });
        else if (n > daysIn) cell = el("div", { class: "sv-cal-cell is-outside", text: String(n - daysIn) });
        else {
          var key = ymd(st.y, st.m, n);
          var avail = slotsFor(key).length > 0;
          cell = el("button", { type: "button", class: "sv-cal-cell" + (avail ? " is-avail" : " is-off") + (key === today ? " is-today" : "") + (key === st.day ? " is-selected" : ""), text: String(n), disabled: !avail });
          if (avail) cell.addEventListener("click", (function (k) { return function () { st.day = k; st.slot = null; drawMonth(); drawTimes(); }; })(key));
        }
        grid.appendChild(cell);
        if (n > daysIn && (i + 1) % 7 === 0) break;
      }
      var nowD = new Date();
      prevBtn.disabled = st.y < nowD.getFullYear() || (st.y === nowD.getFullYear() && st.m <= nowD.getMonth());
    }

    function drawTimes() {
      times.innerHTML = ""; err.textContent = ""; selectBtn.disabled = true;
      if (!st.day) { dayH.textContent = "Pick a day"; countP.textContent = "Choose a highlighted date to see times."; return; }
      var list = slotsFor(st.day);
      dayH.textContent = fmtInTz(st.day + "T12:00:00", st.tz, { weekday: "long", month: "short", day: "numeric" });
      countP.textContent = list.length + (list.length === 1 ? " time available" : " times available");
      list.forEach(function (iso) {
        var b = el("button", { type: "button", class: "sv-cal-time" + (iso === st.slot ? " is-selected" : ""), text: fmtInTz(iso, st.tz, { hour: "numeric", minute: "2-digit" }) });
        b.addEventListener("click", function () { st.slot = iso; selectBtn.disabled = false; Array.prototype.forEach.call(times.children, function (x) { x.classList.toggle("is-selected", x === b); }); });
        times.appendChild(b);
      });
    }

    function pickFirstDay() {
      var keys = Object.keys(st.dates).sort();
      for (var i = 0; i < keys.length; i++) { if (slotsFor(keys[i]).length) { st.day = keys[i]; return; } }
      st.day = null;
    }

    function loadMonth() {
      var key = st.y + "-" + st.m + "-" + st.tz;
      var apply = function (dates) { st.dates = dates; if (!st.day || st.day.slice(0, 7) !== ymd(st.y, st.m, 1).slice(0, 7)) pickFirstDay(); drawMonth(); drawTimes(); };
      if (cache[key]) { apply(cache[key]); return; }
      st.loading = true; grid.classList.add("is-loading");
      fetch(API + "/slots?start=" + ymd(st.y, st.m, 1) + "&end=" + ymd(st.y, st.m, new Date(st.y, st.m + 1, 0).getDate()) + "&tz=" + encodeURIComponent(st.tz))
        .then(function (r) { return r.json(); })
        .then(function (d) { cache[key] = (d && d.ok && d.dates) || {}; apply(cache[key]); })
        .catch(function () { apply({}); err.textContent = "Could not load availability. Please try again."; })
        .then(function () { st.loading = false; grid.classList.remove("is-loading"); });
    }

    prevBtn.addEventListener("click", function () { if (st.m === 0) { st.m = 11; st.y--; } else st.m--; st.day = null; loadMonth(); });
    nextBtn.addEventListener("click", function () { if (st.m === 11) { st.m = 0; st.y++; } else st.m++; st.day = null; loadMonth(); });
    tzSel.addEventListener("change", function () { st.tz = tzSel.value; st.day = null; st.slot = null; tick(); loadMonth(); });

    selectBtn.addEventListener("click", function () {
      if (!st.slot) return;
      selectBtn.disabled = true; selectBtn.textContent = "Booking…"; err.textContent = "";
      fetch(API + "/book", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: c.phone, start: st.slot, tz: st.tz }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
          if (!r.ok || !r.data.ok) {
            err.textContent = r.data.error || "Could not book that time. Please pick another slot.";
            selectBtn.textContent = "Select Timeslot"; selectBtn.disabled = false;
            delete cache[st.y + "-" + st.m + "-" + st.tz]; st.slot = null; loadMonth();
            return;
          }
          clearInterval(clockTimer);
          var a = r.data.appointment;
          var q = new URLSearchParams();
          q.set("event_type_name", a.title || "Dealer Strategy Session");
          q.set("date", ymdInTz(a.start, st.tz));
          q.set("event_start_time", hmsInTz(a.start, st.tz));
          q.set("event_end_time", hmsInTz(a.end, st.tz));
          q.set("timezone", st.tz);
          if (c.name) q.set("full_name", c.name);
          if (c.email) q.set("email", c.email);
          if (c.phone) q.set("phone", c.phone);
          window.location.href = THANKYOU_URL + "?" + q.toString();
        })
        .catch(function () { err.textContent = "Something went wrong. Please try again."; selectBtn.textContent = "Select Timeslot"; selectBtn.disabled = false; });
    });

    pickFirstDay(); drawMonth(); drawTimes(); scrollIntoView();
  }

  function showCalendar(c) {
    form.remove();
    var parts = (c.name || "").trim().split(/\s+/);
    var url = new URL(CALENDAR_URL);
    if (parts[0]) url.searchParams.set("first_name", parts[0]);
    if (parts.length > 1) url.searchParams.set("last_name", parts.slice(1).join(" "));
    if (c.email) url.searchParams.set("email", c.email);
    if (c.phone) url.searchParams.set("phone", c.phone);
    var wrap = el("div", { class: "sv-calendar" });
    var head = el("div", { class: "sv-calendar-head" });
    head.appendChild(el("h3", { text: "You're pre-qualified" + (parts[0] ? ", " + parts[0] : "") + "!" }));
    head.appendChild(el("p", { text: "Pick a time for your Dealer Strategy Session below." }));
    wrap.appendChild(head);
    var frame = el("div", { class: "sv-calendar-frame" });
    var iframe = el("iframe", { src: url.toString(), title: "Book your Dealer Strategy Session", scrolling: "no", id: "sv-ghl-calendar" });
    frame.appendChild(iframe);
    wrap.appendChild(frame);
    mount.appendChild(wrap);
    if (!document.querySelector('script[src*="form_embed.js"]')) {
      var s = document.createElement("script"); s.src = "https://link.msgsndr.com/js/form_embed.js"; s.async = true; document.body.appendChild(s);
    }
    scrollIntoView();
  }

  function scrollIntoView() {
    try { (mount.closest(".typeform-container") || mount).scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {}
  }

  render();
})();
