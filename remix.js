/* =========================================================================
 * PT Gold — Thread Stats (content script, thread pages)
 *
 * Replaces the old "Top Exchanges" remix with an at-a-glance stats panel:
 *   • posts / unique posters / time active (first → last post)
 *   • top posters by post count
 *   • most-quoted posts (built from a who-quotes-whom graph)
 * Plus a per-post collapse control. Defaults to the loaded page; "Scan all
 * pages" walks the thread's pagination to compute whole-thread stats.
 * Styled to match the rest of the extension (see remix.css).
 * ========================================================================= */
(() => {
  "use strict";

  const STORE_KEY = "ptgold_settings";
  const DEFAULTS = { enabled: true, badges: true, panel: true, topN: 5 };

  let cfg = { ...DEFAULTS };
  let scanning = false;
  let wholeThread = false;

  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const onThreadPage = () => /\/threads\/\d+/.test(location.pathname) && !!document.querySelector(".post-listing");

  function fmtDur(ms) {
    if (!ms || ms < 0) return "—";
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m";
    return s + "s";
  }

  /* ---------- extraction ---------- */
  function postIdOf(el, fallback) {
    const a = el.querySelector('.post_tools a[href*="/posts/"], a[href*="%2Fposts%2F"]');
    if (a) {
      const href = decodeURIComponent(a.getAttribute("href") || "");
      const m = href.match(/\/posts\/(\d+)/);
      if (m) return m[1];
    }
    return "idx-" + fallback;
  }
  function topLevelQuoteHandles(bodyEl) {
    const out = [];
    bodyEl.querySelectorAll("blockquote").forEach((bq) => {
      if (bq.parentElement && bq.parentElement.closest("blockquote")) return;
      const cite = bq.querySelector(":scope > header cite, :scope > cite, cite");
      const clone = bq.cloneNode(true);
      clone.querySelectorAll("blockquote, header").forEach((n) => n.remove());
      out.push({ handle: cite ? norm(cite.getAttribute("title") || cite.textContent) : "", text: norm(clone.textContent) });
    });
    return out;
  }
  const ownText = (bodyEl) => { const c = bodyEl.cloneNode(true); c.querySelectorAll("blockquote").forEach((n) => n.remove()); return norm(c.textContent); };
  function postTime(el) {
    const t = el.querySelector(".posted_at[datetime]");
    if (!t) return null;
    const d = Date.parse(t.getAttribute("datetime"));
    return isNaN(d) ? null : d;
  }

  const posts = new Map();
  function extractLoaded(page) {
    const recs = [];
    document.querySelectorAll(".post-listing .post").forEach((el, i) => {
      if (el.classList.contains("ptgold-hidden")) return;
      const authorEl = el.querySelector(".poster_name a[href^='/users/']") || el.querySelector(".poster_name a");
      const bodyEl = el.querySelector(".post_body_container");
      if (!authorEl || !bodyEl) return;
      recs.push({
        id: postIdOf(el, page * 1000 + i),
        page,
        author: (authorEl.textContent || "").trim(),
        authorKey: norm(authorEl.textContent),
        ownTextNorm: ownText(bodyEl),
        quotes: topLevelQuoteHandles(bodyEl),
        ts: postTime(el),
        liveEl: el,
      });
    });
    return recs;
  }
  function ingest(recs) {
    recs.forEach((r) => {
      if (!posts.has(r.id)) posts.set(r.id, { ...r, order: posts.size, quotedByIds: new Set() });
      else posts.get(r.id).liveEl = r.liveEl;
    });
  }
  function buildGraph() {
    const all = [...posts.values()];
    const byAuthor = new Map();
    all.forEach((p) => { if (!byAuthor.has(p.authorKey)) byAuthor.set(p.authorKey, []); byAuthor.get(p.authorKey).push(p); });
    all.forEach((p) => p.quotedByIds.clear());
    all.forEach((p) => {
      p.quotes.forEach((q) => {
        if (!q.handle) return;
        const cands = byAuthor.get(q.handle);
        if (!cands) return;
        const needle = q.text.slice(0, 120);
        let best = null;
        if (needle.length >= 8) for (const c of cands) { if (c.id === p.id || c.order >= p.order) continue; if (c.ownTextNorm.indexOf(needle) !== -1 && (!best || c.order > best.order)) best = c; }
        if (!best) for (const c of cands) { if (c.id === p.id || c.order >= p.order) continue; if (!best || c.order > best.order) best = c; }
        if (best) best.quotedByIds.add(p.id);
      });
    });
  }

  /* ---------- stats ---------- */
  function computeStats() {
    const all = [...posts.values()];
    const byAuthor = {};
    let minTs = Infinity, maxTs = -Infinity, totalQuotes = 0;
    all.forEach((p) => {
      byAuthor[p.author] = (byAuthor[p.author] || 0) + 1;
      if (p.ts != null) { minTs = Math.min(minTs, p.ts); maxTs = Math.max(maxTs, p.ts); }
      totalQuotes += p.quotes.filter((q) => q.handle).length;
    });
    const topPosters = Object.entries(byAuthor).sort((a, b) => b[1] - a[1]).slice(0, cfg.topN);
    const mostQuoted = all.filter((p) => p.quotedByIds.size > 0).sort((a, b) => b.quotedByIds.size - a.quotedByIds.size).slice(0, cfg.topN);
    return {
      posts: all.length,
      posters: Object.keys(byAuthor).length,
      active: maxTs > minTs ? maxTs - minTs : 0,
      totalQuotes,
      maxPosterCount: topPosters.length ? topPosters[0][1] : 1,
      topPosters,
      mostQuoted,
    };
  }

  /* ---------- per-post collapse + quote chip ---------- */
  function clearNativeDecor() {
    document.querySelectorAll(".ptg-caret, .ptg-qchip").forEach((n) => n.remove());
    document.querySelectorAll(".ptg-collapsed-body").forEach((n) => n.classList.remove("ptg-collapsed-body"));
  }
  function decorateNative() {
    posts.forEach((p) => {
      const el = p.liveEl;
      if (!el || !el.isConnected) return;
      const header = el.querySelector(".post_header");
      const body = el.querySelector(".post_body");
      if (header && body && !header.querySelector(".ptg-caret")) {
        const caret = document.createElement("button");
        caret.className = "ptg-caret";
        caret.textContent = "▾";
        caret.title = "Collapse / expand this post";
        caret.addEventListener("click", (e) => { e.preventDefault(); const hid = body.classList.toggle("ptg-collapsed-body"); caret.textContent = hid ? "▸" : "▾"; });
        header.insertBefore(caret, header.firstChild);
      }
      if (cfg.badges && p.quotedByIds.size > 0 && header) {
        const name = header.querySelector(".poster_name");
        if (name && !name.parentElement.querySelector(".ptg-qchip")) {
          const chip = document.createElement("span");
          chip.className = "ptg-qchip";
          chip.textContent = "↩ " + p.quotedByIds.size;
          chip.title = "Quoted " + p.quotedByIds.size + "× " + (wholeThread ? "(whole thread)" : "(this page)");
          name.insertAdjacentElement("afterend", chip);
        }
      }
    });
  }

  /* ---------- panel ---------- */
  function ensurePanel() {
    let panel = document.getElementById("ptg-stats");
    if (panel) return panel;
    const anchor = document.querySelector(".post-listing");
    if (!anchor || !anchor.parentElement) return null;
    panel = document.createElement("div");
    panel.id = "ptg-stats";
    panel.className = "ptg-root";
    anchor.parentElement.insertBefore(panel, anchor);
    return panel;
  }
  function metric(label, value) {
    return `<div class="ptg-metric"><div class="ptg-metric-v">${value}</div><div class="ptg-metric-l">${label}</div></div>`;
  }
  function renderPanel() {
    if (!cfg.panel) { const ex = document.getElementById("ptg-stats"); if (ex) ex.remove(); return; }
    const panel = ensurePanel();
    if (!panel) return;
    const s = computeStats();
    panel.textContent = "";

    const head = document.createElement("div");
    head.className = "ptg-head";
    head.innerHTML = `<span class="ptg-title">SNAPSHOT</span><span class="ptg-scope">${wholeThread ? "whole thread" : "this page"}</span>`;
    const scan = document.createElement("button");
    scan.className = "ptg-btn";
    scan.textContent = scanning ? "Scanning…" : wholeThread ? "Re-scan" : "Scan all pages";
    scan.disabled = scanning;
    scan.addEventListener("click", scanWholeThread);
    head.appendChild(scan);
    panel.appendChild(head);

    const metrics = document.createElement("div");
    metrics.className = "ptg-metrics";
    metrics.innerHTML = metric("posts", s.posts) + metric("posters", s.posters) + metric("active", fmtDur(s.active)) + metric("quotes", s.totalQuotes);
    panel.appendChild(metrics);

    const cols = document.createElement("div");
    cols.className = "ptg-cols";

    // top posters
    const c1 = document.createElement("div"); c1.className = "ptg-col";
    c1.innerHTML = `<div class="ptg-col-h">Top posters</div>`;
    s.topPosters.forEach(([author, count]) => {
      const row = document.createElement("div"); row.className = "ptg-bar-row";
      const pct = Math.round((count / s.maxPosterCount) * 100);
      row.innerHTML = `<span class="ptg-bar-name">${escapeHtml(author)}</span><span class="ptg-bar-wrap"><span class="ptg-bar" style="width:${pct}%"></span></span><span class="ptg-bar-n">${count}</span>`;
      c1.appendChild(row);
    });
    if (!s.topPosters.length) c1.innerHTML += `<div class="ptg-empty">—</div>`;
    cols.appendChild(c1);

    // most quoted
    const c2 = document.createElement("div"); c2.className = "ptg-col";
    c2.innerHTML = `<div class="ptg-col-h">Most quoted</div>`;
    s.mostQuoted.forEach((p) => {
      const row = document.createElement("div"); row.className = "ptg-q-row";
      row.innerHTML = `<span class="ptg-q-name">${escapeHtml(p.author)}</span><span class="ptg-q-n">↩ ${p.quotedByIds.size}</span>`;
      row.title = "Scroll to this post";
      row.addEventListener("click", () => { if (p.liveEl && p.liveEl.isConnected) { p.liveEl.scrollIntoView({ behavior: "smooth", block: "center" }); p.liveEl.classList.add("ptg-flash"); setTimeout(() => p.liveEl.classList.remove("ptg-flash"), 1500); } });
      c2.appendChild(row);
    });
    if (!s.mostQuoted.length) c2.innerHTML += `<div class="ptg-empty">no quoted posts yet</div>`;
    cols.appendChild(c2);

    panel.appendChild(cols);
  }
  function escapeHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  /* ---------- whole-thread scan ---------- */
  function pageLinks() { const map = new Map(); document.querySelectorAll('a[href*="/page/"]').forEach((a) => { const m = (a.getAttribute("href") || "").match(/\/page\/(\d+)/); if (m) map.set(parseInt(m[1], 10), a); }); return map; }
  const currentPage = () => { const m = (location.hash || "").match(/\/page\/(\d+)/); return m ? parseInt(m[1], 10) : 1; };
  const firstPostId = () => { const el = document.querySelector(".post-listing .post"); return el ? postIdOf(el, -1) : null; };
  async function gotoPage(n) {
    const before = firstPostId(); const links = pageLinks(); const a = links.get(n);
    if (a) a.click(); else location.hash = "#/page/" + n;
    for (let i = 0; i < 60; i++) { await sleep(100); const now = firstPostId(); if (now && now !== before) { await sleep(250); return true; } }
    await sleep(300); return false;
  }
  async function scanWholeThread() {
    if (scanning) return;
    scanning = true; renderPanel();
    const start = currentPage(); const links = pageLinks(); const max = links.size ? Math.max(...links.keys()) : 1;
    try {
      for (let n = 1; n <= max; n++) {
        if (n !== currentPage()) { const ok = await gotoPage(n); if (!ok) continue; }
        ingest(extractLoaded(n)); buildGraph();
        const sub = document.querySelector("#ptg-stats .ptg-scope"); if (sub) sub.textContent = "scanning " + n + "/" + max + "…";
      }
      wholeThread = true;
    } finally {
      scanning = false;
      if (currentPage() !== start) await gotoPage(start);
      refresh();
    }
  }

  /* ---------- orchestration ---------- */
  function refresh() {
    if (!cfg.enabled || !onThreadPage()) { clearNativeDecor(); const ex = document.getElementById("ptg-stats"); if (ex) ex.remove(); return; }
    if (!scanning) { if (!wholeThread) posts.clear(); ingest(extractLoaded(currentPage())); buildGraph(); }
    clearNativeDecor(); decorateNative(); renderPanel();
  }
  let pending = null;
  function schedule() { if (scanning) return; if (pending) clearTimeout(pending); pending = setTimeout(() => { pending = null; refresh(); }, 200); }
  function isOurs(n) { if (n.nodeType !== 1) return true; const c = n.className && n.className.toString ? n.className.toString() : ""; return c.indexOf("ptg") !== -1 || n.id === "ptg-stats"; }
  function startObserver() {
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.target && m.target.nodeType === 1 && m.target.closest && m.target.closest("#ptg-stats")) continue;
        if ([...m.addedNodes].some((n) => !isOurs(n)) || [...m.removedNodes].some((n) => !isOurs(n))) { schedule(); return; }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  function applySettings(s) { cfg = { ...DEFAULTS, ...((s && s.remix) || {}) }; }
  chrome.storage.onChanged.addListener((c, area) => { if (area === "sync" && c[STORE_KEY]) { applySettings(c[STORE_KEY].newValue); refresh(); } });

  function init() {
    chrome.storage.sync.get(STORE_KEY, (res) => {
      applySettings(res && res[STORE_KEY]);
      refresh(); startObserver();
      [400, 1000, 2200].forEach((d) => setTimeout(() => !scanning && refresh(), d));
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
