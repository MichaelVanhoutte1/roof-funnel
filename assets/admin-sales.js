/* Sales Leaderboard and Appointments tabs of the admin page. Same layout and vocabulary as CSP's
   /commission-tracker and /sales-appointments, read-only, fed by GET /admin/sales (see worker/src/sales.ts).
   Loaded before admin.js, which calls renderLeaderboard / renderAppointments with its helpers. */
(function () {
  "use strict";

  var ui = { rank: "cash", view: null, search: "", closer: "all", setter: "all", type: "all", status: "any", shown: 50, filtersOpen: false };

  function repName(email, names) {
    if (!email || email === "(unassigned)") return "Unassigned";
    var n = names && names[email] ? names[email] : email.split("@")[0];
    return n.replace(/(^|\s)\S/g, function (c) { return c.toUpperCase(); });
  }
  function per(n, d, h) { return d > 0 ? h.money(n / d) : "—"; }

  /* RatioBadge: one decimal, green ≥ good, amber ≥ watch, red below; "—" when nothing to divide by. */
  function ratioBadge(h, n, d, good, watch) {
    if (!(d > 0)) return h.el("span", { class: "pill outline", text: "—" });
    var pct = Math.round((n / d) * 1000) / 10;
    return h.pill(pct + "%", pct >= good ? "good" : pct >= watch ? "warn" : "bad");
  }
  function rankCell(h, i) {
    var icons = ["🏆", "🥈", "🥉"];
    return i < 3 ? h.el("span", { class: "rank-ic", title: "Rank " + (i + 1), text: icons[i] }) : h.el("span", { class: "muted rank-n", text: String(i + 1) });
  }
  function strip(h, cells) {
    return h.el("div", { class: "strip" }, cells.map(function (c) {
      return h.el("div", { class: "strip-cell" }, [h.el("div", { class: "strip-v" + (c[2] ? " " + c[2] : ""), text: c[1] }), h.el("div", { class: "strip-l", text: c[0] })]);
    }));
  }

  /* ---------------- leaderboard ---------------- */
  var RANKS = [["cash", "Cash collected"], ["close_rate", "Close rate"], ["aov", "AOV"], ["cash_per_taken", "$ / appointment taken"]];
  function score(r) {
    if (ui.rank === "cash") return r.cash;
    if (ui.rank === "close_rate") return r.showed > 0 ? r.closed / r.showed : -Infinity;
    if (ui.rank === "aov") return r.closed > 0 ? r.cash / r.closed : -Infinity;
    return r.showed > 0 ? r.cash / r.showed : -Infinity;
  }

  function closersTable(h, rows, names) {
    var ranked = rows.slice().sort(function (a, b) { return score(b) - score(a) || repName(a.rep, names).localeCompare(repName(b.rep, names)); });
    var cols = ["#", "Closer", "Total appts", "Taken", "Show rate", "Closed", "Close rate", "Cash", "AOV", "$ / taken", "$ / booked"];
    var head = h.el("tr", null, cols.map(function (c, i) { return h.el("th", { class: i < 2 ? "left" : null, text: c }); }));
    var body = ranked.map(function (r, i) {
      return h.el("tr", { class: i < 3 ? "top" : null }, [
        h.el("td", { class: "left" }, [rankCell(h, i)]),
        h.el("td", { class: "left name" + (i === 0 && score(r) > 0 ? " first" : ""), text: repName(r.rep, names) }),
        h.el("td", { text: h.num(r.booked) }), h.el("td", { text: h.num(r.showed) }),
        h.el("td", null, [ratioBadge(h, r.showed, r.booked, 50, 40)]),
        h.el("td", { text: h.num(r.closed) }),
        h.el("td", null, [ratioBadge(h, r.closed, r.showed, 50, 40)]),
        h.el("td", { text: h.money(r.cash) }),
        h.el("td", { text: per(r.cash, r.closed, h) }),
        h.el("td", { class: "muted", text: per(r.cash, r.showed, h) }),
        h.el("td", { class: "muted", text: per(r.cash, r.booked, h) }),
      ]);
    });
    var t = sum(rows);
    var foot = h.el("tr", { class: "total" }, [
      h.el("td", { class: "left" }), h.el("td", { class: "left total-l", text: "Total" }),
      h.el("td", { text: h.num(t.booked) }), h.el("td", { text: h.num(t.showed) }),
      h.el("td", null, [ratioBadge(h, t.showed, t.booked, 50, 40)]),
      h.el("td", { text: h.num(t.closed) }),
      h.el("td", null, [ratioBadge(h, t.closed, t.showed, 50, 40)]),
      h.el("td", { text: h.money(t.cash) }),
      h.el("td", { class: "strong", text: per(t.cash, t.closed, h) }),
      h.el("td", { text: per(t.cash, t.showed, h) }),
      h.el("td", { text: per(t.cash, t.booked, h) }),
    ]);
    if (!rows.length) return h.el("p", { class: "muted empty", text: "No closer calls in this period." });
    return h.el("div", { class: "scroll" }, [h.el("table", { class: "lb" }, [h.el("thead", null, [head]), h.el("tbody", null, body), h.el("tfoot", null, [foot])])]);
  }

  function settersTable(h, rows, names) {
    var cols = ["#", "Setter", "Appts booked", "Appts showed", "Show rate", "Appts closed", "Close rate", "Cash basis (in range)", "AOV"];
    var head = h.el("tr", null, cols.map(function (c, i) { return h.el("th", { class: i < 2 ? "left" : null, text: c }); }));
    var body = rows.map(function (r, i) {
      return h.el("tr", { class: i < 3 ? "top" : null }, [
        h.el("td", { class: "left" }, [rankCell(h, i)]),
        h.el("td", { class: "left name", text: repName(r.rep, names) }),
        h.el("td", { text: h.num(r.booked) }), h.el("td", { text: h.num(r.showed) }),
        h.el("td", null, [ratioBadge(h, r.showed, r.booked, 50, 40)]),
        h.el("td", { text: h.num(r.closed) }),
        h.el("td", null, [ratioBadge(h, r.closed, r.showed, 50, 40)]),
        h.el("td", { text: h.money(r.cash) }),
        h.el("td", { text: per(r.cash, r.closed, h) }),
      ]);
    });
    var t = sum(rows);
    var foot = h.el("tr", { class: "total" }, [
      h.el("td", { class: "left" }), h.el("td", { class: "left total-l", text: "Total" }),
      h.el("td", { text: h.num(t.booked) }), h.el("td", { text: h.num(t.showed) }),
      h.el("td", null, [ratioBadge(h, t.showed, t.booked, 50, 40)]),
      h.el("td", { text: h.num(t.closed) }),
      h.el("td", null, [ratioBadge(h, t.closed, t.showed, 50, 40)]),
      h.el("td", { text: h.money(t.cash) }),
      h.el("td", { class: "strong", text: per(t.cash, t.closed, h) }),
    ]);
    if (!rows.length) return h.el("p", { class: "muted empty", text: "No setter calls in this period." });
    return h.el("div", { class: "scroll" }, [h.el("table", { class: "lb" }, [h.el("thead", null, [head]), h.el("tbody", null, body), h.el("tfoot", null, [foot])])]);
  }

  function sum(rows) {
    return rows.reduce(function (t, r) { t.booked += r.booked; t.showed += r.showed; t.closed += r.closed; t.cash += r.cash; return t; }, { booked: 0, showed: 0, closed: 0, cash: 0 });
  }

  function unavailable(box, data, h) {
    if (!data) { box.appendChild(h.el("p", { class: "muted", text: "Loading…" })); return true; }
    if (data.error) { box.appendChild(h.el("div", { class: "notice bad", role: "alert", text: "The sales data could not be loaded: " + data.error })); return true; }
    return false;
  }

  function renderLeaderboard(box, data, h) {
    if (unavailable(box, data, h)) return;
    var lb = data.leaderboard, t = lb.totals, names = data.names || {};
    var view = ui.view || "closers";
    box.appendChild(strip(h, [
      ["Cash collected", h.money(t.cash), "good"],
      ["Deals", h.num(t.deals), "primary"],
      ["Close rate", t.closerShowed > 0 ? Math.round((t.deals / t.closerShowed) * 100) + "%" : "—"],
      ["AOV", per(t.cash, t.deals, h)],
    ]));
    var toggle = h.el("div", { class: "toggle", role: "tablist" }, [["closers", "Closers"], ["setters", "Setters"]].map(function (o) {
      return h.el("button", { type: "button", class: "toggle-b", "aria-selected": view === o[0] ? "true" : "false", text: o[1], on: { click: function () { ui.view = o[0]; h.rerender(); } } });
    }));
    var right = [toggle];
    if (view === "closers") {
      var sel = h.el("select", { "aria-label": "Ranked by" }, RANKS.map(function (r) { return h.el("option", { value: r[0], text: r[1] }); }));
      sel.value = ui.rank;
      sel.addEventListener("change", function () { ui.rank = sel.value; h.rerender(); });
      right.unshift(h.el("div", { class: "ranked-by" }, [h.el("span", { class: "ranked-l", text: "Ranked by" }), sel]));
    }
    box.appendChild(h.el("div", { class: "card sales-card" }, [
      h.el("div", { class: "card-head" }, [h.el("h2", { text: view === "closers" ? "Closer Rankings" : "Setter Rankings" }), h.el("div", { class: "card-right" }, right)]),
      view === "closers" ? closersTable(h, lb.closers, names) : settersTable(h, lb.setters, names),
    ]));
  }

  /* ---------------- appointments ---------------- */
  var STATUS_OPTIONS = [["any", "Any status"], ["showed", "Showed"], ["closed", "Closed"], ["no_show", "No show"], ["cancelled", "Cancelled"], ["confirmed", "Confirmed"]];
  var TYPE_OPTIONS = [["all", "All types"], ["setter", "Setter calls"], ["closer", "Closer calls"]];

  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) + " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  function day(iso) { if (!iso) return "—"; var d = new Date(iso); return isNaN(d) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }

  function statusPills(h, r) {
    var out = [];
    if (r.status === "showed") out.push(h.pill("Show", "good"));
    else if (r.status === "no_show") out.push(h.pill("No show", "bad"));
    else if (r.status === "cancelled") out.push(h.pill("Cancelled", "warn"));
    else if (r.status === "confirmed") out.push(h.pill("Confirmed"));
    else out.push(h.pill(r.ghl_status ? r.ghl_status.replace(/_/g, " ").replace(/^\w/, function (c) { return c.toUpperCase(); }) : "—"));
    if (r.closed) out.push(h.pill("Closed", "blue"));
    return h.el("div", { class: "pills" }, out);
  }

  /* "Recording / note": how the show was established; CSP's evidence tiers mapped onto what the roof data has. */
  function evidenceCell(h, r) {
    if (r.status !== "showed") return h.el("span", { class: "muted", text: "—" });
    var e = r.evidence;
    if (e.kind === "meet") return h.el("span", { class: "ev good", text: "Meet · " + (e.minutes != null ? e.minutes + " min" : "attended") });
    if (e.kind === "fathom") return h.el("span", { class: "ev good", text: "Fathom · " + (e.minutes != null ? e.minutes + " min" : "recording") });
    if (e.kind === "call") return h.el("span", { class: "ev good", text: "Call · " + e.minutes + " min" });
    if (r.closed) return h.el("span", { class: "ev good", text: "Closed · verified show" });
    if (e.kind === "ghl") return h.el("span", { class: "ev warn", text: "GHL status · unverified" });
    return h.el("span", { class: "ev warn", text: "GHL stage · unverified" });
  }

  function filtered(rows) {
    var q = ui.search.trim().toLowerCase();
    return rows.filter(function (r) {
      if (ui.closer !== "all" && (r.closer || "") !== ui.closer) return false;
      if (ui.setter !== "all" && (r.setter || "") !== ui.setter) return false;
      if (ui.type !== "all" && r.kind !== ui.type) return false;
      if (ui.status === "closed" ? !r.closed : ui.status !== "any" && r.status !== ui.status) return false;
      if (q && ((r.name || "") + " " + (r.city || "") + " " + (r.kind === "setter" ? "setter call" : "closer call")).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }
  function activeFilters() { return (ui.closer !== "all") + (ui.setter !== "all") + (ui.type !== "all") + (ui.status !== "any"); }

  function select(h, label, value, options, onChange) {
    var s = h.el("select", { "aria-label": label }, options.map(function (o) { return h.el("option", { value: o[0], text: o[1] }); }));
    s.value = value;
    s.addEventListener("change", function () { onChange(s.value); ui.shown = 50; h.rerender(); });
    return h.el("label", { class: "f-row" }, [h.el("span", { class: "f-l", text: label }), s]);
  }

  function renderAppointments(box, data, h) {
    if (unavailable(box, data, h)) return;
    var all = data.appointments, names = data.names || {};
    // A rep picked under another date range may not exist in this one: fall back to "all" instead of filtering everything out.
    ["closer", "setter"].forEach(function (k) { if (ui[k] !== "all" && !all.some(function (r) { return r[k] === ui[k]; })) ui[k] = "all"; });
    var rows = filtered(all);
    var cancelled = rows.filter(function (r) { return r.status === "cancelled"; }).length;
    box.appendChild(strip(h, [["Appointments", h.num(rows.length)], ["Cancelled", h.num(cancelled), cancelled ? "bad" : ""]]));

    var search = h.el("input", { type: "search", class: "search", placeholder: "Search customer or appointment…", value: ui.search, "aria-label": "Search" });
    search.addEventListener("input", function () { ui.search = search.value; ui.shown = 50; h.rerender(); var s = document.querySelector("input.search"); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } });
    var n = activeFilters();
    var fbtn = h.el("button", { type: "button", class: "btn", "aria-expanded": ui.filtersOpen ? "true" : "false", on: { click: function () { ui.filtersOpen = !ui.filtersOpen; h.rerender(); } } }, ["Filters", n ? h.el("span", { class: "count", text: String(n) }) : null]);
    var reps = function (key) {
      var seen = {};
      all.forEach(function (r) { if (r[key]) seen[r[key]] = true; });
      return Object.keys(seen).sort(function (a, b) { return repName(a, names).localeCompare(repName(b, names)); }).map(function (e) { return [e, repName(e, names)]; });
    };
    var pop = ui.filtersOpen ? h.el("div", { class: "filters" }, [
      n ? h.el("button", { type: "button", class: "link", text: "Reset filters", on: { click: function () { ui.closer = "all"; ui.setter = "all"; ui.type = "all"; ui.status = "any"; ui.shown = 50; h.rerender(); } } }) : null,
      select(h, "Closer", ui.closer, [["all", "All Closers"]].concat(reps("closer")), function (v) { ui.closer = v; }),
      select(h, "Setter", ui.setter, [["all", "All Setters"]].concat(reps("setter")), function (v) { ui.setter = v; }),
      select(h, "Type", ui.type, TYPE_OPTIONS, function (v) { ui.type = v; }),
      select(h, "Status", ui.status, STATUS_OPTIONS, function (v) { ui.status = v; }),
    ]) : null;

    var cols = ["Closer", "Setter", "Appointment", "Customer", "Score", "Scheduled for", "Status", "Closed", "Close date", "Recording / note"];
    var head = h.el("tr", null, cols.map(function (c) { return h.el("th", { class: "left", text: c }); }));
    var shown = rows.slice(0, ui.shown);
    var body = shown.map(function (r) {
      return h.el("tr", null, [
        h.el("td", { class: "left muted", text: r.closer ? repName(r.closer, names) : "—" }),
        h.el("td", { class: "left" + (r.setter ? "" : " muted"), text: r.setter ? repName(r.setter, names) : "Unassigned" }),
        h.el("td", { class: "left medium", text: r.kind === "setter" ? "Setter call" : "Closer call" }),
        h.el("td", { class: "left" }, [h.el("div", { class: "cust", text: r.name || "—" }), r.city ? h.el("div", { class: "muted small", text: r.city }) : null]),
        h.el("td", { class: "left" + (r.credit_score == null ? " muted" : ""), text: r.credit_score == null ? "—" : String(r.credit_score) }),
        h.el("td", { class: "left muted", text: when(r.start) }),
        h.el("td", { class: "left" }, [statusPills(h, r)]),
        h.el("td", { class: "left", text: r.closed ? h.money(r.cash) : "—" }),
        h.el("td", { class: "left", text: r.closed ? day(r.close_date) : "—" }),
        h.el("td", { class: "left" }, [evidenceCell(h, r)]),
      ]);
    });
    var empty = null;
    if (!all.length) empty = "No appointments found for this period.";
    else if (!rows.length) empty = (n || ui.search) ? "No appointments match these filters." : "No appointments in this period.";
    var more = rows.length > shown.length ? h.el("button", { type: "button", class: "btn", text: "Show more", on: { click: function () { ui.shown += 25; h.rerender(); } } }) : null;

    box.appendChild(h.el("div", { class: "card sales-card" }, [
      h.el("div", { class: "toolbar" }, [search, h.el("div", { class: "toolbar-r" }, [fbtn])]),
      pop,
      empty ? h.el("p", { class: "muted empty", text: empty }) : h.el("div", { class: "scroll" }, [h.el("table", { class: "appts" }, [h.el("thead", null, [head]), h.el("tbody", null, body)])]),
      h.el("div", { class: "foot" }, [h.el("span", { class: "muted small", text: "Showing " + h.num(shown.length) + " of " + h.num(rows.length) + " appointments" }), more]),
    ]));
  }

  window.RFAdminSales = { renderLeaderboard: renderLeaderboard, renderAppointments: renderAppointments };
})();
