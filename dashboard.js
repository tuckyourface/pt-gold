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
  // all text inside a node, quotes included (recursive)
  const nodeText = (node) => cleanText(node.children.map((c) => (c.type === "text" ? c.text : nodeText(c))).join(" "));
  // the outermost [quote=…] in a body, if any → { author, text }
  function outerQuote(bb) {
    const q = parseBB(bb || "").children.find((c) => c.type === "quote");
    return q ? { author: q.author || "user", text: nodeText(q) } : null;
  }
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

  /* ---- moderation (same blocklist the on-site content script uses) ----
     Applied to PT Gold's own board/threads/mentions/search so hiding works in
     the panel and on the forum simultaneously. Blocked items are omitted. */
  function getMod() {
    return {
      on: settings.enabled !== false,
      handles: new Set((settings.handles || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean)),
      keywords: (settings.keywords || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean),
    };
  }
  const kwHit = (text, kws) => { const t = (text || "").toLowerCase(); for (const k of kws) if (t.indexOf(k) !== -1) return k; return null; };
  function modBlocksTopic(mod, t) {
    if (!mod.on) return null;
    const a = String(t.authorUsername || "").toLowerCase();
    if (a && mod.handles.has(a)) return "author:" + a;
    const k = kwHit(t.subject, mod.keywords);
    return k ? "keyword:" + k : null;
  }
  function modBlocksPost(mod, p) {
    if (!mod.on) return null;
    const a = String(p.authorUsername || p.author || "").toLowerCase();
    if (a && mod.handles.has(a)) return "author:" + a;
    const body = p.body || p.snippet || "";
    if (mod.handles.size && body) {
      const re = /\[quote=([^\]]+)\]/gi; let m;
      while ((m = re.exec(body))) { const q = m[1].trim().toLowerCase(); if (mod.handles.has(q)) return "quotes:" + q; }
    }
    const k = kwHit(body, mod.keywords);
    return k ? "keyword:" + k : null;
  }

  /* Image/link rendering — the forum stores bare URLs as plain text and never
     renders them. We do: direct-image URLs become inline <img> (with a link
     fallback if they won't load), other URLs become clickable links. Requires
     https (the panel is a secure context, so http images would be blocked). */
  const IMG_EXT_RE = /\.(gif|png|jpe?g|webp|bmp|avif)(\?[^\s]*)?$/i;
  const IMG_HOST_RE = /^https:\/\/(i\.imgur\.com|media\d*\.giphy\.com|[a-z0-9-]+\.tenor\.com|i\.postimg\.cc|i\.imgflip\.com|i\.redd\.it|pbs\.twimg\.com)\//i;
  const isImageUrl = (u) => /^https:\/\//i.test(u) && (IMG_EXT_RE.test(u) || IMG_HOST_RE.test(u));
  const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;
  function linkEl(url) {
    const a = document.createElement("a");
    a.className = "rd-link"; a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = url;
    return a;
  }
  function renderRichText(el, text, term) {
    URL_RE.lastIndex = 0;
    let last = 0, m;
    while ((m = URL_RE.exec(text))) {
      if (m.index > last) highlightInto(el, text.slice(last, m.index), term);
      const url = m[0];
      if (isImageUrl(url)) {
        const link = document.createElement("a");
        link.className = "rd-img-link"; link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
        const img = document.createElement("img");
        img.className = "rd-img"; img.loading = "lazy"; img.src = url; img.alt = "";
        img.addEventListener("error", () => link.replaceWith(linkEl(url)), { once: true });
        link.appendChild(img);
        el.appendChild(link);
      } else {
        el.appendChild(linkEl(url));
      }
      last = m.index + url.length;
    }
    if (last < text.length) highlightInto(el, text.slice(last), term);
  }

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
    const replyBtn = document.createElement("button");
    replyBtn.className = "mc-readbtn";
    replyBtn.textContent = "Reply ❝";
    replyBtn.title = "Reply right here, quoting them";
    const rd = document.createElement("button");
    rd.className = "mc-readbtn";
    rd.textContent = h.read ? "Mark unread" : "Mark read";
    rd.addEventListener("click", (e) => { e.stopPropagation(); toggleRead(h); });
    actions.append(open, replyBtn, rd);
    wrap.appendChild(actions);

    // inline reply composer — post to this thread without leaving Mentions
    let composeEl = null;
    replyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (composeEl) { composeEl.hidden = !composeEl.hidden; if (!composeEl.hidden) composeEl._composer.focus(); return; }
      composeEl = buildMentionComposer(h);
      wrap.appendChild(composeEl);
      composeEl._composer.insertQuote(h.author || "user", ownText(h.body || h.snippet || ""));
      composeEl._composer.focus();
    });
    return wrap;
  }

  function buildMentionComposer(h) {
    const c = document.createElement("div"); c.className = "mc-compose";
    c.addEventListener("click", (e) => e.stopPropagation());   // don't collapse the card
    const edEl = document.createElement("div"); edEl.className = "mc-compose-ta";
    const composer = makeRichComposer(edEl, "Write a reply…");
    const row = document.createElement("div"); row.className = "mc-compose-row";
    const status = document.createElement("span"); status.className = "mc-compose-status mute2";
    const spc = document.createElement("span"); spc.className = "grow";
    const cancel = document.createElement("button"); cancel.className = "btn btn-sm btn-ghost"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { c.hidden = true; });
    const send = document.createElement("button"); send.className = "btn btn-sm btn-accent"; send.textContent = "Reply";
    send.addEventListener("click", async () => {
      const body = composer.value.trim(); if (!body || !h.threadId) return;
      send.disabled = true; status.style.color = ""; status.textContent = "Posting…";
      try {
        const res = await postReply(h.threadId, body);
        if (res.ok) { status.textContent = "Posted ✓"; composer.clear(); setTimeout(() => { c.hidden = true; }, 900); }
        else { status.style.color = "var(--danger)"; status.textContent = postErrorText(res, status); }
      } catch (_) { status.style.color = "var(--danger)"; status.textContent = "Network error."; }
      finally { send.disabled = false; }
    });
    row.append(status, spc, cancel, send);
    c.append(edEl, row);
    attachComposerTools(composer);
    c._composer = composer;
    return c;
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
    bindHandle(top.querySelector(".mc-author"), h.authorId, h.author);

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
  function isTyping() {
    const ae = document.activeElement;
    return !!ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable);
  }
  document.addEventListener("keydown", (e) => {
    if ($("#view-feed").hidden) return;
    if (isTyping()) return;   // don't hijack keys while composing a reply
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
    const mod = getMod();
    return inbox
      .filter((i) => !modBlocksPost(mod, i))
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
  let boardSaved = [], boardPinned = new Set(), boardHidden = new Set(), boardShowHidden = false;
  let boardMine = [], boardMineState = "idle"; // idle | loading | ok | auth | error — threads followed on the PT account
  async function loadMyThreads() {
    boardMineState = "loading"; renderBoard();
    let r;
    try {
      r = await new Promise((res) => chrome.runtime.sendMessage(
        { type: "ptg:get", url: `${PT_ORIGIN}/api/tags/2/my-topics?page=1&pageSize=40&activeOnly=true` },
        (resp) => res(chrome.runtime.lastError ? null : resp)));
    } catch (_) { r = null; }
    if (r && Array.isArray(r.data)) { boardMine = r.data; boardMineState = "ok"; }
    else if (r && r.data && r.data.Message) { boardMineState = "auth"; }   // not logged in on the site
    else { boardMineState = "error"; }
    renderBoard();
  }
  let boardViewMode = "table"; // "table" | "cards"
  let boardQuery = "";
  const matchesQuery = (t) => !boardQuery || (String(t.subject || "") + " " + String(t.authorUsername || "")).toLowerCase().includes(boardQuery);

  // Server timestamps are UTC but sent without a 'Z' — parse them as UTC.
  const parseUTC = (s) => Date.parse(s && !/([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s + "Z" : s);

  function loadBoardState(cb) {
    chrome.storage.local.get(["ptg_saved", "ptg_pinned", "ptg_hidden", "ptg_boardview"], (o) => {
      boardSaved = Array.isArray(o.ptg_saved) ? o.ptg_saved : [];
      boardPinned = new Set((o.ptg_pinned || []).map(String));
      boardHidden = new Set((o.ptg_hidden || []).map(String));
      if (o.ptg_boardview === "cards" || o.ptg_boardview === "table") boardViewMode = o.ptg_boardview;
      cb && cb();
    });
  }
  function saveBoardState() {
    chrome.storage.local.set({ ptg_saved: boardSaved, ptg_pinned: [...boardPinned], ptg_hidden: [...boardHidden], ptg_boardview: boardViewMode });
  }
  const isSaved = (id) => boardSaved.some((s) => String(s.id) === String(id));
  const slimTopic = (t) => ({ id: t.id, subject: t.subject, slug: t.slug, authorId: t.authorId, authorUsername: t.authorUsername, postCount: t.postCount, dateOfLastPost: t.dateOfLastPost, isSticky: t.isSticky });
  function toggleSave(t) {
    boardSaved = isSaved(t.id) ? boardSaved.filter((s) => String(s.id) !== String(t.id)) : [slimTopic(t), ...boardSaved];
    saveBoardState(); renderBoard();
  }
  function togglePin(t) {
    const id = String(t.id);
    if (boardPinned.has(id)) boardPinned.delete(id); else boardPinned.add(id);
    saveBoardState(); renderBoard();
  }
  function setHidden(id, on) { on ? boardHidden.add(String(id)) : boardHidden.delete(String(id)); saveBoardState(); renderBoard(); }
  function iconBtn(txt, title, on, onClick) {
    const b = document.createElement("button");
    b.className = "trow-act" + (on ? " on" : "");
    b.textContent = txt; b.title = title;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  let boardBusy = false;
  async function loadBoard() {
    boardLoaded = true;
    if (boardBusy) return;
    boardBusy = true;
    boardTopics = [];
    $("#boardStatus").textContent = "Loading…";
    try {
      // The topics API ignores `page` and caps at ~100 — so pull the full active
      // set in one shot. Older/deeper browsing is the Search tab's job.
      const res = await fetch(`https://www.phantasytour.com/api/tags/${TAG}/topics?pageSize=100&activeOnly=true`,
        { credentials: "omit", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" } });
      const j = await res.json();
      boardTopics = Array.isArray(j) ? j : [];
      renderGroups(); renderBoard();
    } catch (_) {
      $("#boardStatus").textContent = "Couldn’t load the board. Try Refresh.";
    } finally {
      boardBusy = false;
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
  function agoShort(ts) {
    if (!ts) return "—";
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    if (s < 86400 * 30) return Math.floor(s / 86400) + "d";
    return Math.floor(s / 86400 / 30) + "mo";
  }

  function topicRow(t) { return boardViewMode === "cards" ? topicRowCard(t) : topicRowTable(t); }

  function topicActions(t, id, pinned, hidden, saved, url) {
    const actions = document.createElement("div"); actions.className = "trow-actions";
    actions.appendChild(iconBtn("📌", pinned ? "Unpin" : "Pin to top", pinned, () => togglePin(t)));
    actions.appendChild(iconBtn(saved ? "★" : "☆", saved ? "Remove from Saved" : "Save to My Threads", saved, () => toggleSave(t)));
    actions.appendChild(iconBtn(hidden ? "⊕" : "⊘", hidden ? "Unhide" : "Hide from board", false, () => setHidden(id, !hidden)));
    actions.appendChild(iconBtn("⤢", "Open in thread view", false, () => openThreadView(t)));
    actions.appendChild(iconBtn("↗", "Open in browser", false, () => chrome.tabs.create({ url })));
    return actions;
  }

  // Table-style row: [dot + subject] · author · posts · last. Actions on hover.
  function topicRowTable(t) {
    const id = String(t.id);
    const pinned = boardPinned.has(id), hidden = boardHidden.has(id), saved = isSaved(id);
    const g = groupOf(t.subject);
    const url = `${PT_ORIGIN}/bands/phish/threads/${t.id}/${t.slug || ""}`;

    const wrap = document.createElement("div"); wrap.className = "titem";
    const el = document.createElement("div"); el.className = "trow" + (t.isSticky ? " sticky" : "") + (pinned ? " pinned" : "");

    const subjCell = document.createElement("div"); subjCell.className = "trow-subj-cell";
    const dot = document.createElement("span"); dot.className = "trow-dot grp-" + g; dot.title = g;
    const subj = document.createElement("span"); subj.className = "trow-subj"; subj.textContent = t.subject || "(untitled)";
    subjCell.append(dot, subj);
    subjCell.addEventListener("click", () => toggleTopic(wrap, t));

    const author = document.createElement("div"); author.className = "trow-col trow-author"; author.textContent = t.authorUsername || "?"; author.title = t.authorUsername || "";
    bindHandle(author, t.authorId, t.authorUsername);
    const posts = document.createElement("div"); posts.className = "trow-col trow-posts"; posts.textContent = t.postCount;
    const last = document.createElement("div"); last.className = "trow-col trow-last"; last.textContent = agoShort(parseUTC(t.dateOfLastPost)); last.title = agoCoarse(parseUTC(t.dateOfLastPost));

    el.append(subjCell, author, posts, last, topicActions(t, id, pinned, hidden, saved, url));
    wrap.appendChild(el);
    return wrap;
  }

  // Card-style row: group pill + title + a one-line meta. Actions on hover.
  function topicRowCard(t) {
    const id = String(t.id);
    const pinned = boardPinned.has(id), hidden = boardHidden.has(id), saved = isSaved(id);
    const g = groupOf(t.subject);
    const url = `${PT_ORIGIN}/bands/phish/threads/${t.id}/${t.slug || ""}`;

    const wrap = document.createElement("div"); wrap.className = "titem";
    const el = document.createElement("div"); el.className = "trowc" + (t.isSticky ? " sticky" : "") + (pinned ? " pinned" : "");

    const grp = document.createElement("span"); grp.className = "trow-grp grp-" + g; grp.textContent = g;
    const main = document.createElement("div"); main.className = "trowc-main";
    const subj = document.createElement("div"); subj.className = "trowc-subj"; subj.textContent = t.subject || "(untitled)";
    const meta = document.createElement("div"); meta.className = "trowc-meta";
    meta.textContent = `${t.authorUsername || "?"} · ${t.postCount} posts · last post ${agoCoarse(parseUTC(t.dateOfLastPost))}`;
    main.append(subj, meta);
    main.addEventListener("click", () => toggleTopic(wrap, t));

    el.append(grp, main, topicActions(t, id, pinned, hidden, saved, url));
    wrap.appendChild(el);
    return wrap;
  }

  // Lazy thread reader: nothing is fetched until a thread is opened, then 30
  // posts at a time (oldest/OP first → newest last), rendered with the same
  // depth-colored nested-quote styling as the Mentions feed.
  // Reflect "is a thread expanded?" on the board so CSS can dim/blur the rest
  // and drop the board's own sticky header (only one sticky header at a time).
  function updateBoardFocus() {
    const list = $("#boardList");
    const anyOpen = !!list.querySelector(".titem.open");
    list.classList.toggle("has-open", anyOpen);
    const vb = $("#view-board"); if (vb) vb.classList.toggle("reading", anyOpen);
  }

  function toggleTopic(wrap, t) {
    if (wrap.classList.contains("open")) { wrap.classList.remove("open"); updateBoardFocus(); return; } // collapse
    // single-open: collapse any other expanded thread so focus mode stays coherent
    $("#boardList").querySelectorAll(".titem.open").forEach((el) => { if (el !== wrap) el.classList.remove("open"); });
    wrap.classList.add("open");
    if (!wrap.querySelector(".texp")) {
      const exp = document.createElement("div"); exp.className = "texp";
      exp._dir = "old";
      exp._totalPages = Math.max(1, Math.ceil((t.postCount || 1) / 30));

      const bar = document.createElement("div"); bar.className = "rd-bar";
      const title = document.createElement("div"); title.className = "rd-btitle"; title.textContent = t.subject || "Thread";
      const ctrls = document.createElement("div"); ctrls.className = "rd-ctrls";
      const tv = document.createElement("button"); tv.className = "btn btn-sm btn-ghost";
      tv.textContent = "⤢ Thread view"; tv.title = "Open the full-screen thread view (reply, search)";
      tv.addEventListener("click", () => openThreadView(t));
      const order = document.createElement("button"); order.className = "rd-order btn btn-sm btn-ghost";
      order.textContent = "Oldest first ⇅"; order.title = "Toggle reading order";
      order.addEventListener("click", () => {
        exp._dir = exp._dir === "old" ? "new" : "old";
        order.textContent = (exp._dir === "old" ? "Oldest first" : "Newest first") + " ⇅";
        startReader(t, exp);
      });
      exp._orderBtn = order;
      const spacer = document.createElement("span"); spacer.className = "grow";
      const coll = document.createElement("button"); coll.className = "rd-collapse btn btn-sm btn-ghost";
      coll.textContent = "▴ Collapse"; coll.title = "Collapse this thread";
      coll.addEventListener("click", () => { wrap.classList.remove("open"); updateBoardFocus(); });
      ctrls.append(tv, order, spacer, coll);
      bar.append(title, ctrls);

      const box = document.createElement("div"); box.className = "rd-posts";
      exp.append(bar, box);
      exp.appendChild(buildReaderComposer(t, exp));   // pinned reply box at the bottom
      wrap.appendChild(exp);
      startReader(t, exp);
    }
    updateBoardFocus();
    wrap.scrollIntoView({ block: "nearest" });
  }

  // Pinned quick-reply composer at the bottom of an expanded thread.
  function buildReaderComposer(t, exp) {
    const c = document.createElement("div"); c.className = "rd-compose";
    const edEl = document.createElement("div"); edEl.className = "rd-compose-ta";
    const composer = makeRichComposer(edEl, "Write a reply… (quotes render formatted)");
    const row = document.createElement("div"); row.className = "rd-compose-row";
    const status = document.createElement("span"); status.className = "rd-compose-status mute2";
    const spc = document.createElement("span"); spc.className = "grow";
    const send = document.createElement("button"); send.className = "btn btn-sm btn-accent"; send.textContent = "Reply";
    send.addEventListener("click", async () => {
      const body = composer.value.trim(); if (!body) return;
      send.disabled = true; status.style.color = ""; status.textContent = "Posting…";
      try {
        const res = await postReply(t.id, body);
        if (res.ok) {
          status.textContent = "Posted ✓"; composer.clear();
          t.postCount = (t.postCount || 0) + 1; exp._totalPages = Math.max(1, Math.ceil(t.postCount / 30));
          exp._dir = "new"; if (exp._orderBtn) exp._orderBtn.textContent = "Newest first ⇅";
          startReader(t, exp);                       // reload newest-first so the reply shows
        } else { status.style.color = "var(--danger)"; status.textContent = postErrorText(res, status); }
      } catch (_) { status.style.color = "var(--danger)"; status.textContent = "Network error."; }
      finally { send.disabled = false; }
    });
    row.append(status, spc, send);
    c.append(edEl, row);
    attachComposerTools(composer);                    // emoji / GIF tools
    exp._composer = composer;
    return c;
  }

  // Quote a specific post into the pinned reply box (as a formatted block).
  function readerQuote(exp, p) {
    const composer = exp && exp._composer; if (!composer) return;
    composer.insertQuote(p.authorUsername || "user", ownText(p.body));
    composer.el.scrollIntoView({ block: "nearest" });
  }

  function startReader(t, exp) {
    const box = exp.querySelector(".rd-posts");
    box.innerHTML = '<div class="texp-msg">Loading thread…</div>';
    const foot = exp.querySelector(".rd-foot"); if (foot) foot.remove();
    exp._count = 0;
    exp._startPage = exp._dir === "new" ? exp._totalPages : 1;
    exp._page = exp._startPage;
    loadThreadPage(t, exp, exp._startPage);
  }

  function fmtDateTime(iso) {
    const ms = parseUTC(iso); if (isNaN(ms)) return "";
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
      " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  // Render a post body in natural reading order: quoted blocks (nested,
  // depth-colored, YOU-highlighted) then the poster's own text.
  function renderPostBody(raw) {
    const me = (settings.myHandle || "").toLowerCase();
    const ctx = { term: settings.myHandle || "", meEl: null };
    const root = parseBB(raw);
    const wrap = document.createElement("div");
    root.children.forEach((ch) => {
      if (ch.type === "text") {
        const txt = cleanText(ch.text);
        if (txt) { const d = document.createElement("div"); d.className = "rd-text"; renderRichText(d, txt, ctx.term); wrap.appendChild(d); }
      } else {
        wrap.appendChild(renderQuoteEl(ch, 0, me, ctx));
      }
    });
    if (!wrap.childNodes.length) { const d = document.createElement("div"); d.className = "rd-text mute2"; d.textContent = "(no text)"; wrap.appendChild(d); }
    return wrap;
  }

  function renderReaderPost(p, n, onQuote) {
    const el = document.createElement("div"); el.className = "rd-post";
    const head = document.createElement("div"); head.className = "rd-head";
    head.innerHTML =
      `<span class="rd-num">#${n}</span>` +
      `<span class="rd-author">${esc(p.authorUsername || "?")}</span>` +
      `<span class="rd-time">${esc(fmtDateTime(p.dateCreated))}</span>`;
    bindHandle(head.querySelector(".rd-author"), p.authorId, p.authorUsername);
    if (onQuote) {
      const qb = document.createElement("button"); qb.className = "rd-quote"; qb.textContent = "❝ Quote"; qb.title = "Quote this post in your reply";
      qb.addEventListener("click", (e) => { e.stopPropagation(); onQuote(p); });
      head.appendChild(qb);
    }
    const body = document.createElement("div"); body.className = "rd-body";
    body.appendChild(renderPostBody(p.body || ""));
    el.append(head, body);
    return el;
  }

  function updateReaderFooter(t, exp) {
    const total = t.postCount || exp._count;
    const old = exp.querySelector(".rd-foot"); if (old) old.remove();
    const foot = document.createElement("div"); foot.className = "rd-foot";
    const info = document.createElement("span"); info.className = "rd-info";
    info.textContent = `Showing ${exp._count} of ${total}`;
    const spacer = document.createElement("span"); spacer.className = "grow";
    foot.append(info, spacer);
    const canMore = exp._dir === "new" ? exp._page > 1 : exp._page < exp._totalPages;
    if (canMore) {
      const more = document.createElement("button"); more.className = "rd-more btn btn-sm btn-accent";
      more.textContent = exp._dir === "new" ? "Load older 30 ↑" : "Load next 30 ↓";
      more.addEventListener("click", () => loadThreadPage(t, exp, exp._dir === "new" ? exp._page - 1 : exp._page + 1));
      foot.appendChild(more);
    }
    const open = document.createElement("button"); open.className = "btn btn-sm btn-ghost";
    open.textContent = "Open in forum ↗";
    open.addEventListener("click", () => chrome.tabs.create({ url: `${PT_ORIGIN}/bands/phish/threads/${t.id}/${t.slug || ""}` }));
    foot.appendChild(open);
    const compose = exp.querySelector(".rd-compose");
    if (compose) exp.insertBefore(foot, compose); else exp.appendChild(foot);
  }

  async function loadThreadPage(t, exp, page) {
    const box = exp.querySelector(".rd-posts");
    const btn = exp.querySelector(".rd-more");
    if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
    const isFirst = page === exp._startPage;
    try {
      const r = await fetch(`${PT_ORIGIN}/api/bands/1/threads/${t.id}/posts?page=${page}&pageSize=30`,
        { credentials: "omit", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" } });
      const posts = r.ok ? await r.json() : [];
      if (isFirst) box.textContent = "";
      if (!Array.isArray(posts) || !posts.length) {
        if (isFirst) box.innerHTML = '<div class="texp-msg">No posts found.</div>';
        return;
      }
      const frag = document.createDocumentFragment();
      const mod = getMod();
      posts.forEach((p, i) => { if (modBlocksPost(mod, p)) return; frag.appendChild(renderReaderPost(p, (page - 1) * 30 + i + 1, (post) => readerQuote(exp, post))); });
      if (exp._dir === "new" && !isFirst) box.insertBefore(frag, box.firstChild); // older page → prepend
      else box.appendChild(frag);
      exp._count += posts.length; exp._page = page;
      updateReaderFooter(t, exp);
      if (exp._dir === "new" && isFirst) { const lastEl = box.lastElementChild; if (lastEl) lastEl.scrollIntoView({ block: "nearest" }); }
    } catch (_) {
      if (isFirst) box.innerHTML = '<div class="texp-msg">Couldn’t load this thread.</div>';
    }
  }

  /* ===== dedicated thread view (full-panel overlay) ===== */
  let tvT = null, tvDir = "old", tvPage = 1, tvStartPage = 1, tvTotalPages = 1, tvCount = 0, tvQuery = "";
  function openThreadView(t) {
    tvT = t; tvDir = "old"; tvTotalPages = Math.max(1, Math.ceil((t.postCount || 1) / 30)); tvQuery = "";
    const url = `${PT_ORIGIN}/bands/phish/threads/${t.id}/${t.slug || ""}`;
    $("#tvTitle").textContent = t.subject || "Thread"; $("#tvTitle").title = t.subject || "";
    $("#tvOrder").textContent = "Oldest first ⇅";
    $("#tvSearch").value = ""; $("#tvSearchClear").hidden = true;
    $("#tvOpen").onclick = () => chrome.tabs.create({ url });
    $("#tvCompose").hidden = true; tvComposer.clear();
    $("#threadView").hidden = false;
    tvStart();
  }
  function tvStart() {
    const inner = $("#tvPosts .tv-inner"); inner.innerHTML = '<div class="texp-msg">Loading thread…</div>';
    $("#tvFoot").textContent = "";
    tvCount = 0; tvStartPage = tvDir === "new" ? tvTotalPages : 1; tvPage = tvStartPage;
    tvLoadPage(tvStartPage);
  }
  async function tvLoadPage(page) {
    const inner = $("#tvPosts .tv-inner");
    const btn = $("#tvFoot .rd-more"); if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
    const isFirst = page === tvStartPage;
    try {
      const r = await fetch(`${PT_ORIGIN}/api/bands/1/threads/${tvT.id}/posts?page=${page}&pageSize=30`,
        { credentials: "omit", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" } });
      const posts = r.ok ? await r.json() : [];
      if (isFirst) inner.textContent = "";
      if (!Array.isArray(posts) || !posts.length) { if (isFirst) inner.innerHTML = '<div class="texp-msg">No posts found.</div>'; return; }
      const frag = document.createDocumentFragment();
      const mod = getMod();
      posts.forEach((p, i) => {
        if (modBlocksPost(mod, p)) return;
        const el = renderReaderPost(p, (page - 1) * 30 + i + 1, (post) => tvOpenComposer(post.authorUsername || "user", ownText(post.body)));
        el.dataset.text = el.textContent.toLowerCase();
        frag.appendChild(el);
      });
      if (tvDir === "new" && !isFirst) inner.insertBefore(frag, inner.firstChild); else inner.appendChild(frag);
      tvCount += posts.length; tvPage = page;
      tvApplySearch(); tvRenderFoot();
      if (tvDir === "new" && isFirst) { const last = inner.lastElementChild; if (last) last.scrollIntoView({ block: "nearest" }); }
    } catch (_) { if (isFirst) inner.innerHTML = '<div class="texp-msg">Couldn’t load this thread.</div>'; }
  }
  function tvRenderFoot() {
    const foot = $("#tvFoot"); foot.textContent = "";
    const total = tvT.postCount || tvCount;
    const info = document.createElement("span"); info.className = "rd-info"; info.textContent = `Showing ${tvCount} of ${total}`;
    const spacer = document.createElement("span"); spacer.className = "grow"; foot.append(info, spacer);
    const canMore = tvDir === "new" ? tvPage > 1 : tvPage < tvTotalPages;
    if (canMore) {
      const more = document.createElement("button"); more.className = "rd-more btn btn-sm btn-accent";
      more.textContent = tvDir === "new" ? "Load older 30 ↑" : "Load next 30 ↓";
      more.addEventListener("click", () => tvLoadPage(tvDir === "new" ? tvPage - 1 : tvPage + 1));
      foot.appendChild(more);
    }
  }
  function tvApplySearch() {
    const q = tvQuery.trim().toLowerCase();
    const inner = $("#tvPosts .tv-inner");
    [...inner.children].forEach((el) => { if (!el.dataset.text) return; el.style.display = (!q || el.dataset.text.includes(q)) ? "" : "none"; });
  }
  $("#tvBack").addEventListener("click", () => { $("#threadView").hidden = true; tvT = null; });
  $("#tvOrder").addEventListener("click", () => { tvDir = tvDir === "old" ? "new" : "old"; $("#tvOrder").textContent = (tvDir === "old" ? "Oldest first" : "Newest first") + " ⇅"; tvStart(); });
  const tvSearchInput = $("#tvSearch"), tvSearchClear = $("#tvSearchClear");
  tvSearchInput.addEventListener("input", () => { tvQuery = tvSearchInput.value; tvSearchClear.hidden = !tvQuery; tvApplySearch(); });
  tvSearchClear.addEventListener("click", () => { tvSearchInput.value = ""; tvQuery = ""; tvSearchClear.hidden = true; tvApplySearch(); tvSearchInput.focus(); });

  /* ===== posting: reply / quote / new thread =====
     Uses the browser's forum session (credentials:'include'). Bodies are BBCode;
     a quote is just [quote=author]text[/quote] inline. */
  function ownText(bb) {
    let s = String(bb || ""), prev;
    do { prev = s; s = s.replace(/\[quote[^\]]*\](?:(?!\[quote[^\]]*\]|\[\/quote\]).)*\[\/quote\]/gis, " "); } while (s !== prev);
    return s.replace(/\[\/?[a-z][^\]]*\]/gi, "").replace(/\s+/g, " ").trim();
  }
  // Route the POST through the background → a real forum tab (same-origin), so
  // the request carries the forum's own Origin/Referer/cookies (extension-origin
  // POSTs get 403'd). Returns { ok, status, text }.
  function postJSON(url, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "ptg:post", url, payload }, (r) => {
        if (chrome.runtime.lastError || !r) resolve({ ok: false, status: 0, text: "no response" });
        else resolve(r);
      });
    });
  }
  const postReply = (threadId, body) => postJSON(`${PT_ORIGIN}/api/bands/1/threads/${threadId}/posts`, { body });
  const postNewThread = (subject, body) => postJSON(`${PT_ORIGIN}/api/bands/1/threads/`, { subject, body });
  // Turn a post result into a human message. `el` (optional) gets the technical
  // detail as a tooltip for debugging.
  function postErrorText(res, el) {
    if (el) el.title = res ? `status ${res.status}${res.token ? " · tok:" + res.token : ""}${res.text ? " · " + String(res.text).slice(0, 80) : ""}` : "no response";
    if (!res || res.status === 0) return "Couldn’t reach the forum — open a phantasytour.com tab and try again.";
    if (res.auth === false || res.status === 401 || res.status === 403 || /Authorization has been denied|not.?authenticated|redirect-to-login|log ?in|sign ?in/i.test(res.text || ""))
      return "You’re not logged in on phantasytour.com. Open the site, sign in, then try again.";
    return "Couldn’t post (error " + res.status + "). Try again in a moment.";
  }

  /* ===== emoji + GIF picker for composer fields ===== */
  function insertAtCursor(ta, text) {
    const s = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    const e = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    const pad = (ta.value && s > 0 && !/\s$/.test(ta.value.slice(0, s))) ? " " : "";
    const ins = pad + text + " ";
    ta.value = ta.value.slice(0, s) + ins + ta.value.slice(e);
    const pos = s + ins.length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    ta.dispatchEvent(new Event("input"));
  }
  // Plain <textarea> wrapped in the composer-target interface {el, focus, insertText}.
  const textareaTarget = (ta) => ({ el: ta, focus: () => ta.focus(), insertText: (t) => insertAtCursor(ta, t) });

  /* ---- rich composer: a contenteditable that renders quoted posts as
     formatted, editable blocks and serializes back to BBCode on send ---- */
  function placeCaretEnd(el) {
    el.focus();
    const sel = window.getSelection(); if (!sel) return;
    const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
    sel.removeAllRanges(); sel.addRange(range);
  }
  function serializeRce(root) {
    const walk = (node) => {
      if (node.nodeType === 3) return node.nodeValue || "";
      if (node.nodeType !== 1) return "";
      if (node.tagName === "BR") return "\n";
      if (node.classList && node.classList.contains("rce-q")) {
        const author = node.dataset.author || "user";
        const bodyEl = node.querySelector(".rce-q-body") || node;
        let inner = ""; bodyEl.childNodes.forEach((c) => { inner += walk(c); });
        return `[quote=${author}]${inner.replace(/^\s+|\s+$/g, "")}[/quote]\n`;
      }
      let inner = ""; node.childNodes.forEach((c) => { inner += walk(c); });
      return /^(DIV|P|LI)$/.test(node.tagName) ? inner + "\n" : inner;
    };
    let out = ""; root.childNodes.forEach((c) => { out += walk(c); });
    return out.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }
  function rceInsertText(root, text) {
    root.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) placeCaretEnd(root);
    document.execCommand("insertText", false, text);
    root.dispatchEvent(new Event("input"));
  }
  function rceInsertQuote(root, author, text) {
    const q = document.createElement("div"); q.className = "rce-q"; q.dataset.author = author || "user";
    const head = document.createElement("div"); head.className = "rce-q-author"; head.contentEditable = "false"; head.textContent = author || "user";
    const bodyEl = document.createElement("div"); bodyEl.className = "rce-q-body"; bodyEl.textContent = text || "";
    q.append(head, bodyEl);
    root.appendChild(q);
    const line = document.createElement("div"); line.appendChild(document.createElement("br"));
    root.appendChild(line);
    placeCaretEnd(line);
    root.dispatchEvent(new Event("input"));
  }
  function makeRichComposer(el, placeholder) {
    el.classList.add("rce"); el.contentEditable = "true"; el.setAttribute("role", "textbox");
    if (placeholder) el.dataset.ph = placeholder;
    return {
      el,
      focus: () => placeCaretEnd(el),
      insertText: (t) => rceInsertText(el, t),
      insertQuote: (a, t) => rceInsertQuote(el, a, t),
      clear: () => { el.innerHTML = ""; },
      isEmpty: () => serializeRce(el) === "",
      get value() { return serializeRce(el); },
    };
  }
  const EMOJI = {
    "Smileys": "😀 😁 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😜 🤪 🤔 🤨 😐 😴 😎 🥳 😏 😒 😞 😢 😭 😤 😡 🤬 🥺 😳 🤯 😬 🙄 😱 🤗 🤫 🤭 😷 🤒 🤠".split(" "),
    "Gestures": "👍 👎 👊 ✊ 🤝 👏 🙌 🙏 🤙 💪 👀 🫡 🤟 ✌️ 🤘 👌 🤞 👋 🖖 💁 🤷 🤦".split(" "),
    "Hearts": "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💯 🔥 ✨ ⭐ 🌟 💫 ⚡".split(" "),
    "Party": "🎉 🎊 🥂 🍻 🍺 🎸 🥁 🎹 🎺 🎶 🎵 🎤 🕺 💃 🪩 🎧".split(" "),
    "Nature": "🌈 ☀️ 🌙 🌊 🌲 🍄 🌻 🐟 🐳 🦋 🐝 🐢 🐐 🦍 🐉 🌵".split(" "),
    "Misc": "💩 👻 💀 👽 🤖 🎃 🍕 🌭 🌮 🍩 ☕ 🚀 🛸 🏆 🎯 ✅ ❌ ❓ ❗ 💬".split(" "),
  };
  const Picker = (() => {
    let pop = null, active = null, gifBtn = null;
    function build() {
      if (pop) return;
      pop = document.createElement("div"); pop.className = "picker"; pop.hidden = true;
      const tabs = document.createElement("div"); tabs.className = "picker-tabs";
      tabs.innerHTML = '<button type="button" data-t="emoji" class="on">😀 Emoji</button><button type="button" data-t="gif">GIF</button>';
      const emoWrap = document.createElement("div"); emoWrap.className = "pk-emoji";
      Object.keys(EMOJI).forEach((cat) => {
        const h = document.createElement("div"); h.className = "pk-cat"; h.textContent = cat; emoWrap.appendChild(h);
        const grid = document.createElement("div"); grid.className = "pk-emoji-grid";
        EMOJI[cat].forEach((ch) => { const b = document.createElement("button"); b.type = "button"; b.className = "pk-emoji-btn"; b.textContent = ch; b.addEventListener("click", () => { if (active) active.insertText(ch); }); grid.appendChild(b); });
        emoWrap.appendChild(grid);
      });
      const gifWrap = document.createElement("div"); gifWrap.className = "pk-gif"; gifWrap.hidden = true;
      gifWrap.innerHTML =
        '<div class="pk-gif-search field"><span class="pre">⌕</span><input type="text" placeholder="Search Giphy…" spellcheck="false"></div>' +
        '<div class="pk-gif-paste field"><span class="pre">🔗</span><input type="text" placeholder="…or paste an image / GIF URL" spellcheck="false"></div>' +
        '<div class="pk-gif-grid"></div>';
      const body = document.createElement("div"); body.className = "picker-body";
      body.append(emoWrap, gifWrap);
      pop.append(tabs, body);
      document.body.appendChild(pop);
      tabs.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => tab(b.dataset.t)));
      const gi = gifWrap.querySelector(".pk-gif-search input"); let deb;
      gi.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(() => searchGif(gi.value.trim()), 350); });
      const pi = gifWrap.querySelector(".pk-gif-paste input");
      const doPaste = () => { const u = pi.value.trim(); if (/^https?:\/\/\S+$/i.test(u) && active) { active.insertText(u); pi.value = ""; hide(); } };
      pi.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doPaste(); } });
      document.addEventListener("click", (e) => { if (pop.hidden) return; if (e.target.closest(".picker") || e.target.closest(".ctool")) return; hide(); });
      window.addEventListener("resize", hide);
    }
    function tab(t) {
      pop.querySelectorAll(".picker-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
      pop.querySelector(".pk-emoji").hidden = t !== "emoji";
      pop.querySelector(".pk-gif").hidden = t !== "gif";
      if (t === "gif" && !pop.querySelector(".pk-gif-grid").childElementCount) searchGif("");
    }
    async function searchGif(q) {
      const grid = pop.querySelector(".pk-gif-grid");
      const key = (settings.giphyKey || "").trim();
      if (!key) { grid.innerHTML = '<div class="pk-note">GIF search needs a free <b>Giphy API key</b> (add it in <b>Settings → Images &amp; GIFs</b>). No key? Just paste a GIF URL above — it renders the same.</div>'; return; }
      grid.innerHTML = '<div class="pk-note">Loading…</div>';
      const url = q
        ? `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13&bundle=fixed_width_small`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(key)}&limit=24&rating=pg-13&bundle=fixed_width_small`;
      try {
        const r = await fetch(url);
        const j = await r.json().catch(() => ({}));
        if (!r.ok || (j.meta && j.meta.status >= 400)) {
          grid.innerHTML = `<div class="pk-note">Giphy error ${(j.meta && j.meta.status) || r.status}. Double-check your API key.</div>`; return;
        }
        const results = (j.data || []).filter((x) => x.images);
        if (!results.length) { grid.innerHTML = '<div class="pk-note">No GIFs found.</div>'; return; }
        grid.textContent = "";
        results.forEach((res) => {
          const im = res.images;
          const preview = (im.fixed_width_small || im.fixed_width_downsampled || im.preview_gif || {}).url;
          const full = (im.downsized_medium || im.original || im.downsized || {}).url;
          if (!preview || !full) return;
          const b = document.createElement("button"); b.type = "button"; b.className = "pk-gif-item";
          const img = document.createElement("img"); img.loading = "lazy"; img.src = preview; img.alt = res.title || "gif";
          b.appendChild(img);
          b.addEventListener("click", () => { if (active) active.insertText(full.split("?")[0]); hide(); });
          grid.appendChild(b);
        });
      } catch (_) { grid.innerHTML = '<div class="pk-note">Network error reaching Giphy.</div>'; }
    }
    function position(btn) {
      const r = btn.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
      const above = r.top - pop.offsetHeight - 6;
      pop.style.top = (above > 8 ? above : r.bottom + 6) + "px";
    }
    function hide() { if (pop) pop.hidden = true; gifBtn = null; }
    function toggle(target, startTab, btn) {
      build();
      if (!pop.hidden && gifBtn === btn) { hide(); return; }
      active = target; gifBtn = btn;
      pop.hidden = false; tab(startTab); position(btn);
    }
    return { toggle, hide };
  })();
  // target = a composer-target {el, focus, insertText} (textareaTarget or a rich composer)
  function attachComposerTools(target) {
    const anchor = target && target.el;
    if (!anchor || anchor.dataset.tooled) return;
    anchor.dataset.tooled = "1";
    const bar = document.createElement("div"); bar.className = "composer-tools";
    const emo = document.createElement("button"); emo.type = "button"; emo.className = "ctool"; emo.textContent = "😀"; emo.title = "Emoji";
    const gif = document.createElement("button"); gif.type = "button"; gif.className = "ctool ctool-gif"; gif.textContent = "GIF"; gif.title = "Insert a GIF";
    emo.addEventListener("click", () => Picker.toggle(target, "emoji", emo));
    gif.addEventListener("click", () => Picker.toggle(target, "gif", gif));
    bar.append(emo, gif);
    anchor.parentNode.insertBefore(bar, anchor);
  }
  const tvComposer = makeRichComposer($("#tvcBody"), "Write a reply…");
  attachComposerTools(tvComposer);
  attachComposerTools(textareaTarget($("#ntText")));

  function tvOpenComposer(quoteAuthor, quoteText) {
    const box = $("#tvCompose"); box.hidden = false;
    $("#tvcStatus").textContent = "";
    if (quoteAuthor != null) tvComposer.insertQuote(quoteAuthor, quoteText || "");
    tvComposer.focus();
    tvComposer.el.scrollIntoView({ block: "nearest" });
  }
  $("#tvReply").addEventListener("click", () => tvOpenComposer());
  $("#tvcCancel").addEventListener("click", () => { $("#tvCompose").hidden = true; });
  $("#tvcSend").addEventListener("click", async () => {
    const body = tvComposer.value.trim();
    if (!body || !tvT) return;
    const btn = $("#tvcSend"), st = $("#tvcStatus");
    btn.disabled = true; st.style.color = ""; st.textContent = "Posting…";
    try {
      const res = await postReply(tvT.id, body);
      if (res.ok) {
        st.textContent = "Posted ✓"; tvComposer.clear(); $("#tvCompose").hidden = true;
        tvT.postCount = (tvT.postCount || 0) + 1; tvTotalPages = Math.max(1, Math.ceil(tvT.postCount / 30));
        tvDir = "new"; $("#tvOrder").textContent = "Newest first ⇅"; tvStart(); // jump to newest to show it
      } else { st.textContent = postErrorText(res, st); st.style.color = "var(--danger)"; }
    } catch (_) { st.textContent = "Network error."; st.style.color = "var(--danger)"; }
    finally { btn.disabled = false; }
  });

  // reply to a thread straight from a Mention (opens Thread View + quotes them)
  async function openThreadFromMention(h) {
    let t = { id: h.threadId, subject: h.threadTitle, slug: "", postCount: 30 };
    try {
      const r = await fetch(`${PT_ORIGIN}/api/bands/1/threads/${h.threadId}`, { credentials: "omit", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" } });
      if (r.ok) { const m = await r.json(); t = { id: m.id, subject: m.subject, slug: m.slug || "", postCount: m.postCount || 30 }; }
    } catch (_) {}
    openThreadView(t);
    setTimeout(() => tvOpenComposer(h.author || "user", ownText(h.body || h.snippet || "")), 250);
  }

  // new thread
  $("#boardNew").addEventListener("click", () => { $("#ntSubject").value = ""; $("#ntText").value = ""; $("#ntStatus").textContent = ""; $("#newThread").hidden = false; $("#ntSubject").focus(); });
  $("#ntCancel").addEventListener("click", () => { $("#newThread").hidden = true; });
  $("#ntSend").addEventListener("click", async () => {
    const subject = $("#ntSubject").value.trim(), body = $("#ntText").value.trim();
    const st = $("#ntStatus");
    if (!subject) { st.textContent = "Add a subject."; st.style.color = "var(--danger)"; return; }
    if (!body) { st.textContent = "Add some text."; st.style.color = "var(--danger)"; return; }
    const btn = $("#ntSend"); btn.disabled = true; st.style.color = ""; st.textContent = "Posting…";
    try {
      const res = await postNewThread(subject, body);
      if (res.ok) { st.textContent = "Posted ✓"; setTimeout(() => { $("#newThread").hidden = true; loadBoard(); }, 500); }
      else { st.textContent = postErrorText(res, st); st.style.color = "var(--danger)"; }
    } catch (_) { st.textContent = "Network error."; st.style.color = "var(--danger)"; }
    finally { btn.disabled = false; }
  });

  function renderBoard() {
    document.querySelectorAll("#boardSort button").forEach((x) => x.classList.toggle("on", x.dataset.sort === boardSort));
    document.querySelectorAll("#boardHead [data-sort]").forEach((h) => h.classList.toggle("on", h.dataset.sort === boardSort));
    const box = $("#boardList"); box.textContent = "";
    updateBoardFocus();   // list rebuilt → nothing open; clear focus/dim state
    const mod = getMod();
    $("#boardGroups").style.display = (boardSort === "saved" || boardSort === "mine") ? "none" : "";
    $("#boardHead").style.display = boardViewMode === "table" ? "" : "none"; // header only in table view
    const empty = (msg) => { const e = document.createElement("div"); e.className = "feed-empty"; e.textContent = msg; box.appendChild(e); };

    // Saved (★) — from local storage, independent of the active fetch
    if (boardSort === "saved") {
      const items = boardSaved.filter(matchesQuery).filter((t) => !modBlocksTopic(mod, t)).slice().sort((a, b) => parseUTC(b.dateOfLastPost) - parseUTC(a.dateOfLastPost));
      $("#boardStatus").textContent = items.length + " saved thread" + (items.length === 1 ? "" : "s");
      if (!items.length) { empty("No saved threads yet — tap ☆ on any thread to keep it here."); return; }
      items.forEach((t) => box.appendChild(topicRow(t)));
      return;
    }

    // My Threads — the threads you follow on your PT account (needs your session)
    if (boardSort === "mine") {
      if (boardMineState === "idle") { loadMyThreads(); }
      if (boardMineState === "loading") { $("#boardStatus").textContent = "Loading your threads…"; empty("Loading the threads you follow…"); return; }
      if (boardMineState === "auth") { $("#boardStatus").textContent = "Not signed in"; empty("Open phantasytour.com and log in, then Refresh — this pulls the threads you follow on your account."); return; }
      if (boardMineState === "error") { $("#boardStatus").textContent = "Couldn’t load"; empty("Couldn’t load your threads. Make sure a phantasytour.com tab is open and you’re logged in, then Refresh."); return; }
      const items = boardMine.filter(matchesQuery).filter((t) => !modBlocksTopic(mod, t) && !boardHidden.has(String(t.id)))
        .sort((a, b) => parseUTC(b.dateOfLastPost) - parseUTC(a.dateOfLastPost));
      $("#boardStatus").textContent = items.length + " followed thread" + (items.length === 1 ? "" : "s");
      if (!items.length) { empty("No followed threads found on your account."); return; }
      items.forEach((t) => box.appendChild(topicRow(t)));
      return;
    }

    // Active / Busiest — moderation-blocked removed, pinned first, hidden removed
    const modCount = boardTopics.filter((t) => modBlocksTopic(mod, t)).length;
    let list = boardTopics.filter((t) => !modBlocksTopic(mod, t) && !boardHidden.has(String(t.id)) && matchesQuery(t));
    if (boardGroup !== "all") list = list.filter((t) => groupOf(t.subject) === boardGroup);
    list.sort((a, b) => boardSort === "busiest" ? (b.postCount - a.postCount) : (parseUTC(b.dateOfLastPost) - parseUTC(a.dateOfLastPost)));
    const items = [...list.filter((t) => boardPinned.has(String(t.id))), ...list.filter((t) => !boardPinned.has(String(t.id)))];

    const hiddenCount = boardTopics.filter((t) => !modBlocksTopic(mod, t) && boardHidden.has(String(t.id))).length;
    $("#boardStatus").textContent = items.length + " topics" +
      (hiddenCount ? " · " + hiddenCount + " hidden" : "") +
      (modCount ? " · " + modCount + " blocked" : "");
    if (!items.length && !hiddenCount) { empty("No topics."); return; }
    items.forEach((t) => box.appendChild(topicRow(t)));

    if (hiddenCount) {
      const toggle = document.createElement("button"); toggle.className = "board-hidden-toggle";
      toggle.textContent = (boardShowHidden ? "▲ Hide " : "▾ Show ") + hiddenCount + " hidden";
      toggle.addEventListener("click", () => { boardShowHidden = !boardShowHidden; renderBoard(); });
      box.appendChild(toggle);
      if (boardShowHidden) {
        boardTopics.filter((t) => boardHidden.has(String(t.id)))
          .sort((a, b) => parseUTC(b.dateOfLastPost) - parseUTC(a.dateOfLastPost))
          .forEach((t) => { const row = topicRow(t); row.classList.add("is-hidden"); box.appendChild(row); });
      }
    }
  }
  document.querySelectorAll("#boardHead [data-sort]").forEach((h) =>
    h.addEventListener("click", () => { boardSort = h.dataset.sort; renderBoard(); })
  );
  document.querySelectorAll("#boardSort button").forEach((b) =>
    b.addEventListener("click", () => { boardSort = b.dataset.sort; renderBoard(); })
  );
  $("#boardRefresh").addEventListener("click", () => { if (boardSort === "mine") loadMyThreads(); else loadBoard(); });
  const boardSearchInput = $("#boardSearch"), boardSearchClear = $("#boardSearchClear");
  boardSearchInput.addEventListener("input", () => { boardQuery = boardSearchInput.value.trim().toLowerCase(); boardSearchClear.hidden = !boardQuery; renderBoard(); });
  boardSearchClear.addEventListener("click", () => { boardSearchInput.value = ""; boardQuery = ""; boardSearchClear.hidden = true; renderBoard(); boardSearchInput.focus(); });
  function syncViewBtn() { const b = $("#boardView"); b.textContent = boardViewMode === "table" ? "☰" : "⊞"; b.title = boardViewMode === "table" ? "Switch to card view" : "Switch to table view"; }
  $("#boardView").addEventListener("click", () => { boardViewMode = boardViewMode === "table" ? "cards" : "table"; saveBoardState(); syncViewBtn(); renderBoard(); });
  loadBoardState(syncViewBtn);

  /* ============ search tab ============ */
  let sqType = "posts";
  const ymd = (d) => d.toISOString().slice(0, 10);
  $("#sqTo").value = ymd(new Date());
  $("#sqFrom").value = ymd(new Date(Date.now() - 30 * 86400000));
  document.querySelectorAll("#sqType button").forEach((b) =>
    b.addEventListener("click", () => { document.querySelectorAll("#sqType button").forEach((x) => x.classList.toggle("on", x === b)); sqType = b.dataset.type; })
  );
  $("#sqGo").addEventListener("click", doSearch);
  ["#sqKeyword", "#sqAuthor"].forEach((s) => $(s).addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); }));

  async function openThreadById(id) {
    let t = { id, subject: "Thread", slug: "", postCount: 30 };
    try {
      const r = await fetch(`${PT_ORIGIN}/api/bands/1/threads/${id}`, { credentials: "omit", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" } });
      if (r.ok) { const m = await r.json(); t = { id: m.id, subject: m.subject, slug: m.slug || "", postCount: m.postCount || 30 }; }
    } catch (_) {}
    openThreadView(t);
  }

  async function doSearch() {
    const kw = $("#sqKeyword").value.trim();
    const author = $("#sqAuthor").value.trim().toLowerCase().replace(/^@+/, "");
    const from = $("#sqFrom").value, to = $("#sqTo").value;
    const box = $("#sqResults"), st = $("#sqStatus");
    box.textContent = ""; st.textContent = "Searching…";
    const startDate = (from || "2005-01-01") + "T00:00:00Z";
    const endDate = (to || ymd(new Date())) + "T23:59:59Z";
    const endpoint = sqType === "threads" ? "/threads/search" : "/posts/search";
    try {
      const qs = new URLSearchParams({ searchTerm: kw, dateSearchType: "2", startDate, endDate, authorId: "", pageSize: "60" });
      const res = await fetch(`${PT_ORIGIN}/api/bands/1${endpoint}?${qs}`, { credentials: "omit", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" } });
      let items = res.ok ? await res.json() : [];
      if (!Array.isArray(items)) items = [];
      if (author) items = items.filter((it) => String(it.authorUsername || "").toLowerCase().includes(author));
      const mod = getMod();
      const before = items.length;
      items = items.filter((it) => (sqType === "threads" ? !modBlocksTopic(mod, it) : !modBlocksPost(mod, it)));
      const blocked = before - items.length;
      st.textContent = items.length + " result" + (items.length === 1 ? "" : "s") +
        (blocked ? " · " + blocked + " blocked" : "") + (before >= 60 ? " (first 60 — narrow the dates)" : "");
      if (!items.length) { const e = document.createElement("div"); e.className = "feed-empty"; e.textContent = "No results in that range."; box.appendChild(e); return; }
      items.forEach((it) => box.appendChild(sqType === "threads" ? searchThreadRow(it) : searchPostCard(it)));
    } catch (_) { st.textContent = "Search failed."; }
  }
  function searchPostCard(p) {
    const el = document.createElement("div"); el.className = "sr-card";
    const top = document.createElement("div"); top.className = "sr-top";
    const a = document.createElement("span"); a.className = "sr-author"; a.textContent = p.authorUsername || "?";
    bindHandle(a, p.authorId, p.authorUsername);
    const w = document.createElement("span"); w.className = "sr-when"; w.textContent = agoCoarse(parseUTC(p.dateCreated));
    top.append(a, w);
    const thr = document.createElement("div"); thr.className = "sr-thread"; thr.textContent = "in " + (p.topicSubject || "");
    const sn = document.createElement("div"); sn.className = "sr-snippet";
    // handle nested quotes: show the poster's own words; note who they replied to
    const own = ownText(p.body || ""), oq = outerQuote(p.body || "");
    if (own) {
      if (oq) { const re = document.createElement("span"); re.className = "sr-requote"; re.textContent = "re: " + oq.author + " — "; sn.appendChild(re); }
      sn.appendChild(document.createTextNode(own));
    } else if (oq) {
      sn.classList.add("sr-quoted"); sn.textContent = "❝ " + oq.author + ": " + oq.text;
    } else {
      sn.textContent = cleanText(p.body || "");
    }
    el.append(top, thr, sn);
    el.addEventListener("click", () => openThreadById(p.topicId));
    return el;
  }
  function searchThreadRow(t) {
    const el = document.createElement("div"); el.className = "sr-card";
    const top = document.createElement("div"); top.className = "sr-top";
    const a = document.createElement("span"); a.className = "sr-author"; a.style.color = "var(--text)"; a.style.fontWeight = "600"; a.textContent = t.subject || "(untitled)";
    const w = document.createElement("span"); w.className = "sr-when"; w.textContent = agoCoarse(parseUTC(t.dateOfLastPost));
    top.append(a, w);
    const meta = document.createElement("div"); meta.className = "sr-thread"; meta.textContent = (t.authorUsername || "?") + " · " + t.postCount + " posts";
    el.append(top, meta);
    el.addEventListener("click", () => openThreadView({ id: t.id, subject: t.subject, slug: t.slug || "", postCount: t.postCount || 30 }));
    return el;
  }

  /* ============ profile / user research ============ */
  function bindHandle(el, authorId, username) {
    if (!authorId || !el) return;
    el.classList.add("clickable-handle");
    el.title = "View @" + (username || "user") + "’s activity";
    el.addEventListener("click", (e) => { e.stopPropagation(); openProfile(authorId, username); });
  }
  let pvTab = "posts";
  function setPvTab(t) {
    pvTab = t;
    document.querySelectorAll("#pvTabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    $("#pvPosts").hidden = t !== "posts";
    $("#pvThreads").hidden = t !== "threads";
  }
  document.querySelectorAll("#pvTabs button").forEach((b) => b.addEventListener("click", () => setPvTab(b.dataset.tab)));

  async function openProfile(authorId, username) {
    if (!authorId) return;
    $("#pvTitle").textContent = "@" + (username || "user");
    $("#pvOpen").onclick = () => chrome.tabs.create({ url: `${PT_ORIGIN}/users/${authorId}/${username || ""}` });
    $("#pvStats").innerHTML = ""; $("#pvChart").innerHTML = ""; $("#pvTChart").innerHTML = "";
    $("#pvChartMax").textContent = "0"; $("#pvTMax").textContent = "0"; $("#pvChartAvg").textContent = "";
    $("#pvPosts").innerHTML = '<div class="texp-msg">Loading…</div>'; $("#pvThreads").innerHTML = "";
    setPvTab("posts");
    $("#profileView").hidden = false;
    const now = new Date();
    const iso = (d) => d.toISOString();
    const get = (path, startDate) => fetch(`${PT_ORIGIN}/api/bands/1${path}?searchTerm=&authorId=${authorId}&dateSearchType=2&startDate=${iso(startDate)}&endDate=${iso(now)}&pageSize=60`,
      { credentials: "omit", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" } }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    try {
      const [threads, posts] = await Promise.all([
        get("/threads/search", new Date(now.getTime() - 365 * 86400000)),
        get("/posts/search", new Date(now.getTime() - 90 * 86400000)),
      ]);
      renderProfile(Array.isArray(threads) ? threads : [], Array.isArray(posts) ? posts : []);
    } catch (_) { $("#pvPosts").innerHTML = '<div class="texp-msg">Couldn’t load profile.</div>'; return; }
    // "on PT since" — best-effort binary-probe of earliest activity (async, fills in)
    memberSinceYear(authorId).then((y) => { const el = $("#pvSince"); if (el) el.textContent = y ? String(y) : "—"; });
  }
  const pvStat = (v, l) => `<div class="pv-stat"><div class="pv-stat-v">${v}</div><div class="pv-stat-l">${l}</div></div>`;
  const pvEmpty = (t) => '<div class="pv-empty mute2">' + t + "</div>";
  function bucketDays(posts, days) {
    const now = Date.now(), b = new Array(days).fill(0);
    posts.forEach((p) => { const da = Math.floor((now - parseUTC(p.dateCreated)) / 86400000); if (da >= 0 && da < days) b[days - 1 - da]++; });
    return b;
  }
  function bucketMonths(items, months) {
    const b = new Array(months).fill(0), now = new Date(), nowKey = now.getFullYear() * 12 + now.getMonth();
    items.forEach((it) => { const ms = parseUTC(it.dateOfLastPost || it.dateCreated); if (isNaN(ms)) return; const d = new Date(ms); const idx = months - 1 - (nowKey - (d.getFullYear() * 12 + d.getMonth())); if (idx >= 0 && idx < months) b[idx]++; });
    return b;
  }
  function drawBars(chart, buckets, maxEl, unit) {
    chart.textContent = "";
    const max = Math.max(1, ...buckets);
    if (maxEl) maxEl.textContent = String(max);
    buckets.forEach((c) => { const bar = document.createElement("div"); bar.className = "pv-bar"; bar.style.height = Math.max(2, Math.round((c / max) * 100)) + "%"; bar.title = c + " " + unit + (c === 1 ? "" : "s"); chart.appendChild(bar); });
  }
  function renderProfile(threads, posts) {
    posts.sort((a, b) => parseUTC(b.dateCreated) - parseUTC(a.dateCreated));
    threads.sort((a, b) => parseUTC(b.dateOfLastPost) - parseUTC(a.dateOfLastPost));
    const cap = (n) => (n >= 60 ? "60+" : String(n));
    const lastActive = posts.length ? agoCoarse(parseUTC(posts[0].dateCreated)) : (threads.length ? agoCoarse(parseUTC(threads[0].dateOfLastPost)) : "—");
    $("#pvStats").innerHTML =
      pvStat(cap(posts.length), "recent posts") +
      pvStat(cap(threads.length), "threads") +
      pvStat(lastActive, "last post") +
      pvStat('<span id="pvSince">…</span>', "on PT since");
    // charts
    drawBars($("#pvChart"), bucketDays(posts, 14), $("#pvChartMax"), "post");
    const last14 = posts.filter((p) => parseUTC(p.dateCreated) >= Date.now() - 14 * 86400000).length;
    const avg = last14 / 14;
    $("#pvChartAvg").textContent = last14 ? "avg " + (avg >= 1 ? avg.toFixed(1) : avg.toFixed(2)) + " posts/day" : "";
    drawBars($("#pvTChart"), bucketMonths(threads, 12), $("#pvTMax"), "thread");
    // lists — reuse the search-result cards so they match the rest of the UI
    const pb = $("#pvPosts"); pb.textContent = "";
    if (!posts.length) pb.innerHTML = pvEmpty("No recent posts.");
    else posts.forEach((p) => pb.appendChild(searchPostCard(p)));
    const tb = $("#pvThreads"); tb.textContent = "";
    if (!threads.length) tb.innerHTML = pvEmpty("No threads found in the last year.");
    else threads.forEach((t) => tb.appendChild(searchThreadRow(t)));
  }
  async function memberSinceYear(authorId) {
    const has = (endYear) => fetch(`${PT_ORIGIN}/api/bands/1/posts/search?searchTerm=&authorId=${authorId}&dateSearchType=2&startDate=2000-01-01T00:00:00Z&endDate=${endYear}-01-01T00:00:00Z&pageSize=1`,
      { credentials: "omit", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" } }).then((r) => (r.ok ? r.json() : [])).then((a) => Array.isArray(a) && a.length > 0).catch(() => false);
    try {
      const nextYear = new Date().getFullYear() + 1;
      if (!(await has(nextYear))) return null;         // no posts at all in range
      let lo = 2001, hi = nextYear;                    // smallest year Y with any post before Y
      while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (await has(mid)) hi = mid; else lo = mid + 1; }
      return lo - 1;                                    // first activity ≈ the year before that boundary
    } catch (_) { return null; }
  }
  $("#pvBack").addEventListener("click", () => { $("#profileView").hidden = true; });

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

  // Theme controls the EXTENSION panel only — it never touches the forum.
  //   original → PT green/gold   ·   dark → default dark   ·   light → light
  const THEME_ATTR = { original: "pt", light: "light", dark: "" };
  function applyTheme() {
    const v = THEME_ATTR[settings.skin] != null ? THEME_ATTR[settings.skin] : "pt";
    if (v) document.documentElement.setAttribute("data-theme", v);
    else document.documentElement.removeAttribute("data-theme");
  }
  function renderSkin() { document.querySelectorAll("#skinSeg button").forEach((b) => b.classList.toggle("on", b.dataset.skin === (settings.skin || "original"))); }
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
    $("#embed-images").checked = settings.embedImages === true;
    $("#giphyKey").value = settings.giphyKey || "";
    renderChips("handles"); renderChips("keywords"); renderChips("watchKeywords");
    renderSkin(); applyTheme();
  }
  const setMon = (k, v) => { settings.monitor = { ...settings.monitor, [k]: v }; saveSettings(); };

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
  $("#embed-images").addEventListener("change", (e) => { settings.embedImages = e.target.checked; saveSettings(); });
  $("#giphyForm").addEventListener("submit", (e) => e.preventDefault());
  const saveGiphy = () => { const v = $("#giphyKey").value.trim(); if (v !== settings.giphyKey) { settings.giphyKey = v; saveSettings(); } };
  $("#giphyKey").addEventListener("blur", saveGiphy);
  $("#giphyKey").addEventListener("change", saveGiphy);
  $("#giphyLink").addEventListener("click", (e) => { e.preventDefault(); chrome.tabs.create({ url: "https://developers.giphy.com/dashboard/" }); });
  document.querySelectorAll("#skinSeg button").forEach((b) => b.addEventListener("click", () => { settings.skin = b.dataset.skin; saveSettings(); renderSkin(); applyTheme(); }));

  /* ============ live ============ */
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && c[INBOX]) { inbox = c[INBOX].newValue || []; render(); }
    if (area === "sync" && c[SETTINGS]) {
      const prev = settings;
      settings = normalize(c[SETTINGS].newValue);
      applyTheme();
      // moderation blocklist changed → refresh the views that hide by it
      const modChanged = prev.enabled !== settings.enabled ||
        JSON.stringify(prev.handles) !== JSON.stringify(settings.handles) ||
        JSON.stringify(prev.keywords) !== JSON.stringify(settings.keywords);
      if (modChanged) { render(); if (boardLoaded) renderBoard(); }
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
    loadBoardState(); // saved / pinned / hidden threads (ready before Board opens)
    // Pick up new mentions the moment the panel opens (not just on the timer).
    if (settings.myHandle || (settings.watchKeywords || []).length) {
      checkBtn.classList.add("spin");
      status.textContent = "Checking…";
      chrome.runtime.sendMessage({ type: "ptg:pollNow" }, () => {
        void chrome.runtime.lastError;
        checkBtn.classList.remove("spin");
      });
    }
  });

  function normalize(s) {
    s = s || {};
    ["handles", "keywords", "watchKeywords"].forEach((k) => { s[k] = Array.isArray(s[k]) ? s[k] : []; });
    s.monitor = { ...MON_DEFAULTS, ...(s.monitor || {}) };
    s.skin = s.skin || "original";
    s.enabled = s.enabled !== false;
    s.embedImages = s.embedImages === true;            // on-site image rendering, opt-in (default off)
    s.giphyKey = typeof s.giphyKey === "string" ? s.giphyKey : "";
    s.myHandle = typeof s.myHandle === "string" ? s.myHandle : "";
    return s;
  }
})();
