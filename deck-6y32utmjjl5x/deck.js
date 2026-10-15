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
  var CLOSE_RATE = 0.5;
  var fmt = function (n) { return "$" + Math.round(n).toLocaleString("en-US"); };
  var fmt2 = function (n) { return "$" + n.toFixed(2); };

  /* One shared pricing state: the Startup calculator owns the sliders and toggle, the Reorder
     calculator reads the same values and re-renders whenever they change. */
  var pricing = { price: 1.5, roof: 2500, listeners: [] };
  function notifyPricing() { pricing.listeners.forEach(function (fn) { fn(); }); }

  function calculator(root, cfg) {
    var pkgs = Array.prototype.slice.call(root.querySelectorAll(".pkg"));
    var price = root.querySelector('[data-role="price"]');
    var roof = root.querySelector('[data-role="roof"]');
    var state = { pkg: cfg.defaultPkg };
    var q = function (sel) { return root.querySelector(sel); };

    pkgs.forEach(function (p, i) {
      p.addEventListener("click", function () { state.pkg = i; render(); });
    });
    if (price) price.addEventListener("input", function () { pricing.price = parseFloat(price.value); notifyPricing(); });
    if (roof) roof.addEventListener("input", function () { pricing.roof = parseInt(roof.value, 10); notifyPricing(); });
    pricing.listeners.push(render);

    function render() {
      var p = pkgs[state.pkg];
      pkgs.forEach(function (x, i) { x.classList.toggle("is-selected", i === state.pkg); x.setAttribute("aria-pressed", i === state.pkg ? "true" : "false"); });
      var cost = parseInt(p.getAttribute("data-price"), 10);
      var leads = parseInt(p.getAttribute("data-leads"), 10);
      var jobs = Math.round(leads * CLOSE_RATE);
      var perJob = pricing.price * pricing.roof;
      var netPerJob = perJob; // solo operator: no labor cost
      var revenue = perJob * jobs;
      var net = revenue - cost;
      var recoup = netPerJob > 0 ? Math.ceil(cost / netPerJob) : Infinity;
      var remaining = Math.max(0, jobs - recoup);
      var roi = cost > 0 ? (net / cost) * 100 : 0;

      if (price) { q('[data-out="price"]').textContent = fmt2(pricing.price); q('[data-out="roof"]').textContent = pricing.roof.toLocaleString("en-US") + " sq ft"; }
      q('[data-out="invest"]').textContent = fmt(cost);
      q('[data-out="invest2"]').textContent = fmt(cost);
      q('[data-out="recoup"]').textContent = isFinite(recoup) ? (Math.min(recoup, jobs) + (recoup > jobs ? "+" : "") + (Math.min(recoup, jobs) === 1 ? " job" : " jobs")) : "—";
      q('[data-out="remaining"]').innerHTML = recoup <= jobs
        ? "Remaining " + remaining + (remaining === 1 ? " job" : " jobs") + " = <b>" + fmt(remaining * netPerJob) + "</b> net profit ✅"
        : "This package needs " + recoup + " jobs to break even at this pricing — raise your price per sq ft or roof size.";
      q('[data-out="be-label"]').textContent = Math.min(recoup, jobs) + " of " + jobs + " jobs";
      q('[data-out="be-fill"]').style.width = Math.min(100, (Math.min(recoup, jobs) / jobs) * 100) + "%";
      q('[data-out="make"]').textContent = fmt(cfg.makeIsNet ? net : revenue);
      q('[data-out="make-sub"]').textContent = (cfg.makeIsNet ? "net profit from " : "from ") + jobs + " jobs";
      var summary = q('[data-out="summary"]');
      if (cfg.makeIsNet) {
        summary.innerHTML = "Total revenue: " + fmt(revenue) + " (" + jobs + " jobs × " + fmt(perJob) + ") – package " + fmt(cost) + " = <b>" + fmt(net) + "</b>";
      } else {
        summary.innerHTML = "Net profit: <b>" + fmt(net) + "</b> · <b>" + Math.round(roi) + "% ROI</b>";
      }
      var bd = q('[data-out="breakdown"]');
      if (bd) {
        bd.innerHTML =
          '<div class="bd-row"><span>Package Cost (spray + leads)</span><span class="neg">−' + fmt(cost) + '</span></div>' +
          '<div class="bd-row"><span>Revenue (' + jobs + ' jobs × ' + fmt(perJob) + ')</span><span class="pos">+' + fmt(revenue) + '</span></div>' +
          '<div class="bd-row total"><span>NET PROFIT FROM REORDER</span><span>' + fmt(net) + '</span></div>';
      }
    }
    render();
  }

  calculator(document.getElementById("calc-startup"), { defaultPkg: 1, makeIsNet: true });
  calculator(document.getElementById("calc-reorder"), { defaultPkg: 1, makeIsNet: false });
})();
