/**
 * Private lead tracking page (/admin/): report, leads and disqualification rules.
 * Talks to the Worker's /admin/* endpoints with the admin key, kept in this browser only.
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
  var state = { tab: "overview", range: "month", from: "", to: "", report: null, leads: null, rules: null, questions: [], busy: false };

  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function setToken(v) { try { if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} }

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
  function num(n) { return (n || 0).toLocaleString("en-US"); }
  function pct(r) { return r == null ? "–" : Math.round(r * 100) + "%"; }
  function money(n) { return n == null ? "–" : "$" + Math.round(n).toLocaleString("en-US"); }
  function day(iso) { if (!iso) return "–"; var d = new Date(iso); return isNaN(d) ? "–" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
  function dayTime(iso) { if (!iso) return "–"; var d = new Date(iso); return isNaN(d) ? "–" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  function duration(s) { if (s == null) return ""; var m = Math.floor(s / 60); return m ? m + " min " + (s % 60) + " s" : s + " s"; }

  /* ---------------- date range ---------------- */
  function rangeBounds() {
    var now = new Date(), from = null, to = null;
    if (state.range === "month") from = new Date(now.getFullYear(), now.getMonth(), 1);
    else if (state.range === "last-month") { from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 1); }
    else if (state.range === "7") from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    else if (state.range === "30") from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
    else if (state.range === "custom") {
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
    Promise.all([api("/admin/report" + q), api("/admin/leads" + q), api("/admin/rules")])
      .then(function (r) {
        state.report = r[0]; state.leads = r[1].leads; state.rules = r[2].rules; state.questions = r[2].questions; state.error = "";
      })
      .catch(function (e) {
        if (e.unauthorized) { state.busy = false; return renderLogin("That key was not accepted."); }
        state.error = e.message || "Could not load.";
      })
      .then(function () { state.busy = false; if (getToken()) render(); });
  }

  /* ---------------- overview ---------------- */
  var COLUMNS = [
    ["Leads", function (r) { return num(r.leads); }],
    ["Qualified", function (r) { return num(r.qualified); }, "Completed the survey and was sent to the calendar"],
    ["Booked", function (r) { return num(r.booked); }, "Booked the setter call"],
    ["Book %", function (r) { return pct(r.bookRate); }, "Booked ÷ leads", true],
    ["Showed", function (r) { return num(r.showed); }, "Booked and had the setter conversation"],
    ["No-show", function (r) { return num(r.noShow); }],
    ["Show %", function (r) { return pct(r.showRate); }, "Showed ÷ (showed + no-show)", true],
    ["Setter DQ", function (r) { return num(r.setterDq); }, "Turned away by the setter"],
    ["To closer", function (r) { return num(r.toCloser); }, "Passed on to a closer call"],
    ["Closer show", function (r) { return num(r.closerShowed); }, "Showed up to the closer call"],
    ["Closer %", function (r) { return pct(r.closerShowRate); }, "Closer showed ÷ (closer showed + closer no-show)", true],
    ["Won", function (r) { return num(r.won); }],
    ["Close %", function (r) { return pct(r.closeRate); }, "Won ÷ closer showed", true],
    ["Cash", function (r) { return money(r.cash); }, "Opportunity value of won deals"],
    ["$ / booked", function (r) { return money(r.cashPerBooked); }, "Cash ÷ booked"],
  ];

  function segmentTable(title, rows) {
    var head = el("tr", null, [el("th", { text: title })].concat(COLUMNS.map(function (c) { return el("th", { text: c[0], title: c[2] }); })));
    var body = rows.map(function (r) {
      return el("tr", null, [el("td", { text: r.label })].concat(COLUMNS.map(function (c) { return el("td", { class: c[3] ? "rate" : null, text: c[1](r) }); })));
    });
    return el("div", { class: "card" }, [el("div", { class: "scroll" }, [el("table", null, [el("thead", null, [head]), el("tbody", null, body)])])]);
  }

  function stat(label, value, sub) {
    return el("div", { class: "stat" }, [el("div", { class: "label", text: label }), el("div", { class: "value", text: value }), el("div", { class: "sub", text: sub || "" })]);
  }

  function syncLine(data) {
    var c = data.connections || {}, s = data.sync;
    var parts = [
      "GHL " + (c.ghl ? "connected" : "not connected"),
      "credit checks " + (c.simplecheck ? "on" : "off"),
      "closer attendance: " + (c.googleMeet ? "Google Meet" : c.fathom ? "Fathom" : "pipeline stage only (no Fathom or Google Meet key yet)"),
      "last sync " + (s && s.at ? dayTime(s.at) : "never"),
    ];
    if (s && s.setterCalls && s.setterCalls.remaining) parts.push(s.setterCalls.remaining + " call logs still to fetch");
    return parts.join(" · ");
  }

  function syncErrors(s) {
    if (!s) return [];
    return ["pipeline", "closerAppointments", "setterCalls", "closerAttendance"].filter(function (k) { return s[k] && s[k].error; }).map(function (k) { return k + ": " + s[k].error; });
  }

  function renderOverview(box) {
    var data = state.report; if (!data) return;
    var r = data.report, t = r.totals;
    box.appendChild(el("div", { class: "cards" }, [
      stat("Total leads", num(t.leads), num(t.booked) + " booked a call"),
      stat("Book rate", pct(t.bookRate), num(t.qualified) + " sent to the calendar"),
      stat("Show rate (setter)", pct(t.showRate), num(t.showed) + " showed · " + num(t.noShow) + " no-show"),
      stat("Show rate (closer)", pct(t.closerShowRate), num(t.toCloser) + " passed to a closer"),
      stat("Close rate", pct(t.closeRate), num(t.won) + " won"),
      stat("$ / booked call", money(t.cashPerBooked), money(t.cash) + " cash"),
    ]));
    if (r.unknownStages && r.unknownStages.length) {
      box.appendChild(el("div", { class: "notice warn", text: "These GHL pipeline stages are not recognised and count as no outcome: " + r.unknownStages.join(", ") + ". Tell Claude if a stage was renamed or added." }));
    }
    var errs = syncErrors(data.sync);
    if (errs.length) box.appendChild(el("div", { class: "notice bad", text: "The last sync had a problem. " + errs.join(" · ") }));
    r.segments.forEach(function (s) { box.appendChild(segmentTable(s.title, s.rows)); });
    box.appendChild(el("div", { class: "card" }, [
      el("h2", { text: "How this is counted" }),
      el("div", { class: "legend" }, [
        el("p", { text: "Leads: everyone who gave a phone number in the selected dates, including people who did not finish the survey." }),
        el("p", { text: "Setter show: the setter call is a phone call. A completed call of " + Math.round(r.showMinCallSeconds / 60) + " minutes or more in GHL counts as showed, and so does a lead the team moved past the setter in the pipeline." }),
        el("p", { text: "Setter no-show: the booked time has passed, there was no conversation, and the setter either tried calling or marked the lead as a no-show." }),
        el("p", { text: "Setter DQ, To closer, Won and Cash come from the lead's stage and value in the GHL Sales Pipeline." }),
        el("p", { text: "Closer show: Google Meet or Fathom attendance when connected; until then the pipeline stage (Closer Followup / Won = showed, Closer Booked Noshow = no-show)." }),
        el("p", { text: syncLine(data) }),
      ]),
    ]));
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
      numberField("Minimum financing offered", "Disqualify anyone approved for less than this, or for nothing.", "minOfferAmount", "$"),
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
    var range = el("select", { "aria-label": "Date range" }, [
      el("option", { value: "month", text: "This month" }), el("option", { value: "last-month", text: "Last month" }),
      el("option", { value: "7", text: "Last 7 days" }), el("option", { value: "30", text: "Last 30 days" }),
      el("option", { value: "all", text: "All time" }), el("option", { value: "custom", text: "Custom dates" }),
    ]);
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
    root.appendChild(el("div", { class: "bar" }, [
      el("h1", { text: "Lead tracking" }), el("span", { class: "grow" }), range, custom,
      el("button", { type: "button", class: "btn", text: "Refresh", on: { click: load } }), sync,
      el("button", { type: "button", class: "btn", text: "Sign out", on: { click: function () { setToken(""); renderLogin(); } } }),
    ]));
    var tabs = [["overview", "Overview"], ["leads", "Leads"], ["rules", "Rules"]];
    root.appendChild(el("div", { class: "tabs", role: "tablist" }, tabs.map(function (t) {
      return el("button", { type: "button", class: "tab", role: "tab", "aria-selected": state.tab === t[0] ? "true" : "false", text: t[1], on: { click: function () {
        if (state.dirty && state.tab === "rules" && !window.confirm("You have unsaved rule changes. Leave without saving?")) return;
        state.tab = t[0]; render();
      } } });
    })));
    if (state.error) root.appendChild(el("div", { class: "notice bad", role: "alert", text: state.error }));
    var box = el("div", { role: "tabpanel" });
    root.appendChild(box);
    if (state.busy && !state.report) { box.appendChild(el("p", { class: "muted", text: "Loading…" })); return; }
    if (state.tab === "overview") renderOverview(box);
    else if (state.tab === "leads") renderLeads(box);
    else renderRules(box);
  }

  load();
})();
