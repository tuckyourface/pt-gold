/* =========================================================================
 * PT Gold — thread-page helper (isolated content script)
 *
 * Mentions are collected forum-wide by the background search poller, NOT by
 * scraping pages you browse (that caused duplicate alerts and was clunky).
 * This script now does just two passive things on thread pages:
 *   1. relay the forum's API endpoints captured by discover.js (MAIN world)
 *   2. honor "#ptgpost=<id>" deep-links from the dashboard — scroll to the
 *      exact post (walking pagination if needed) and flash it.
 * It never harvests or sends mention hits.
 * ========================================================================= */
(() => {
  "use strict";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---- relay discovered endpoints from the MAIN world ---- */
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== "ptgold-discover" || !d.endpoint) return;
    try {
      chrome.runtime.sendMessage({ type: "ptg:endpoint", endpoint: d.endpoint }, () =>
        void chrome.runtime.lastError
      );
    } catch (_) {}
  });

  /* ---- locate a post by its forum id ---- */
  function postId(el) {
    const a = el.querySelector('a[href*="%2Fposts%2F"], .post_tools a[href*="/posts/"]');
    if (a) {
      const href = decodeURIComponent(a.getAttribute("href") || "");
      const m = href.match(/\/posts\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }
  function firstPostId() {
    const el = document.querySelector(".post-listing .post");
    return el ? postId(el) : null;
  }
  function currentPage() {
    const m = (location.hash || "").match(/\/page\/(\d+)/);
    return m ? parseInt(m[1], 10) : 1;
  }
  function maxPage() {
    let max = 1;
    document.querySelectorAll('a[href*="/page/"]').forEach((a) => {
      const mm = (a.getAttribute("href") || "").match(/\/page\/(\d+)/);
      if (mm) max = Math.max(max, parseInt(mm[1], 10));
    });
    return max;
  }
  function pageAnchor(n) {
    return [...document.querySelectorAll('a[href*="/page/"]')].find((a) => {
      const mm = (a.getAttribute("href") || "").match(/\/page\/(\d+)/);
      return mm && parseInt(mm[1], 10) === n;
    });
  }
  async function gotoPage(n) {
    const before = firstPostId();
    const a = pageAnchor(n);
    if (a) a.click();
    else location.hash = "#/page/" + n;
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      const now = firstPostId();
      if (now && now !== before) { await sleep(250); return true; }
    }
    await sleep(300);
    return false;
  }

  /* ---- deep-link: scroll to an exact post (#ptgpost=<id>) ---- */
  function jumpHash() {
    const h = location.hash || "";
    const pid = (h.match(/ptgpost=(\d+)/) || [])[1] || null;
    let text = (h.match(/ptgtext=([^&]+)/) || [])[1] || "";
    try { text = decodeURIComponent(text); } catch (_) {}
    return { pid, text: text.toLowerCase().replace(/\s+/g, " ").trim() };
  }
  let jumping = false;
  async function jumpTo(pid, text) {
    if (jumping) return;
    jumping = true;
    try {
      // match by post id, OR by a distinctive text fragment (DOM may lack the id)
      const find = () => [...document.querySelectorAll(".post-listing .post")].find((el) => {
        if (pid && postId(el) === pid) return true;
        if (text) {
          const body = el.querySelector(".post_body_container");
          if (body && (body.textContent || "").toLowerCase().replace(/\s+/g, " ").indexOf(text) !== -1) return true;
        }
        return false;
      });
      let el = find();
      if (!el) {
        const max = maxPage();
        for (let n = 1; n <= max; n++) {
          if (n !== currentPage()) { const ok = await gotoPage(n); if (!ok) continue; }
          el = find();
          if (el) break;
        }
      }
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("ptg-flash");
        setTimeout(() => el.classList.remove("ptg-flash"), 1800);
      }
    } finally {
      jumping = false;
    }
  }
  async function maybeJump() {
    const { pid, text } = jumpHash();
    if (!pid && !text) return;
    for (let i = 0; i < 40; i++) {
      if (document.querySelector(".post-listing .post")) break;
      await sleep(150);
    }
    jumpTo(pid, text);
  }

  window.addEventListener("hashchange", maybeJump);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", maybeJump, { once: true });
  } else {
    maybeJump();
  }
})();
