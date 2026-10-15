(function () {
  "use strict";
  /* ---------- lightbox ---------- */
  var lightbox = document.getElementById("lightbox");
  var lbBody = document.getElementById("lb-body");
  function openLightbox(tile) {
    lbBody.innerHTML = "";
    var img = tile.tagName === "IMG" ? tile : tile.querySelector("img");
    if (img) {
      var big = document.createElement("img");
      big.src = img.currentSrc || img.src; big.alt = img.alt || "";
      lbBody.appendChild(big);
    } else {
      var ph = document.createElement("div");
      ph.className = "lb-ph";
      ph.textContent = tile.getAttribute("data-label") || "";
      lbBody.appendChild(ph);
    }
    lightbox.classList.add("is-open");
  }
  function closeLightbox() { lightbox.classList.remove("is-open"); lbBody.innerHTML = ""; }
  document.addEventListener("click", function (e) {
    var tile = e.target.closest(".media, .proof img");
    if (tile && !tile.querySelector("iframe, video")) { e.preventDefault(); openLightbox(tile); return; }
    if (e.target.closest("#lb-close") || (e.target === lightbox) || e.target.closest("#lb-body")) closeLightbox();
  });
  document.getElementById("lb-close").addEventListener("click", closeLightbox);

  /* ---------- slide navigation ---------- */
  var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
  var titles = slides.map(function (s) { return s.getAttribute("data-title") || ""; });
  var counter = document.getElementById("counter");
  var prev = document.getElementById("prev");
  var next = document.getElementById("next");
  var current = 0;

  function go(i, fromHash) {
    i = Math.max(0, Math.min(slides.length - 1, i));
    current = i;
    slides.forEach(function (s, k) { s.classList.toggle("is-active", k === i); if (k === i) s.scrollTop = 0; });
    counter.textContent = (i + 1) + " / " + slides.length;
    document.title = "OnyaRoof Dealer Program · " + titles[i].replace(/&amp;/g, "&");
    prev.disabled = i === 0; next.disabled = i === slides.length - 1;
    if (!fromHash) history.replaceState(null, "", "#" + (i + 1));
  }
  prev.addEventListener("click", function () { go(current - 1); });
  next.addEventListener("click", function () { go(current + 1); });
  document.addEventListener("keydown", function (e) {
    if (lightbox.classList.contains("is-open")) { if (e.key === "Escape") closeLightbox(); return; }
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); go(current + 1); }
    if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(current - 1); }
    if (e.key === "Home") go(0);
    if (e.key === "End") go(slides.length - 1);
  });
  window.addEventListener("hashchange", function () { var n = parseInt(location.hash.slice(1), 10); if (n) go(n - 1, true); });
  var start = parseInt(location.hash.slice(1), 10);
  go(start ? start - 1 : 0, true);

  /* ---------- calculators ---------- */
  var LABOR_PER_JOB = 150;
  var CLOSE_RATE = 0.5;
  var MATERIAL_COST_SQFT = 0.28;
  var fmt = function (n) { return "$" + Math.round(n).toLocaleString("en-US"); };
  var fmt2 = function (n) { return "$" + n.toFixed(2); };

  function calculator(root, cfg) {
    var pkgs = Array.prototype.slice.call(root.querySelectorAll(".pkg"));
    var price = root.querySelector('[data-role="price"]');
    var roof = root.querySelector('[data-role="roof"]');
    var solo = root.querySelector('[data-role="solo"]');
    var state = { pkg: cfg.defaultPkg, price: parseFloat(price.value), roof: parseInt(roof.value, 10), solo: false };
    var q = function (sel) { return root.querySelector(sel); };

    pkgs.forEach(function (p, i) {
      var leads = parseInt(p.getAttribute("data-leads"), 10);
      var dotsEl = p.querySelector(".pkg-leads");
      if (dotsEl) { for (var k = 0; k < leads; k++) dotsEl.appendChild(document.createElement("i")); }
      p.addEventListener("click", function () { state.pkg = i; render(); });
    });
    price.addEventListener("input", function () { state.price = parseFloat(price.value); render(); });
    roof.addEventListener("input", function () { state.roof = parseInt(roof.value, 10); render(); });
    solo.addEventListener("click", function () { state.solo = !state.solo; render(); });

    function render() {
      var p = pkgs[state.pkg];
      pkgs.forEach(function (x, i) { x.classList.toggle("is-selected", i === state.pkg); x.setAttribute("aria-pressed", i === state.pkg ? "true" : "false"); });
      var cost = parseInt(p.getAttribute("data-price"), 10);
      var leads = parseInt(p.getAttribute("data-leads"), 10);
      var gallons = parseInt(p.getAttribute("data-gal"), 10);
      var sqft = parseInt(p.getAttribute("data-sqft"), 10);
      var jobs = Math.round(leads * CLOSE_RATE);
      var perJob = state.price * state.roof;
      var labor = state.solo ? 0 : LABOR_PER_JOB;
      var netPerJob = perJob - labor;
      var revenue = perJob * jobs;
      var laborTotal = labor * jobs;
      var net = revenue - laborTotal - cost;
      var recoup = netPerJob > 0 ? Math.ceil(cost / netPerJob) : Infinity;
      var remaining = Math.max(0, jobs - recoup);
      var roi = cost > 0 ? (net / cost) * 100 : 0;

      q('[data-out="price"]').textContent = fmt2(state.price);
      q('[data-out="roof"]').textContent = state.roof.toLocaleString("en-US") + " sq ft";
      solo.classList.toggle("on", state.solo); solo.setAttribute("aria-checked", state.solo ? "true" : "false");
      var markup = q('[data-out="markup"]');
      if (markup) markup.innerHTML = "You pay <b>" + fmt2(MATERIAL_COST_SQFT) + "/sq ft</b> for product · you charge <b>" + fmt2(state.price) + "/sq ft</b> · <span class=\"g\">" + (state.price / MATERIAL_COST_SQFT).toFixed(1) + "x</span> your material cost · " + gallons + " gal covers <b>" + sqft.toLocaleString("en-US") + " sq ft</b>";
      q('[data-out="invest"]').textContent = fmt(cost);
      q('[data-out="invest2"]').textContent = fmt(cost);
      q('[data-out="recoup"]').textContent = isFinite(recoup) ? (Math.min(recoup, jobs) + (recoup > jobs ? "+" : "") + (Math.min(recoup, jobs) === 1 ? " job" : " jobs")) : "—";
      q('[data-out="remaining"]').innerHTML = recoup <= jobs
        ? "Remaining " + remaining + (remaining === 1 ? " job" : " jobs") + " = <b>" + fmt(remaining * netPerJob) + "</b> net profit after labor ✅"
        : "This package needs " + recoup + " jobs to break even at this pricing — raise your price per sq ft or roof size.";
      q('[data-out="be-label"]').textContent = Math.min(recoup, jobs) + " of " + jobs + " jobs";
      q('[data-out="be-fill"]').style.width = Math.min(100, (Math.min(recoup, jobs) / jobs) * 100) + "%";
      q('[data-out="make"]').textContent = fmt(cfg.makeIsNet ? net : revenue);
      q('[data-out="make-sub"]').textContent = (cfg.makeIsNet ? "net profit from " : "from ") + jobs + " jobs";
      var summary = q('[data-out="summary"]');
      if (cfg.makeIsNet) {
        summary.innerHTML = "Total revenue: " + fmt(revenue) + " – labor " + fmt(laborTotal) + " (" + jobs + " × " + fmt(labor) + ") – package " + fmt(cost) + " = <b>" + fmt(net) + "</b>";
      } else {
        summary.innerHTML = "Net profit: <b>" + fmt(net) + "</b> · <b>" + Math.round(roi) + "% ROI</b>";
      }
      var bd = q('[data-out="breakdown"]');
      if (bd) {
        bd.innerHTML =
          '<div class="bd-row"><span>Package Cost (spray + leads)</span><span class="neg">−' + fmt(cost) + '</span></div>' +
          '<div class="bd-row"><span>Labor (' + jobs + ' jobs × ' + fmt(labor) + ')</span><span class="neg">−' + fmt(laborTotal) + '</span></div>' +
          '<div class="bd-row"><span>Revenue (' + jobs + ' jobs × ' + fmt(perJob) + ')</span><span class="pos">+' + fmt(revenue) + '</span></div>' +
          '<div class="bd-row total"><span>NET PROFIT FROM REORDER</span><span>' + fmt(net) + '</span></div>';
      }
    }
    render();
  }

  calculator(document.getElementById("calc-startup"), { defaultPkg: 1, makeIsNet: true });
  calculator(document.getElementById("calc-reorder"), { defaultPkg: 1, makeIsNet: false });
})();
