/* =========================================================================
 * PT Gold — content script
 * Moderates the Phish forum on phantasytour.com by hiding threads, posts,
 * and posts containing quoted nests that match user-defined handles/keywords.
 *
 * The site renders its lists client-side with Knockout.js, so nodes appear
 * after initial load and re-render on pagination. We therefore (a) re-apply
 * on a debounced MutationObserver and (b) re-apply on storage changes.
 * ========================================================================= */
(() => {
  "use strict";

  const HIDDEN_CLASS = "ptgold-hidden";
  const STORE_KEY = "ptgold_settings";

  const DEFAULTS = {
    enabled: true,
    handles: [],   // usernames: hide their posts/threads + posts that quote them
    keywords: [],  // free text: hide posts/threads whose text contains them
  };

  let settings = { ...DEFAULTS };
  let handleSet = new Set();   // lowercased handles
  let keywordList = [];        // lowercased keywords

  /* ---------- helpers ---------- */

  const norm = (s) => (s || "").trim().toLowerCase();

  function rebuildMatchers() {
    handleSet = new Set((settings.handles || []).map(norm).filter(Boolean));
    keywordList = (settings.keywords || []).map(norm).filter(Boolean);
  }

  function textHasKeyword(text) {
    if (!keywordList.length) return null;
    const t = text.toLowerCase();
    for (const k of keywordList) {
      if (t.indexOf(k) !== -1) return k;
    }
    return null;
  }

  function hide(el, reason) {
    if (!el.classList.contains(HIDDEN_CLASS)) {
      el.classList.add(HIDDEN_CLASS);
    }
    el.dataset.ptgoldReason = reason;
  }

  function unhide(el) {
    el.classList.remove(HIDDEN_CLASS);
    delete el.dataset.ptgoldReason;
  }

  /* ---------- thread-page posts ---------- */
  // Post wrapper: .post  |  author: .poster_name > a  |  body: .post_body_container
  // Quoted authors: .post_body_container cite (title attr or text)
  function evalPost(post) {
    // author handle
    const authorEl = post.querySelector(".poster_name a[href^='/users/']")
      || post.querySelector(".poster_name a");
    const author = norm(authorEl && authorEl.textContent);
    if (author && handleSet.has(author)) {
      return `author: ${author}`;
    }

    const body = post.querySelector(".post_body_container");

    // quoted nests — match any cite (the quoted handle) against blocked handles
    if (body && handleSet.size) {
      const cites = body.querySelectorAll("cite");
      for (const cite of cites) {
        const quoted = norm(cite.getAttribute("title") || cite.textContent);
        if (quoted && handleSet.has(quoted)) {
          return `quotes: ${quoted}`;
        }
      }
    }

    // keyword match against full post text (includes quoted text)
    if (body) {
      const k = textHasKeyword(body.textContent || "");
      if (k) return `keyword: ${k}`;
    }
    return null;
  }

  function applyPosts() {
    const posts = document.querySelectorAll(".post-listing .post, .post-listing > .post");
    let hidden = 0;
    posts.forEach((post) => {
      const reason = evalPost(post);
      if (reason) { hide(post, reason); hidden++; }
      else unhide(post);
    });
    return hidden;
  }

  /* ---------- forum-home thread rows ---------- */
  // Row: table.thread-listing > tbody > tr
  // title: td.topic_subject a   |  author: td.topic_author_display_name a
  function evalRow(row) {
    const authorEl = row.querySelector("td.topic_author_display_name a");
    const author = norm(authorEl && authorEl.textContent);
    if (author && handleSet.has(author)) return `author: ${author}`;

    const titleEl = row.querySelector("td.topic_subject a");
    const title = (titleEl && titleEl.textContent) || "";
    const k = textHasKeyword(title);
    if (k) return `keyword: ${k}`;
    return null;
  }

  function applyRows() {
    const rows = document.querySelectorAll("table.thread-listing > tbody > tr");
    let hidden = 0;
    rows.forEach((row) => {
      // skip header rows / spacer rows lacking a subject cell
      if (!row.querySelector("td.topic_subject")) return;
      const reason = evalRow(row);
      if (reason) { hide(row, reason); hidden++; }
      else unhide(row);
    });
    return hidden;
  }

  /* ---------- orchestration ---------- */
  let lastCount = -1;

  function applyAll() {
    if (!settings.enabled) {
      document.querySelectorAll("." + HIDDEN_CLASS).forEach(unhide);
      reportCount(0);
      return;
    }
    rebuildMatchers();
    const count = applyPosts() + applyRows();
    reportCount(count);
  }

  function reportCount(count) {
    if (count === lastCount) return;
    lastCount = count;
    try {
      chrome.runtime.sendMessage({ type: "ptgold:count", count }, () => void chrome.runtime.lastError);
    } catch (_) { /* extension context may be gone during reload */ }
  }

  // expose current count for popup pull requests
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "ptgold:getCount") {
        sendResponse({ count: Math.max(0, lastCount) });
      }
      return false;
    });
  } catch (_) {}

  /* ---------- observe Knockout re-renders ---------- */
  let pending = null;
  function scheduleApply() {
    if (pending) return;
    pending = setTimeout(() => { pending = null; applyAll(); }, 120);
  }

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) { scheduleApply(); return; }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------- boot ---------- */
  function load(cb) {
    chrome.storage.sync.get(STORE_KEY, (res) => {
      const s = res && res[STORE_KEY];
      settings = { ...DEFAULTS, ...(s || {}) };
      rebuildMatchers();
      cb && cb();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[STORE_KEY]) {
      settings = { ...DEFAULTS, ...(changes[STORE_KEY].newValue || {}) };
      lastCount = -1;
      applyAll();
    }
  });

  let observerStarted = false;
  function init() {
    load(() => {
      applyAll();
      if (!observerStarted) { observerStarted = true; startObserver(); }
      // safety net: a few delayed passes catch the async first render
      [300, 800, 1800].forEach((d) => setTimeout(applyAll, d));
    });
  }

  // Start observing as early as possible (document_start), then full init on DOM ready.
  load(() => {
    if (!observerStarted) { observerStarted = true; startObserver(); }
    applyAll();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
