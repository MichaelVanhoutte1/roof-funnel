/**
 * Private lead tracking page (/admin/): report, leads and disqualification rules.
 * Talks to the Worker's /admin/* endpoints with the admin key, kept in this tab only (sessionStorage).
 * Everything is rendered with textContent, so nothing a lead typed can run as markup.
 */
(function () {
  "use strict";

  var root = document.getElementById("admin");
  if (!root) return;

  var API = (root.getAttribute("data-api") || "").replace(/\/+$/, "");
  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  var override = new URLSearchParams(window.location.search).get("api");
  if (isLocal && override) API = override.replace(/\/+$/, ""); // local preview against a local Worker only

  var TOKEN_KEY = "rf_admin_key";
  var state = { tab: "overview", range: "month", from: "", to: "", report: null, leads: null, sales: null, rules: null, questions: [], busy: false, open: {} };

  /* sessionStorage, not localStorage: the key is visible to this tab only, which loads no third-party script.
     (The public funnel pages on this domain load vendor scripts; those must never be able to read it.) */
  var memoryToken = "";
  function getToken() { try { return sessionStorage.getItem(TOKEN_KEY) || memoryToken; } catch (e) { return memoryToken; } }
  function setToken(v) { memoryToken = v || ""; try { if (v) sessionStorage.setItem(TOKEN_KEY, v); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "on") Object.keys(v).forEach(function (ev) { n.addEventListener(ev, v[ev]); });
      else n.setAttribute(k, v === true ? "" : v);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(API + path, {
      method: opts.method || "GET",
      headers: Object.assign({ Authorization: "Bearer " + getToken() }, opts.body ? { "Content-Type": "application/json" } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) { setToken(""); var e = new Error("unauthorized"); e.unauthorized = true; throw e; }
        if (!res.ok || !data.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
        return data;
      });
    });
  }

  /* ---------------- formatting ---------------- */
  /* Lucide outlines (the icons CSP's nav uses), drawn inline so the page loads nothing from a CDN. */
  var ICONS = {
    handshake: ["m11 17 2 2a1 1 0 1 0 3-3", "m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4", "m21 3 1 11h-2", "M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3", "M3 4h8"],
    dollar: ["M12 2v20", "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"],
    calcheck: ["M8 2v4", "M16 2v4", "M3 10h18", "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "m9 16 2 2 4-4"],
    activity: ["M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"],
    users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M16 3.13a4 4 0 0 1 0 7.75", "M22 21v-2a4 4 0 0 0-3-3.87", "M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"],
    sliders: ["M21 4h-7", "M10 4H3", "M21 12h-9", "M8 12H3", "M21 20h-5", "M12 20H3", "M14 2v4", "M8 10v4", "M16 18v4"],
    chevron: ["m6 9 6 6 6-6"],
    logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  };
  function svg(name, cls) {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("class", "ic" + (cls ? " " + cls : "")); s.setAttribute("aria-hidden", "true");
    (ICONS[name] || []).forEach(function (d) { var p = document.createElementNS(ns, "path"); p.setAttribute("d", d); s.appendChild(p); });
    return s;
  }
  function num(n) { return (n || 0).toLocaleString("en-US"); }
  function pct(r) { return r == null ? "–" : Math.round(r * 100) + "%"; }
  function money(n) { return n == null ? "–" : "$" + Math.round(n).toLocaleString("en-US"); }
  function day(iso) { if (!iso) return "–"; var d = new Date(iso); return isNaN(d) ? "–" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
  function dayTime(iso) { if (!iso) return "–"; var d = new Date(iso); return isNaN(d) ? "–" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  function duration(s) { if (s == null) return ""; var m = Math.floor(s / 60); return m ? m + " min " + (s % 60) + " s" : s + " s"; }

  /* ---------------- date range ---------------- */
  function rangeBounds() {
    // Same presets as CSP's DateRangePicker. "to" is exclusive; future-dated appointments are included when it is open.
    var now = new Date(), from = null, to = null;
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var daysAgo = function (n) { return new Date(now.getFullYear(), now.getMonth(), now.getDate() - n); };
    var r = state.range;
    if (r === "today") { from = today; to = daysAgo(-1); }
    else if (r === "yesterday") { from = daysAgo(1); to = today; }
    else if (r === "7") from = daysAgo(6);
    else if (r === "14") from = daysAgo(13);
    else if (r === "30") from = daysAgo(29);
    else if (r === "90") from = daysAgo(89);
    else if (r === "6m") from = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    else if (r === "1y") from = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    else if (r === "week") { var dow = (now.getDay() + 6) % 7; from = daysAgo(dow); }
    else if (r === "month") from = new Date(now.getFullYear(), now.getMonth(), 1);
    else if (r === "last-month") { from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 1); }
    else if (r === "quarter") from = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    else if (r === "custom") {
      if (state.from) from = new Date(state.from + "T00:00:00");
      if (state.to) { to = new Date(state.to + "T00:00:00"); to.setDate(to.getDate() + 1); }
    }
    var q = [];
    if (from && !isNaN(from)) q.push("from=" + encodeURIComponent(from.toISOString()));
    if (to && !isNaN(to)) q.push("to=" + encodeURIComponent(to.toISOString()));
    return q.length ? "?" + q.join("&") : "";
  }

  /* ---------------- login ---------------- */
  function renderLogin(message) {
    root.innerHTML = "";
    var input = el("input", { type: "password", autocomplete: "current-password", placeholder: "Admin key", "aria-label": "Admin key" });
    var err = el("p", { class: "error", role: "alert", text: message || "" });
    var form = el("form", { class: "card login", on: { submit: function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) return;
      setToken(v);
      load();
    } } }, [
      el("h1", { text: "Lead tracking" }),
      el("p", { class: "muted", text: "Start Roof Rejuvenating. Enter the admin key to continue." }),
      input, err,
      el("button", { type: "submit", class: "btn primary", text: "Sign in" }),
    ]);
    root.appendChild(form);
    input.focus();
  }

  /* ---------------- data ---------------- */
  function load() {
    if (!getToken()) return renderLogin();
    state.busy = true; render();
    var q = rangeBounds();
    Promise.all([api("/admin/report" + q), api("/admin/leads" + q), api("/admin/rules"), api("/admin/sales" + q)])
      .then(function (r) {
        state.report = r[0]; state.leads = r[1].leads; state.rules = r[2].rules; state.questions = r[2].questions; state.sales = r[3]; state.error = "";
      })
      .catch(function (e) {
        if (e.unauthorized) { state.busy = false; return renderLogin("That key was not accepted."); }
        state.error = e.message || "Could not load.";
      })
      .then(function () { state.busy = false; if (getToken()) render(); });
  }

  /* ---------------- overview (same layout as the CSP Lead Scoring page) ---------------- */
  var SECTIONS = { capital: "Capital", timeline: "Urgency", business_owner: "Avatar", credit_score: "Credit", credit_offer: "Financing", result: "Funnel" };

  /* Score weights the setter show, closer show, close and book rates (close % = won ÷ closer showed, from the server). */
  function scoreBadge(r) {
    var composite = (r.showRate || 0) * 0.3 + (r.closerShowRate || 0) * 0.2 + (r.closeRate || 0) * 0.3 + (r.bookRate || 0) * 0.2;
    return composite >= 0.45 ? pill("Best", "good") : composite >= 0.25 ? pill("Avg", "warn") : pill("Weak");
  }
  /* [group, label, value, class]. Setter columns are the funnel's own booking; closer columns are the call the setter books afterwards. */
  var COLUMNS = [
    ["", "Leads", function (r) { return num(r.leads); }],
    ["Setter", "Booked", function (r) { return num(r.booked); }, "grp"],
    ["Setter", "Book %", function (r) { return pct(r.bookRate); }, "muted"],
    ["Setter", "Showed", function (r) { return num(r.showed); }],
    ["Setter", "Show %", function (r) { return pct(r.showRate); }],
    ["Closer", "Booked", function (r) { return num(r.closerBooked); }, "grp"],
    ["Closer", "Book %", function (r) { return pct(r.closerBookRate); }, "muted"],
    ["Closer", "Showed", function (r) { return num(r.closerShowed); }],
    ["Closer", "Show %", function (r) { return pct(r.closerShowRate); }],
    ["Sale", "Closed", function (r) { return num(r.won); }, "grp"],
    ["Sale", "Close %", function (r) { return pct(r.closeRate); }],
    ["Sale", "$ / booked", function (r) { return money(r.cashPerBooked); }],
  ];

  function groupRow() {
    var cells = [el("th", { class: "grp-head" })], i = 0;
    while (i < COLUMNS.length) {
      var g = COLUMNS[i][0], span = 0;
      while (i < COLUMNS.length && COLUMNS[i][0] === g) { span++; i++; }
      cells.push(el("th", { class: "grp-head" + (g ? " grp" : ""), colspan: String(span), text: g }));
    }
    cells.push(el("th", { class: "grp-head" }));
    return el("tr", null, cells);
  }

  function segmentSection(key, question, rows) {
    var head = el("tr", null, [el("th", { text: "Segment" })].concat(COLUMNS.map(function (c) { return el("th", { class: c[3] === "grp" ? "grp" : null, text: c[1] }); })).concat([el("th", { text: "Score" })]));
    var body = rows.map(function (r) {
      return el("tr", null, [el("td", { class: "segment", text: r.label })]
        .concat(COLUMNS.map(function (c) { return el("td", { class: c[3] || null, text: c[2](r) }); }))
        .concat([el("td", null, [scoreBadge(r)])]));
    });
    var details = el("details", { class: "acc" }, [
      el("summary", null, [el("div", null, [el("p", { class: "acc-tag", text: SECTIONS[key] }), el("p", { class: "acc-q", text: question })])]),
      el("div", { class: "scroll" }, [el("table", { class: "seg" }, [el("thead", null, [groupRow(), head]), el("tbody", null, body)])]),
    ]);
    details.open = !!state.open[key];
    details.addEventListener("toggle", function () { state.open[key] = details.open; });
    return details;
  }

  function stat(label, value, sub) {
    return el("div", { class: "stat" }, [el("div", { class: "label", text: label }), el("div", { class: "value", text: value }), el("div", { class: "sub", text: sub || "" })]);
  }

  function syncErrors(s) {
    if (!s) return [];
    return ["pipeline", "closerAppointments", "setterCalls", "closerAttendance"].filter(function (k) { return s[k] && s[k].error; }).map(function (k) { return k + ": " + s[k].error; });
  }

  function renderOverview(box) {
    var data = state.report; if (!data) return;
    var r = data.report, t = r.totals;
    box.appendChild(el("div", { class: "cards" }, [
      stat("Total Leads", num(t.leads), num(t.qualified) + " sent to the calendar"),
      stat("Setter Booked", num(t.booked), pct(t.bookRate) + " of leads"),
      stat("Setter Show Rate", pct(t.showRate), num(t.showed) + " showed · " + num(t.noShow) + " no-show"),
      stat("Closer Booked", num(t.closerBooked), pct(t.closerBookRate) + " of setter shows"),
      stat("Closer Show Rate", pct(t.closerShowRate), num(t.closerShowed) + " showed · " + num(t.closerNoShow) + " no-show"),
      stat("Close Rate", pct(t.closeRate), num(t.won) + " won of " + num(t.closerShowed) + " closer shows"),
      stat("$ / Booked Call", money(t.cashPerBooked), money(t.cash) + " cash"),
    ]));
    if (r.unknownStages && r.unknownStages.length) {
      box.appendChild(el("div", { class: "notice warn", text: "These GHL pipeline stages are not recognised and count as no outcome: " + r.unknownStages.join(", ") + ". Tell Claude if a stage was renamed or added." }));
    }
    var errs = syncErrors(data.sync);
    if (errs.length) box.appendChild(el("div", { class: "notice bad", text: "The last sync had a problem. " + errs.join(" · ") }));
    r.segments.forEach(function (s) { if (SECTIONS[s.key]) box.appendChild(segmentSection(s.key, s.title, s.rows)); });
  }

  /* ---------------- leads ---------------- */
  var DQ = {
    "answer:capital": "DQ: capital", "answer:timeline": "DQ: timeline", "answer:business_owner": "DQ: business owner",
    "credit:min_score": "DQ: credit score", "credit:min_offer": "DQ: financing amount", "credit:min_income": "DQ: income",
    "credit:no_score": "DQ: no credit file", "credit:freeze": "DQ: credit freeze",
  };
  function pill(text, kind) { return el("span", { class: "pill" + (kind ? " " + kind : ""), text: text }); }
  function resultCell(l) {
    if (l.status !== "full") return pill("Unfinished", "warn");
    if (l.route === "calendar") return pill("Calendar", "good");
    return pill(DQ[l.dq_reason] || "Disqualified", "bad");
  }
  function showCell(v, detail) {
    if (!v) return el("span", { class: "muted", text: "–" });
    var p = v === "showed" ? pill("Showed", "good") : v === "no_show" ? pill("No-show", "bad") : pill("Pending");
    return detail ? el("span", null, [p, " ", el("span", { class: "muted small", text: detail })]) : p;
  }
  function creditCell(l) {
    if (l.credit_status !== "success") return el("span", { class: "muted", text: l.credit_status ? "No result" : "–" });
    return el("span", { text: (l.credit_score == null ? "No file" : String(l.credit_score)) + (l.credit_offer ? " · " + l.credit_offer : "") });
  }
  function shortCapital(v) { return !v ? "–" : /financing/i.test(v) ? "Financing" : /^Yes/.test(v) ? "Has $20k" : "No capital"; }

  function renderLeads(box) {
    var leads = state.leads || [];
    var cols = ["Lead", "Applied", "Capital", "Timeline", "Owner", "Credit", "Funnel", "Setter call", "Stage in GHL", "Closer call", "Won"];
    var head = el("tr", null, cols.map(function (c, i) { return el("th", { class: i ? "left" : null, text: c }); }));
    var rows = leads.map(function (l) {
      var left = function (child) { return el("td", { class: "left" }, [child]); };
      return el("tr", null, [
        el("td", null, [el("div", { text: l.name || "(no name)" }), el("div", { class: "muted small", text: l.city || "" })]),
        left(document.createTextNode(day(l.created_at))),
        left(document.createTextNode(shortCapital(l.capital))),
        left(document.createTextNode(l.timeline || "–")),
        left(document.createTextNode(l.business_owner ? (/own/.test(l.business_owner) ? "Owns one" : "Starting") : "–")),
        left(creditCell(l)),
        left(resultCell(l)),
        left(showCell(l.setter, l.setter_call_seconds ? "longest call " + duration(l.setter_call_seconds) : l.appointment_start ? dayTime(l.appointment_start) : "")),
        left(document.createTextNode(l.pipeline_stage || "–")),
        left(showCell(l.closer, l.closer_start ? dayTime(l.closer_start) + (l.closer_source ? " · " + (l.closer_source === "google_meet" ? "Meet" : "Fathom") : "") : "")),
        left(l.won ? pill(l.cash ? money(l.cash) : "Won", "good") : el("span", { class: "muted", text: "–" })),
      ]);
    });
    box.appendChild(el("p", { class: "muted small", text: leads.length + " lead" + (leads.length === 1 ? "" : "s") + " in the selected dates" + (leads.length === 500 ? " (newest 500 shown)" : "") + "." }));
    box.appendChild(el("div", { class: "card" }, [el("div", { class: "scroll" }, [el("table", null, [el("thead", null, [head]), el("tbody", null, rows)])])]));
  }

  /* ---------------- rules ---------------- */
  function numberField(label, hint, key, prefix) {
    var input = el("input", { type: "number", min: "0", step: key === "minScore" ? "1" : "500", inputmode: "numeric", placeholder: "Off", "aria-label": label,
      value: state.rules.credit[key] == null ? "" : String(state.rules.credit[key]) });
    input.addEventListener("input", function () { var v = Number(input.value); state.rules.credit[key] = input.value !== "" && isFinite(v) && v > 0 ? v : null; state.dirty = true; });
    return el("div", { class: "field" }, [
      el("div", null, [el("div", { text: label }), el("div", { class: "muted small", text: hint })]),
      el("div", null, [prefix ? el("span", { class: "muted", text: prefix + " " }) : null, input]),
    ]);
  }
  function switchRow(label, hint, checked, onChange) {
    var box = el("input", { type: "checkbox" }); box.checked = !!checked;
    var text = el("span", { class: checked ? "is-dq" : null, text: checked ? "Disqualify" : "Allow" });
    box.addEventListener("change", function () { onChange(box.checked); text.textContent = box.checked ? "Disqualify" : "Allow"; text.className = box.checked ? "is-dq" : ""; state.dirty = true; });
    return el("div", { class: "rule" }, [
      el("div", null, [el("div", { text: label }), hint ? el("div", { class: "muted small", text: hint }) : null]),
      el("label", null, [box, text]),
    ]);
  }

  function renderRules(box) {
    var rules = state.rules; if (!rules) return;
    var status = el("span", { class: "muted small", role: "status" });
    box.appendChild(el("p", { class: "muted", text: "A lead that gives a disqualified answer, or breaks a credit rule, is still saved here but never sees the calendar. It gets a short \"we can't offer a session right now\" message instead." }));
    state.questions.forEach(function (q) {
      var card = el("div", { class: "card" }, [el("h2", { text: q.label })]);
      q.options.forEach(function (option) {
        card.appendChild(switchRow(option, "", rules.answers[q.key][option] === true, function (on) { if (on) rules.answers[q.key][option] = true; else delete rules.answers[q.key][option]; }));
      });
      box.appendChild(card);
    });

    var applies = el("select", { "aria-label": "Who the credit rules apply to" }, [
      el("option", { value: "all", text: "Everyone who is checked" }),
      el("option", { value: "financing", text: "Only leads who will use financing" }),
    ]);
    applies.value = rules.credit.appliesTo;
    applies.addEventListener("change", function () { rules.credit.appliesTo = applies.value; state.dirty = true; });
    box.appendChild(el("div", { class: "card" }, [
      el("h2", { text: "Credit check" }),
      el("p", { class: "muted small", text: "With any rule below switched on, the survey waits for the soft credit check before showing the calendar (usually a few seconds, 10 at most). If the check cannot run or does not answer in time, the lead is let through." }),
      el("div", { class: "field" }, [el("div", { text: "Apply these rules to" }), applies]),
      numberField("Minimum credit score", "Disqualify anyone scoring below this.", "minScore"),
      numberField("Minimum financing offered", "Disqualify anyone approved for less than this, or for nothing. People with no credit file are the switch below.", "minOfferAmount", "$"),
      numberField("Minimum yearly income", "Disqualify anyone whose estimated income is below this.", "minIncome", "$"),
      switchRow("No credit file found", "The check ran but could not find a credit file for the person.", rules.credit.noScore, function (on) { rules.credit.noScore = on; }),
      switchRow("Credit file is frozen", "", rules.credit.creditFreeze, function (on) { rules.credit.creditFreeze = on; }),
    ]));

    var save = el("button", { type: "button", class: "btn primary", text: "Save rules" });
    save.addEventListener("click", function () {
      var capital = state.questions.filter(function (q) { return q.key === "capital"; })[0];
      if (capital && capital.options.every(function (o) { return rules.answers.capital[o] === true; }) &&
          !window.confirm("Every capital answer is set to disqualify, so nobody will be able to book. Save anyway?")) return;
      save.disabled = true; status.textContent = "Saving…";
      api("/admin/rules", { method: "POST", body: { rules: rules } })
        .then(function (r) { state.rules = r.rules; state.dirty = false; status.textContent = "Saved. New applications use these rules within half a minute."; })
        .catch(function (e) { if (e.unauthorized) return renderLogin("Please sign in again."); status.textContent = "Not saved: " + e.message; })
        .then(function () { save.disabled = false; });
    });
    box.appendChild(el("div", { class: "bar" }, [save, status]));
  }

  /* ---------------- shell ---------------- */
  function render() {
    root.innerHTML = "";
    var presets = [["today", "Today"], ["yesterday", "Yesterday"], ["7", "Last 7 days"], ["14", "Last 14 days"], ["30", "Last 30 days"], ["90", "Last 90 days"],
      ["6m", "Last 6 months"], ["1y", "Last year"], ["week", "This week"], ["month", "This month"], ["last-month", "Last month"], ["quarter", "This quarter"],
      ["all", "All time"], ["custom", "Custom dates"]];
    var range = el("select", { "aria-label": "Date range" }, presets.map(function (p) { return el("option", { value: p[0], text: p[1] }); }));
    range.value = state.range;
    range.addEventListener("change", function () { state.range = range.value; if (state.range !== "custom") load(); else render(); });
    var custom = null;
    if (state.range === "custom") {
      var from = el("input", { type: "date", "aria-label": "From", value: state.from });
      var to = el("input", { type: "date", "aria-label": "To", value: state.to });
      from.addEventListener("change", function () { state.from = from.value; load(); });
      to.addEventListener("change", function () { state.to = to.value; load(); });
      custom = el("span", null, [from, " – ", to]);
    }
    var sync = el("button", { type: "button", class: "btn", text: "Sync outcomes now", title: "Pull the latest stages, call logs and closer calls from GHL" });
    sync.addEventListener("click", function () {
      sync.disabled = true; sync.textContent = "Syncing…";
      api("/admin/sync", { method: "POST", body: {} }).then(load).catch(function (e) {
        if (e.unauthorized) return renderLogin("Please sign in again.");
        state.error = "Sync failed: " + e.message; render();
      });
    });
    /* Shell like CSP's Layout: 256px sidebar (brand, nav groups, account row), page header strip, padded content. */
    var go = function (tab) {
      if (state.dirty && state.tab === "rules" && !window.confirm("You have unsaved rule changes. Leave without saving?")) return;
      state.tab = tab; state.menuOpen = false; render();
    };
    var navItem = function (tab, label, icon, nested) {
      return el("button", { type: "button", class: "nav-b" + (nested ? " nested" : "") + (state.tab === tab ? " active" : ""), "aria-current": state.tab === tab ? "page" : null, on: { click: function () { go(tab); } } }, [svg(icon), el("span", { text: label })]);
    };
    var salesOpen = state.salesOpen !== false;
    var nav = el("nav", { class: "nav", "aria-label": "Sections" }, [
      el("button", { type: "button", class: "nav-b group", "aria-expanded": salesOpen ? "true" : "false", on: { click: function () { state.salesOpen = !salesOpen; render(); } } }, [svg("handshake"), el("span", { class: "grow", text: "Sales" }), svg("chevron", salesOpen ? "chev open" : "chev")]),
      salesOpen ? el("div", { class: "nav-children" }, [navItem("leaderboard", "Leaderboard", "dollar", true), navItem("appointments", "Appointments", "calcheck", true), navItem("overview", "Lead Scoring", "activity", true)]) : null,
      navItem("leads", "Leads", "users"), navItem("rules", "Rules", "sliders"),
    ]);
    var sidebar = el("aside", { class: "sidebar" + (state.menuOpen ? " open" : "") }, [
      el("div", { class: "brand" }, [el("h1", { text: "Start Roof Rejuvenating" })]),
      nav,
      el("div", { class: "sidebar-foot" }, [el("button", { type: "button", class: "nav-b", on: { click: function () { setToken(""); renderLogin(); } } }, [svg("logout"), el("span", { text: "Sign out" })])]),
    ]);
    var titles = { overview: "Lead Scoring", leaderboard: "Sales Leaderboard", appointments: "Appointments", leads: "Leads", rules: "Rules" };
    var header = el("header", { class: "page-head" }, [
      el("button", { type: "button", class: "btn menu", "aria-label": "Menu", text: "☰", on: { click: function () { state.menuOpen = !state.menuOpen; render(); } } }),
      el("h2", { class: "page-title", text: titles[state.tab] || "" }),
      el("div", { class: "page-right" }, [range, custom, el("button", { type: "button", class: "btn", text: "Refresh", on: { click: load } }), sync]),
    ]);
    var box = el("div", { class: "content", role: "tabpanel" });
    if (state.error) box.appendChild(el("div", { class: "notice bad", role: "alert", text: state.error }));
    root.appendChild(el("div", { class: "shell" }, [sidebar, el("div", { class: "main" }, [header, box])]));
    if (state.busy && !state.report) { box.appendChild(el("p", { class: "muted", text: "Loading…" })); return; }
    if (state.tab === "overview") renderOverview(box);
    else if (state.tab === "leads") renderLeads(box);
    else if (state.tab === "leaderboard" || state.tab === "appointments") {
      // Sales views live in admin-sales.js (same page, same data); they get the helpers they need and nothing else.
      var sales = window.RFAdminSales;
      if (!sales) box.appendChild(el("p", { class: "muted", text: "The sales views did not load. Refresh the page." }));
      else sales[state.tab === "leaderboard" ? "renderLeaderboard" : "renderAppointments"](box, state.sales, { el: el, pill: pill, num: num, pct: pct, money: money, state: state, rerender: render });
    }
    else renderRules(box);
  }

  load();
})();
