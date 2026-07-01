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
  let boardSaved = [], boardPinned = new Set(), boardHidden = new Set(), boardShowHidden = false;
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
  const slimTopic = (t) => ({ id: t.id, subject: t.subject, slug: t.slug, authorUsername: t.authorUsername, postCount: t.postCount, dateOfLastPost: t.dateOfLastPost, isSticky: t.isSticky });
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

  let boardPage = 1, boardHasMore = false, boardBusy = false;
  async function loadBoard(reset = true) {
    boardLoaded = true;
    if (boardBusy) return;
    boardBusy = true;
    if (reset) { boardPage = 1; boardTopics = []; }
    $("#boardStatus").textContent = "Loading…";
    try {
      const res = await fetch(`https://www.phantasytour.com/api/tags/${TAG}/topics?page=${boardPage}&pageSize=60&activeOnly=true`,
        { credentials: "omit", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" } });
      const j = await res.json();
      const arr = Array.isArray(j) ? j : [];
      if (reset) boardTopics = arr;
      else {
        const have = new Set(boardTopics.map((x) => String(x.id))); // dedupe on load-more
        boardTopics = boardTopics.concat(arr.filter((x) => !have.has(String(x.id))));
      }
      boardHasMore = arr.length >= 60;
      renderGroups(); renderBoard();
    } catch (_) {
      $("#boardStatus").textContent = "Couldn’t load the board. Try Refresh.";
    } finally {
      boardBusy = false;
    }
  }
  function loadMoreThreads() { boardPage++; loadBoard(false); }
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
  function toggleTopic(wrap, t) {
    if (wrap.classList.contains("open")) { wrap.classList.remove("open"); return; } // collapse
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
      const spacer = document.createElement("span"); spacer.className = "grow";
      const coll = document.createElement("button"); coll.className = "rd-collapse btn btn-sm btn-ghost";
      coll.textContent = "▴ Collapse"; coll.title = "Collapse this thread";
      coll.addEventListener("click", () => wrap.classList.remove("open"));
      ctrls.append(tv, order, spacer, coll);
      bar.append(title, ctrls);

      const box = document.createElement("div"); box.className = "rd-posts";
      exp.append(bar, box);
      wrap.appendChild(exp);
      startReader(t, exp);
    }
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
        if (txt) { const d = document.createElement("div"); d.className = "rd-text"; highlightInto(d, txt, ctx.term); wrap.appendChild(d); }
      } else {
        wrap.appendChild(renderQuoteEl(ch, 0, me, ctx));
      }
    });
    if (!wrap.childNodes.length) { const d = document.createElement("div"); d.className = "rd-text mute2"; d.textContent = "(no text)"; wrap.appendChild(d); }
    return wrap;
  }

  function renderReaderPost(p, n) {
    const el = document.createElement("div"); el.className = "rd-post";
    const head = document.createElement("div"); head.className = "rd-head";
    head.innerHTML =
      `<span class="rd-num">#${n}</span>` +
      `<span class="rd-author">${esc(p.authorUsername || "?")}</span>` +
      `<span class="rd-time">${esc(fmtDateTime(p.dateCreated))}</span>`;
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
    exp.appendChild(foot);
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
      posts.forEach((p, i) => frag.appendChild(renderReaderPost(p, (page - 1) * 30 + i + 1)));
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
    $("#tvReply").onclick = () => chrome.tabs.create({ url }); // native in-panel reply lands once you send the POST endpoints
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
      posts.forEach((p, i) => { const el = renderReaderPost(p, (page - 1) * 30 + i + 1); el.dataset.text = el.textContent.toLowerCase(); frag.appendChild(el); });
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

  function renderBoard() {
    document.querySelectorAll("#boardSort button").forEach((x) => x.classList.toggle("on", x.dataset.sort === boardSort));
    document.querySelectorAll("#boardHead [data-sort]").forEach((h) => h.classList.toggle("on", h.dataset.sort === boardSort));
    const box = $("#boardList"); box.textContent = "";
    $("#boardGroups").style.display = boardSort === "saved" ? "none" : "";
    $("#boardHead").style.display = boardViewMode === "table" ? "" : "none"; // header only in table view
    const empty = (msg) => { const e = document.createElement("div"); e.className = "feed-empty"; e.textContent = msg; box.appendChild(e); };

    // Saved ("My Threads") — from local storage, independent of the active fetch
    if (boardSort === "saved") {
      const items = boardSaved.filter(matchesQuery).slice().sort((a, b) => parseUTC(b.dateOfLastPost) - parseUTC(a.dateOfLastPost));
      $("#boardStatus").textContent = items.length + " saved thread" + (items.length === 1 ? "" : "s");
      if (!items.length) { empty("No saved threads yet — tap ☆ on any thread to keep it here."); return; }
      items.forEach((t) => box.appendChild(topicRow(t)));
      return;
    }

    // Active / Busiest — pinned first, hidden removed
    let list = boardTopics.filter((t) => !boardHidden.has(String(t.id)) && matchesQuery(t));
    if (boardGroup !== "all") list = list.filter((t) => groupOf(t.subject) === boardGroup);
    list.sort((a, b) => boardSort === "busiest" ? (b.postCount - a.postCount) : (parseUTC(b.dateOfLastPost) - parseUTC(a.dateOfLastPost)));
    const items = [...list.filter((t) => boardPinned.has(String(t.id))), ...list.filter((t) => !boardPinned.has(String(t.id)))];

    const hiddenCount = boardTopics.filter((t) => boardHidden.has(String(t.id))).length;
    $("#boardStatus").textContent = items.length + " topics" + (hiddenCount ? " · " + hiddenCount + " hidden" : "");
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

    if (boardHasMore) {
      const more = document.createElement("button"); more.className = "board-hidden-toggle board-more";
      more.textContent = "Load more threads ↓";
      more.addEventListener("click", () => { more.textContent = "Loading…"; more.disabled = true; loadMoreThreads(); });
      box.appendChild(more);
    }
  }
  document.querySelectorAll("#boardHead [data-sort]").forEach((h) =>
    h.addEventListener("click", () => { boardSort = h.dataset.sort; renderBoard(); })
  );
  document.querySelectorAll("#boardSort button").forEach((b) =>
    b.addEventListener("click", () => { boardSort = b.dataset.sort; renderBoard(); })
  );
  $("#boardRefresh").addEventListener("click", () => loadBoard(true));
  const boardSearchInput = $("#boardSearch"), boardSearchClear = $("#boardSearchClear");
  boardSearchInput.addEventListener("input", () => { boardQuery = boardSearchInput.value.trim().toLowerCase(); boardSearchClear.hidden = !boardQuery; renderBoard(); });
  boardSearchClear.addEventListener("click", () => { boardSearchInput.value = ""; boardQuery = ""; boardSearchClear.hidden = true; renderBoard(); boardSearchInput.focus(); });
  function syncViewBtn() { const b = $("#boardView"); b.textContent = boardViewMode === "table" ? "☰" : "⊞"; b.title = boardViewMode === "table" ? "Switch to card view" : "Switch to table view"; }
  $("#boardView").addEventListener("click", () => { boardViewMode = boardViewMode === "table" ? "cards" : "table"; saveBoardState(); syncViewBtn(); renderBoard(); });
  loadBoardState(syncViewBtn);

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
  document.querySelectorAll("#skinSeg button").forEach((b) => b.addEventListener("click", () => { settings.skin = b.dataset.skin; saveSettings(); renderSkin(); applyTheme(); }));

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
    s.myHandle = typeof s.myHandle === "string" ? s.myHandle : "";
    return s;
  }
})();
