/* PT Gold — dashboard controller (Mentions feed + Settings).
 * Mentions come from the forum-wide background poller. This view focuses on
 * making each mention instantly legible: the responder's reply leads, your
 * quoted words are highlighted, and deeper quote layers are color-coded. */
(() => {
  "use strict";
  const INBOX = "ptg_inbox";
  const SETTINGS = "ptgold_settings";
  const MON_DEFAULTS = { notify: true, badge: true, pollMinutes: 5, notifyDirect: true, notifyNested: true, notifyMention: true, notifyKeywords: true, lookbackDays: 60 };

  let inbox = [];
  let settings = {};
  let kindFilter = "all";
  let unreadOnly = false;
  let query = "";
  let currentItems = [];
  const cardEls = new Map(); // key -> element
  const openKeys = new Set();
  let selKey = null;

  const $ = (s) => document.querySelector(s);
  const list = $("#list");
  const status = $("#status");
  const esc = (x) => String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const getLocal = (k, d) => new Promise((r) => chrome.storage.local.get(k, (o) => r(o[k] === undefined ? d : o[k])));
  const setLocal = (k, v) => new Promise((r) => chrome.storage.local.set({ [k]: v }, r));

  /* ============ tabs ============ */
  document.querySelectorAll(".db-tab").forEach((t) =>
    t.addEventListener("click", () => {
      const v = t.dataset.view;
      document.querySelectorAll(".db-tab").forEach((x) => x.classList.toggle("on", x === t));
      document.querySelectorAll(".view").forEach((s) => (s.hidden = s.id !== "view-" + v));
      if (v === "board" && !boardLoaded) loadBoard();
    })
  );

  /* ============ BBCode parsing ============ */
  function cleanText(s) {
    return String(s || "")
      .replace(/\[\/?(?!quote)[a-z][^\]]*\]/gi, "")          // strip non-quote bbcode
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }
  function parseBB(raw) {
    const root = { type: "root", author: "", children: [] };
    const stack = [root];
    const re = /\[quote=([^\]]+)\]|\[quote\]|\[\/quote\]/gi;
    let last = 0, m;
    while ((m = re.exec(raw))) {
      const text = raw.slice(last, m.index);
      if (text) stack[stack.length - 1].children.push({ type: "text", text });
      last = re.lastIndex;
      if (m[0].toLowerCase().indexOf("[quote") === 0) {
        const node = { type: "quote", author: (m[1] || "").trim(), children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      } else if (stack.length > 1) stack.pop();
    }
    const tail = raw.slice(last);
    if (tail) stack[stack.length - 1].children.push({ type: "text", text: tail });
    return root;
  }
  const directText = (node) => cleanText(node.children.filter((c) => c.type === "text").map((c) => c.text).join("\n"));
  function findMeQuote(node, me) {
    for (const c of node.children) {
      if (c.type === "quote") {
        if (me && c.author.toLowerCase() === me) return c;
        const d = findMeQuote(c, me);
        if (d) return d;
      }
    }
    return null;
  }

  /* ============ helpers ============ */
  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60); if (m < 60) return m + "m";
    const h = Math.floor(m / 60); if (h < 24) return h + "h";
    const d = Math.floor(h / 24); if (d < 30) return d + "d";
    return Math.floor(d / 30) + "mo";
  }
  function tagFor(h) {
    if (h.reason === "keyword") return { cls: "kw", txt: "Keyword" };
    if (h.kind === "thread") return { cls: "thread", txt: "Title" };
    return { cls: "post", txt: "Mention" };
  }
  function actLabel(h) {
    if (h.reason === "keyword") return "matched “" + (h.keyword || "") + "”";
    if (h.kind === "thread") return "thread title";
    if (h.quoteType === "direct") return "quoted you";
    if (h.quoteType === "nested") return "quoted you (nested)";
    return "mentioned you";
  }
  function qtChip(h) {
    if (h.reason !== "mention" || (h.quoteType !== "direct" && h.quoteType !== "nested")) return "";
    const txt = h.quoteType === "direct" ? "Direct quote" : "Nested quote";
    return `<span class="mc-qt ${h.quoteType}" title="Your post was ${h.quoteType === "direct" ? "quoted directly" : "quoted indirectly, nested in a reply chain"}">${txt}</span>`;
  }
  function termFor(h) { return h.reason === "keyword" ? (h.keyword || "") : (settings.myHandle || ""); }

  function highlightInto(el, text, term) {
    if (!term) { el.appendChild(document.createTextNode(text)); return; }
    const low = text.toLowerCase(), t = term.toLowerCase();
    let i = 0, idx;
    while ((idx = low.indexOf(t, i)) !== -1) {
      if (idx > i) el.appendChild(document.createTextNode(text.slice(i, idx)));
      const mk = document.createElement("mark");
      mk.textContent = text.slice(idx, idx + term.length);
      el.appendChild(mk);
      i = idx + term.length;
    }
    el.appendChild(document.createTextNode(text.slice(i)));
  }

  function previewText(h) {
    const root = parseBB(h.body || h.snippet || "");
    let txt = directText(root);
    if (!txt) {
      const mq = findMeQuote(root, (settings.myHandle || "").toLowerCase());
      txt = mq ? "re: " + directText(mq) : cleanText(h.body || h.snippet || "");
    }
    return txt || h.snippet || "";
  }

  /* ============ expanded body ============ */
  function renderQuoteEl(q, depth, me, ctx) {
    const div = document.createElement("div");
    const mine = me && q.author.toLowerCase() === me;
    div.className = "q q-d" + Math.min(depth, 4) + (mine ? " q-me" : "");
    const a = document.createElement("div");
    a.className = "q-author";
    a.textContent = q.author || "unknown";
    if (mine) { const tg = document.createElement("span"); tg.className = "q-me-tag"; tg.textContent = "YOU"; a.appendChild(tg); }
    div.appendChild(a);
    if (mine && !ctx.meEl) ctx.meEl = div;
    q.children.forEach((ch) => {
      if (ch.type === "text") {
        const t = cleanText(ch.text);
        if (t) { const p = document.createElement("div"); p.className = "q-text"; highlightInto(p, t, ctx.term); div.appendChild(p); }
      } else div.appendChild(renderQuoteEl(ch, depth + 1, me, ctx));
    });
    return div;
  }
  function buildExpanded(h) {
    const me = (settings.myHandle || "").toLowerCase();
    const ctx = { term: termFor(h), meEl: null };
    const root = parseBB(h.body || h.snippet || "");
    const wrap = document.createElement("div");
    wrap.className = "mc-body";

    const reply = directText(root);
    const rl = document.createElement("div");
    rl.className = "mc-sectlabel";
    rl.textContent = (h.author || "They") + "’s reply";
    wrap.appendChild(rl);
    const rb = document.createElement("div");
    rb.className = "mc-reply";
    if (reply) highlightInto(rb, reply, ctx.term);
    else { const s = document.createElement("span"); s.className = "mute2"; s.textContent = "— quoted you with no added text —"; rb.appendChild(s); }
    wrap.appendChild(rb);

    const quotes = root.children.filter((c) => c.type === "quote");
    if (quotes.length) {
      const cl = document.createElement("div");
      cl.className = "mc-sectlabel";
      cl.textContent = "Quoted context";
      wrap.appendChild(cl);
      quotes.forEach((q) => wrap.appendChild(renderQuoteEl(q, 0, me, ctx)));
    }

    const actions = document.createElement("div");
    actions.className = "mc-actions";
    const open = document.createElement("button");
    open.className = "mc-open";
    open.textContent = h.kind === "thread" ? "Open thread ↗" : "Open to this post ↗";
    open.addEventListener("click", (e) => { e.stopPropagation(); openHit(h); });
    const rd = document.createElement("button");
    rd.className = "mc-readbtn";
    rd.textContent = h.read ? "Mark unread" : "Mark read";
    rd.addEventListener("click", (e) => { e.stopPropagation(); toggleRead(h); });
    actions.append(open, rd);
    wrap.appendChild(actions);
    return wrap;
  }

  /* ============ card ============ */
  function card(h) {
    const el = document.createElement("div");
    el.className = "mcard " + (h.read ? "read" : "unread");
    el.dataset.key = h.key;
    const tag = tagFor(h);

    const top = document.createElement("div");
    top.className = "mc-top";
    const mid = qtChip(h) || `<span class="mc-act">${esc(actLabel(h))}</span>`;
    top.innerHTML =
      `<span class="mc-tag ${tag.cls}">${tag.txt}</span>` +
      `<span class="mc-author">${esc(h.author || "unknown")}</span>` +
      mid +
      `<span class="mc-when">${timeAgo(h.ts)}</span>` +
      `<span class="mc-chev">▸</span>`;
    top.addEventListener("click", () => { select(h.key); toggleExpand(el, h); });

    const thread = document.createElement("div");
    thread.className = "mc-thread";
    const ic = document.createElement("span"); ic.className = "ic"; ic.textContent = "in";
    const tt = document.createElement("span"); tt.className = "tt"; tt.textContent = h.threadTitle || "(thread)";
    tt.title = "Open thread";
    // Only the title text is the link (not the whole row) — avoids stray tab-opens
    tt.addEventListener("click", (e) => { e.stopPropagation(); openHit(h); });
    thread.append(ic, tt);

    const pv = document.createElement("div");
    pv.className = "mc-preview";
    pv.title = "Click to expand";
    highlightInto(pv, previewText(h), termFor(h));
    pv.addEventListener("click", () => { select(h.key); toggleExpand(el, h); });

    const x = document.createElement("span");
    x.className = "mc-x"; x.textContent = "×"; x.title = "Dismiss";
    x.addEventListener("click", (e) => { e.stopPropagation(); removeHit(h.key); });

    el.append(top, thread, pv, x);
    if (openKeys.has(h.key)) { el.appendChild(buildExpanded(h)); el.classList.add("open"); }
    if (h.key === selKey) el.classList.add("sel");
    return el;
  }

  function toggleExpand(el, h) {
    if (el.classList.contains("open")) { el.classList.remove("open"); openKeys.delete(h.key); return; }
    if (!el.querySelector(".mc-body")) el.appendChild(buildExpanded(h));
    el.classList.add("open");
    openKeys.add(h.key);
    if (!h.read) markRead(h, true);
    requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  /* ============ state ops ============ */
  async function persist() { await setLocal(INBOX, inbox); }
  function markRead(h, val) { h.read = val; const el = cardEls.get(h.key); if (el) el.classList.toggle("read", val), el.classList.toggle("unread", !val); persist(); counts(); }
  function toggleRead(h) { markRead(h, !h.read); const el = cardEls.get(h.key); const b = el && el.querySelector(".mc-readbtn"); if (b) b.textContent = h.read ? "Mark unread" : "Mark read"; }
  async function openHit(h) { if (!h.read) markRead(h, true); if (h.url) chrome.tabs.create({ url: h.url }); }
  async function removeHit(key) { inbox = inbox.filter((i) => i.key !== key); openKeys.delete(key); await persist(); render(); }

  /* ============ selection + keyboard ============ */
  function select(key) {
    selKey = key;
    cardEls.forEach((el, k) => el.classList.toggle("sel", k === key));
  }
  function move(delta) {
    if (!currentItems.length) return;
    let idx = currentItems.findIndex((h) => h.key === selKey);
    idx = idx < 0 ? (delta > 0 ? 0 : currentItems.length - 1) : Math.max(0, Math.min(currentItems.length - 1, idx + delta));
    const h = currentItems[idx];
    select(h.key);
    const el = cardEls.get(h.key);
    if (el) el.scrollIntoView({ block: "nearest" });
  }
  document.addEventListener("keydown", (e) => {
    if ($("#view-feed").hidden) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    const sel = currentItems.find((h) => h.key === selKey);
    const el = sel && cardEls.get(sel.key);
    switch (e.key) {
      case "ArrowDown": case "j": e.preventDefault(); move(1); break;
      case "ArrowUp": case "k": e.preventDefault(); move(-1); break;
      case "Enter": case "e": if (sel && el) { e.preventDefault(); toggleExpand(el, sel); } break;
      case "o": if (sel) { e.preventDefault(); openHit(sel); } break;
      case "r": if (sel) { e.preventDefault(); toggleRead(sel); } break;
      case "x": if (sel) { e.preventDefault(); removeHit(sel.key); } break;
    }
  });

  /* ============ render ============ */
  function counts() {
    $("#c-all").textContent = inbox.length;
    $("#c-post").textContent = inbox.filter((i) => i.kind !== "thread").length;
    $("#c-thread").textContent = inbox.filter((i) => i.kind === "thread").length;
    const unread = inbox.filter((i) => !i.read).length;
    status.textContent = inbox.length ? `${unread} unread · ${inbox.length} total` : "No mentions yet.";
  }
  function visible() {
    const q = query.toLowerCase();
    return inbox
      .filter((i) => (kindFilter === "all" ? true : kindFilter === "thread" ? i.kind === "thread" : i.kind !== "thread"))
      .filter((i) => (unreadOnly ? !i.read : true))
      .filter((i) => !q || (i.author + " " + i.threadTitle + " " + (i.snippet || "") + " " + (i.body || "")).toLowerCase().includes(q))
      .sort((a, b) => b.ts - a.ts);
  }
  function render() {
    counts();
    cardEls.clear();
    list.textContent = "";
    currentItems = visible();
    if (!currentItems.length) {
      const e = document.createElement("div");
      e.className = "feed-empty";
      e.innerHTML = inbox.length
        ? "Nothing matches this view."
        : "No mentions yet.<br>Set <b>your handle</b> in Settings — then every mention of you across the forum shows up here.";
      list.appendChild(e);
      return;
    }
    currentItems.forEach((h) => { const el = card(h); cardEls.set(h.key, el); list.appendChild(el); });
    // keep a visible selection so keyboard nav + focus ring are always present
    if (!selKey || !cardEls.has(selKey)) select(currentItems[0].key);
    else select(selKey);
  }

  /* ============ feed events ============ */
  document.querySelectorAll("#kindSeg button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#kindSeg button").forEach((x) => x.classList.toggle("on", x === b));
      kindFilter = b.dataset.kind; render();
    })
  );
  $("#unreadOnly").addEventListener("change", (e) => { unreadOnly = e.target.checked; render(); });
  const searchBox = $("#searchBox"), searchClear = $("#searchClear");
  searchBox.addEventListener("input", () => { query = searchBox.value.trim(); searchClear.hidden = !query; render(); });
  searchClear.addEventListener("click", () => { searchBox.value = ""; query = ""; searchClear.hidden = true; render(); searchBox.focus(); });
  $("#markAll").addEventListener("click", async () => { inbox.forEach((i) => (i.read = true)); await persist(); render(); });
  $("#clearAll").addEventListener("click", async () => { inbox = []; openKeys.clear(); await persist(); render(); });
  const checkBtn = $("#checkBtn");
  checkBtn.addEventListener("click", () => {
    checkBtn.classList.add("spin");
    status.textContent = "Checking…";
    chrome.runtime.sendMessage({ type: "ptg:pollNow" }, () => void chrome.runtime.lastError);
    setTimeout(() => checkBtn.classList.remove("spin"), 1400);
  });
  $("#popBtn").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }));

  /* ============ board ============ */
  const TAG = 2; // Phish forum topic tag
  const GROUPS = {
    phish: ["phish", "trey", "fishman", "gamehendge", "baker's dozen", "sphere", "mike's", "gordon"],
    jam: ["goose", "billy strings", "grateful", " dead", "umphrey", "biscuits", "sci ", "cheese", "widespread", "panic", "jam", "moe.", "lettuce", "spafford", "wsmfp", "phil "],
    politics: ["trump", "biden", "maga", "politic", "antifa", "commie", "republican", "democrat", "left", "right", "euro", "ice ", "vaccin", "gun ", "war", "israel", "gaza", "nazi"],
    sports: ["nba", "nfl", "mlb", "nhl", "hockey", "football", "baseball", "basketball", "soccer", "golf", "ufc", "fantasy", "playoff", "yankees", "sox"],
    music: ["album", "song", "tour", "setlist", "concert", "vinyl", "spotify", "record", "band", "guitar"],
  };
  function groupOf(s) {
    s = " " + (s || "").toLowerCase() + " ";
    for (const [g, kws] of Object.entries(GROUPS)) if (kws.some((k) => s.includes(k))) return g;
    return "other";
  }
  let boardTopics = [], boardSort = "active", boardGroup = "all", boardLoaded = false;

  async function loadBoard() {
    boardLoaded = true;
    $("#boardStatus").textContent = "Loading…";
    try {
      const res = await fetch(`https://www.phantasytour.com/api/tags/${TAG}/topics?page=1&pageSize=60&activeOnly=true`,
        { credentials: "omit", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" } });
      const j = await res.json();
      boardTopics = Array.isArray(j) ? j : [];
      renderGroups(); renderBoard();
    } catch (_) {
      $("#boardStatus").textContent = "Couldn’t load the board. Try Refresh.";
    }
  }
  function renderGroups() {
    const counts = { all: boardTopics.length };
    boardTopics.forEach((t) => { const g = groupOf(t.subject); counts[g] = (counts[g] || 0) + 1; });
    const box = $("#boardGroups");
    box.textContent = "";
    ["all", "phish", "jam", "politics", "sports", "music", "other"].forEach((g) => {
      if (g !== "all" && !counts[g]) return;
      const b = document.createElement("button");
      b.className = "grpchip grp-" + g + (g === boardGroup ? " on" : "");
      b.textContent = (g === "all" ? "All" : g[0].toUpperCase() + g.slice(1)) + " " + (counts[g] || 0);
      b.addEventListener("click", () => { boardGroup = g; renderGroups(); renderBoard(); });
      box.appendChild(b);
    });
  }
  const PT_ORIGIN = "https://www.phantasytour.com";
  function agoCoarse(ts) {
    if (!ts) return "—";
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
    const d = Math.floor(h / 24); if (d < 30) return d + "d ago";
    return Math.floor(d / 30) + "mo ago";
  }
  function fmtSpan(ms) {
    if (!ms || ms < 0) return "—";
    const m = Math.floor(ms / 60000); if (m < 60) return m + "m";
    const h = Math.floor(m / 60); if (h < 24) return h + "h " + (m % 60) + "m";
    const d = Math.floor(h / 24); return d + "d " + (h % 24) + "h";
  }

  function topicRow(t) {
    const wrap = document.createElement("div"); wrap.className = "titem";
    const el = document.createElement("div"); el.className = "trow" + (t.isSticky ? " sticky" : "");
    const g = groupOf(t.subject);
    const url = `${PT_ORIGIN}/bands/phish/threads/${t.id}/${t.slug || ""}`;
    const grp = document.createElement("span"); grp.className = "trow-grp grp-" + g; grp.textContent = g;
    const main = document.createElement("div"); main.className = "trow-main";
    const subj = document.createElement("a"); subj.className = "trow-subj"; subj.textContent = t.subject || "(untitled)";
    subj.href = url; subj.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); chrome.tabs.create({ url }); });
    const meta = document.createElement("div"); meta.className = "trow-meta";
    meta.textContent = `${t.authorUsername || "?"} · ${t.postCount} posts · last active ${agoCoarse(Date.parse(t.dateOfLastPost))}`;
    main.append(subj, meta);
    const chev = document.createElement("span"); chev.className = "trow-chev"; chev.textContent = "▸";
    el.append(grp, main, chev);
    el.addEventListener("click", () => toggleTopic(wrap, t));
    wrap.appendChild(el);
    return wrap;
  }

  function toggleTopic(wrap, t) {
    if (wrap.classList.contains("open")) { wrap.classList.remove("open"); return; }
    wrap.classList.add("open");
    if (!wrap.querySelector(".texp")) {
      const exp = document.createElement("div"); exp.className = "texp";
      exp.innerHTML = '<div class="texp-msg">Loading snapshot…</div>';
      wrap.appendChild(exp);
      loadSnapshot(t, exp);
    }
  }
  async function loadSnapshot(t, exp) {
    try {
      const maxPages = Math.min(6, Math.max(1, Math.ceil((t.postCount || 30) / 30)));
      let posts = [];
      for (let p = 1; p <= maxPages; p++) {
        const r = await fetch(`${PT_ORIGIN}/api/bands/1/threads/${t.id}/posts?page=${p}&pageSize=30`,
          { credentials: "omit", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" } });
        if (!r.ok) break;
        const j = await r.json();
        if (!Array.isArray(j) || !j.length) break;
        posts = posts.concat(j);
        if (j.length < 30) break;
      }
      renderSnapshot(t, posts, exp);
    } catch (_) { exp.innerHTML = '<div class="texp-msg">Couldn’t load this thread.</div>'; }
  }
  const tmetric = (v, l) => `<div class="texp-metric"><div class="texp-metric-v">${v}</div><div class="texp-metric-l">${l}</div></div>`;
  function renderSnapshot(t, posts, exp) {
    exp.textContent = "";
    if (!posts.length) { exp.innerHTML = '<div class="texp-msg">No posts found.</div>'; return; }
    const total = t.postCount || posts.length;
    const sampled = posts.length < total;
    const first = Date.parse(posts[0].dateCreated);
    const last = Date.parse(t.dateOfLastPost) || Date.parse(posts[posts.length - 1].dateCreated);
    const posters = {}, quoted = {};
    posts.forEach((p) => {
      posters[p.authorUsername || "?"] = (posters[p.authorUsername || "?"] || 0) + 1;
      const re = /\[quote=([^\]]+)\]/gi; let m;
      while ((m = re.exec(p.body || ""))) { const a = m[1].trim(); if (a) quoted[a] = (quoted[a] || 0) + 1; }
    });
    const sortT = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
    const topP = sortT(posters).slice(0, 5), topQ = sortT(quoted).slice(0, 5);
    const maxP = topP.length ? topP[0][1] : 1;
    const url = `${PT_ORIGIN}/bands/phish/threads/${t.id}/${t.slug || ""}`;

    const metrics = document.createElement("div"); metrics.className = "texp-metrics";
    metrics.innerHTML = tmetric(total, "posts") + tmetric(Object.keys(posters).length + (sampled ? "+" : ""), "posters") + tmetric(fmtSpan(last - first), "active");
    exp.appendChild(metrics);

    const cols = document.createElement("div"); cols.className = "texp-cols";
    const c1 = document.createElement("div"); c1.className = "texp-col";
    c1.innerHTML = '<div class="texp-h">Top posters' + (sampled ? ' <span class="texp-note">· first ' + posts.length + '</span>' : '') + '</div>';
    topP.forEach(([a, n]) => {
      const row = document.createElement("div"); row.className = "texp-bar-row";
      row.innerHTML = `<span class="texp-bar-name">${esc(a)}</span><span class="texp-bar-wrap"><span class="texp-bar" style="width:${Math.round(n / maxP * 100)}%"></span></span><span class="texp-bar-n">${n}</span>`;
      c1.appendChild(row);
    });
    cols.appendChild(c1);
    const c2 = document.createElement("div"); c2.className = "texp-col";
    c2.innerHTML = '<div class="texp-h">Most quoted</div>' + (topQ.length ? "" : '<div class="texp-note">—</div>');
    topQ.forEach(([a, n]) => {
      const row = document.createElement("div"); row.className = "texp-q-row";
      row.innerHTML = `<span class="texp-q-name">${esc(a)}</span><span class="texp-q-n">↩ ${n}</span>`;
      c2.appendChild(row);
    });
    cols.appendChild(c2);
    exp.appendChild(cols);

    const op = posts[0];
    const opEl = document.createElement("div"); opEl.className = "texp-op";
    opEl.innerHTML = `<div class="texp-h">Original post — ${esc(op.authorUsername || "?")}</div>`;
    const opBody = document.createElement("div"); opBody.className = "texp-op-body";
    opBody.textContent = (cleanText(op.body) || "(no text)").slice(0, 320);
    opEl.appendChild(opBody);
    exp.appendChild(opEl);

    const open = document.createElement("button"); open.className = "btn btn-sm btn-accent"; open.style.marginTop = "10px"; open.textContent = "Open thread ↗";
    open.addEventListener("click", () => chrome.tabs.create({ url }));
    exp.appendChild(open);
  }
  function renderBoard() {
    document.querySelectorAll("#boardSort button").forEach((x) => x.classList.toggle("on", x.dataset.sort === boardSort));
    let items = boardTopics.filter((t) => boardGroup === "all" || groupOf(t.subject) === boardGroup);
    items = items.slice().sort((a, b) =>
      boardSort === "busiest" ? (b.postCount - a.postCount) : (Date.parse(b.dateOfLastPost) - Date.parse(a.dateOfLastPost))
    );
    const box = $("#boardList");
    box.textContent = "";
    $("#boardStatus").textContent = items.length + " active topics";
    if (!items.length) { const e = document.createElement("div"); e.className = "feed-empty"; e.textContent = "No topics."; box.appendChild(e); return; }
    items.forEach((t) => box.appendChild(topicRow(t)));
  }
  document.querySelectorAll("#boardSort button").forEach((b) =>
    b.addEventListener("click", () => { boardSort = b.dataset.sort; renderBoard(); })
  );
  $("#boardRefresh").addEventListener("click", loadBoard);

  /* ============ settings ============ */
  function saveSettings() { chrome.storage.sync.set({ [SETTINGS]: settings }); }

  // chip lists: monitor watch-keywords + moderation handles/keywords
  const LISTS = {
    handles: { box: "#handlesChips", prefix: "@", strip: /^@+/ },
    keywords: { box: "#keywordsChips", prefix: "#", strip: null },
    watchKeywords: { box: "#watchChips", prefix: "#", strip: null },
  };
  function renderChips(name) {
    const cfg = LISTS[name]; const box = $(cfg.box); box.textContent = "";
    (settings[name] || []).forEach((v) => {
      const chip = document.createElement("span"); chip.className = "chip";
      if (cfg.prefix) { const p = document.createElement("span"); p.className = "pre"; p.textContent = cfg.prefix; chip.appendChild(p); }
      const t = document.createElement("span"); t.textContent = v; chip.appendChild(t);
      const x = document.createElement("span"); x.className = "rm"; x.textContent = "×";
      x.addEventListener("click", () => { settings[name] = (settings[name] || []).filter((k) => k !== v); saveSettings(); renderChips(name); });
      chip.appendChild(x); box.appendChild(chip);
    });
  }
  document.querySelectorAll("form.field[data-list]").forEach((f) => {
    const name = f.dataset.list, input = f.querySelector("input"), cfg = LISTS[name];
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      let v = input.value.trim(); if (cfg && cfg.strip) v = v.replace(cfg.strip, "");
      v = v.toLowerCase();
      if (v && !(settings[name] || []).includes(v)) { settings[name] = [...(settings[name] || []), v].sort(); saveSettings(); renderChips(name); }
      input.value = ""; input.focus();
    });
  });

  // The skin choice themes the extension UI too (light skin → light panel).
  function applyTheme() {
    if (settings.skin === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
  }
  function renderSkin() { document.querySelectorAll("#skinSeg button").forEach((b) => b.classList.toggle("on", b.dataset.skin === (settings.skin || "original"))); }
  function renderAssay() {
    const r = settings.remix || {};
    $("#rx-enabled").checked = r.enabled !== false;
    $("#rx-badges").checked = r.badges !== false;
    $("#rx-panel").checked = r.panel !== false;
    $("#rx-topn").textContent = String(r.topN || 5);
  }
  function renderSettings() {
    $("#myHandle").value = settings.myHandle || "";
    const m = settings.monitor;
    $("#n-desktop").checked = m.notify !== false;
    $("#n-direct").checked = m.notifyDirect !== false;
    $("#n-nested").checked = m.notifyNested !== false;
    $("#n-mention").checked = m.notifyMention !== false;
    $("#n-keywords").checked = m.notifyKeywords !== false;
    $("#n-badge").checked = m.badge !== false;
    $("#pollMinutes").value = String(m.pollMinutes || 5);
    $("#lookbackDays").value = String(m.lookbackDays || 60);
    $("#mod-enabled").checked = settings.enabled !== false;
    renderChips("handles"); renderChips("keywords"); renderChips("watchKeywords");
    renderSkin(); renderAssay(); applyTheme();
  }
  const setMon = (k, v) => { settings.monitor = { ...settings.monitor, [k]: v }; saveSettings(); };
  const setRemix = (k, v) => { settings.remix = { ...(settings.remix || {}), [k]: v }; saveSettings(); renderAssay(); };

  $("#handleForm").addEventListener("submit", (e) => { e.preventDefault(); settings.myHandle = $("#myHandle").value.trim().replace(/^@+/, ""); saveSettings(); render(); });
  $("#myHandle").addEventListener("blur", () => { const v = $("#myHandle").value.trim().replace(/^@+/, ""); if (v !== settings.myHandle) { settings.myHandle = v; saveSettings(); render(); } });
  $("#n-desktop").addEventListener("change", (e) => setMon("notify", e.target.checked));
  $("#n-direct").addEventListener("change", (e) => setMon("notifyDirect", e.target.checked));
  $("#n-nested").addEventListener("change", (e) => setMon("notifyNested", e.target.checked));
  $("#n-mention").addEventListener("change", (e) => setMon("notifyMention", e.target.checked));
  $("#n-keywords").addEventListener("change", (e) => setMon("notifyKeywords", e.target.checked));
  $("#n-badge").addEventListener("change", (e) => setMon("badge", e.target.checked));
  $("#pollMinutes").addEventListener("change", (e) => setMon("pollMinutes", parseInt(e.target.value, 10)));
  $("#lookbackDays").addEventListener("change", (e) => setMon("lookbackDays", parseInt(e.target.value, 10)));
  $("#mod-enabled").addEventListener("change", (e) => { settings.enabled = e.target.checked; saveSettings(); });
  document.querySelectorAll("#skinSeg button").forEach((b) => b.addEventListener("click", () => { settings.skin = b.dataset.skin; saveSettings(); renderSkin(); applyTheme(); }));
  $("#rx-enabled").addEventListener("change", (e) => setRemix("enabled", e.target.checked));
  $("#rx-badges").addEventListener("change", (e) => setRemix("badges", e.target.checked));
  $("#rx-panel").addEventListener("change", (e) => setRemix("panel", e.target.checked));
  $("#rx-dec").addEventListener("click", () => setRemix("topN", Math.max(3, ((settings.remix || {}).topN || 5) - 1)));
  $("#rx-inc").addEventListener("click", () => setRemix("topN", Math.min(15, ((settings.remix || {}).topN || 5) + 1)));

  /* ============ live ============ */
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && c[INBOX]) { inbox = c[INBOX].newValue || []; render(); }
    if (area === "sync" && c[SETTINGS]) {
      settings = normalize(c[SETTINGS].newValue);
      applyTheme();
    }
  });

  /* ============ boot ============ */
  Promise.all([
    getLocal(INBOX, []),
    new Promise((r) => chrome.storage.sync.get(SETTINGS, (o) => r(o[SETTINGS] || {}))),
  ]).then(([ib, st]) => {
    inbox = ib;
    settings = normalize(st);
    renderSettings();
    render();
  });

  function normalize(s) {
    s = s || {};
    ["handles", "keywords", "watchKeywords"].forEach((k) => { s[k] = Array.isArray(s[k]) ? s[k] : []; });
    s.monitor = { ...MON_DEFAULTS, ...(s.monitor || {}) };
    s.remix = { enabled: true, badges: true, panel: true, topN: 5, ...(s.remix || {}) };
    s.skin = s.skin || "original";
    s.enabled = s.enabled !== false;
    s.myHandle = typeof s.myHandle === "string" ? s.myHandle : "";
    return s;
  }
})();
