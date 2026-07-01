/* =========================================================================
 * PT Gold — on-site image embedding (opt-in, isolated content script).
 *
 * The forum stores post bodies as plain text and never turns image URLs into
 * images — everyone sees raw links. When the user enables "Embed images on the
 * forum" (Settings, OFF by default), this rewrites bare direct-image URLs inside
 * post bodies into inline <img> as you browse. Only people running PT Gold see
 * them; the forum itself and other users are unaffected.
 *
 * It touches nothing else on the page and does nothing at all while disabled.
 * ========================================================================= */
(() => {
  "use strict";
  const KEY = "ptgold_settings";
  let on = false, obs = null;

  const IMG_EXT = /\.(gif|png|jpe?g|webp|bmp|avif)(\?[^\s]*)?$/i;
  const IMG_HOST = /^https:\/\/(i\.imgur\.com|media\d*\.giphy\.com|[a-z0-9-]+\.tenor\.com|i\.postimg\.cc|i\.imgflip\.com|i\.redd\.it|pbs\.twimg\.com)\//i;
  const isImg = (u) => /^https:\/\//i.test(u) && (IMG_EXT.test(u) || IMG_HOST.test(u));
  const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

  function imgLink(url) {
    const a = document.createElement("a");
    a.className = "ptg-embed-link"; a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
    const img = document.createElement("img");
    img.className = "ptg-embed-img"; img.loading = "lazy"; img.src = url; img.alt = "";
    img.addEventListener("error", () => a.replaceWith(document.createTextNode(url)), { once: true });
    a.appendChild(img);
    return a;
  }

  // Bare image URL sitting in a text node → inline <img>.
  function processTextNode(node) {
    const text = node.nodeValue;
    if (!text || text.indexOf("http") === -1) return;
    URL_RE.lastIndex = 0;
    let m, last = 0, found = false;
    const frag = document.createDocumentFragment();
    while ((m = URL_RE.exec(text))) {
      const url = m[0];
      if (!isImg(url)) continue;
      found = true;
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(imgLink(url));
      last = m.index + url.length;
    }
    if (!found) return;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  // Auto-linked image URL (<a href="…png">…</a>) → swap its content for the image.
  function processAnchor(a) {
    const href = a.getAttribute("href") || "";
    if (!isImg(href) || a.querySelector("img")) return;
    a.classList.add("ptg-embed-link");
    a.textContent = "";
    const img = document.createElement("img");
    img.className = "ptg-embed-img"; img.loading = "lazy"; img.src = href; img.alt = "";
    a.appendChild(img);
    a.target = "_blank"; a.rel = "noopener noreferrer";
  }

  function walk(container) {
    if (!container || container.dataset.ptgImagified === "1") return;
    container.dataset.ptgImagified = "1";                 // attribute change; not observed → no loop
    container.querySelectorAll("a[href]").forEach(processAnchor);
    const tw = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeValue && n.nodeValue.indexOf("http") !== -1 &&
        !(n.parentNode && n.parentNode.closest && n.parentNode.closest("a"))
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const nodes = [];
    let n; while ((n = tw.nextNode())) nodes.push(n);
    nodes.forEach(processTextNode);
  }

  function scan() { if (on) document.querySelectorAll(".post_body_container").forEach(walk); }

  function start() {
    scan();
    if (obs) return;
    obs = new MutationObserver(() => { if (on) scan(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
  function stop() { if (obs) { obs.disconnect(); obs = null; } } // rendered images persist until reload

  function apply(v) {
    const next = v === true;
    if (next === on) return;
    on = next;
    if (on) start(); else stop();
  }

  chrome.storage.sync.get(KEY, (r) => apply((r[KEY] || {}).embedImages));
  chrome.storage.onChanged.addListener((c, area) => { if (area === "sync" && c[KEY]) apply((c[KEY].newValue || {}).embedImages); });
})();
