/* =========================================================================
 * PT Gold — background service worker
 *
 *  • Receives harvested hits (from harvest.js) and discovered endpoints
 *    (from discover.js via harvest.js), stores them.
 *  • Maintains the Inbox (chrome.storage.local) + toolbar unread badge.
 *  • Fires desktop notifications for new mentions/keywords.
 *  • On a chrome.alarms timer, replays discovered endpoints with your cookies
 *    to find new hits even when no forum tab is open.
 * ========================================================================= */
"use strict";

const SETTINGS_KEY = "ptgold_settings";
const INBOX_KEY = "ptg_inbox";
const ENDPOINTS_KEY = "ptg_endpoints";
const INBOX_CAP = 500;
const ALARM = "ptg-poll";

/* ---------- tiny storage helpers ---------- */
const getLocal = (k, d) =>
  new Promise((r) => chrome.storage.local.get(k, (o) => r(o[k] === undefined ? d : o[k])));
const setLocal = (k, v) => new Promise((r) => chrome.storage.local.set({ [k]: v }, r));
const getSettings = () =>
  new Promise((r) => chrome.storage.sync.get(SETTINGS_KEY, (o) => r(o[SETTINGS_KEY] || {})));

/* ---------- badge ---------- */
async function refreshBadge() {
  const settings = await getSettings();
  const badgeOn = !settings.monitor || settings.monitor.badge !== false;
  const inbox = await getLocal(INBOX_KEY, []);
  const unread = inbox.filter((i) => !i.read).length;
  chrome.action.setBadgeBackgroundColor({ color: "#c9a86a" });
  chrome.action.setBadgeText({ text: badgeOn && unread > 0 ? String(unread) : "" });
}

/* ---------- ingest hits → inbox + notify ---------- */
async function ingest(hits) {
  if (!hits || !hits.length) return;
  const settings = await getSettings();
  const mon = settings.monitor || {};

  const inbox = await getLocal(INBOX_KEY, []);
  const have = new Set(inbox.map((i) => i.key));
  const fresh = hits.filter((h) => h && h.key && !have.has(h.key));
  if (!fresh.length) return;

  const merged = fresh.concat(inbox).slice(0, INBOX_CAP);
  await setLocal(INBOX_KEY, merged);
  await refreshBadge();

  if (mon.notify !== false) {
    // respect per-type notification toggles (direct / nested / @mention / keyword)
    const notifiable = fresh.filter((h) => {
      if (h.reason === "keyword") return mon.notifyKeywords !== false;
      if (h.quoteType === "direct") return mon.notifyDirect !== false;
      if (h.quoteType === "nested") return mon.notifyNested !== false;
      return mon.notifyMention !== false;
    });
    if (notifiable.length) notify(notifiable);
  }
}

// Strip whole [quote=…]…[/quote] blocks (incl. nested + their quoted text),
// leaving only the responder's own words — so the notification shows the
// actual reply, not the quoted nest.
function replyText(raw) {
  let s = String(raw || ""), prev;
  do {
    prev = s;
    s = s.replace(/\[quote[^\]]*\](?:(?!\[quote[^\]]*\]|\[\/quote\]).)*\[\/quote\]/gis, " ");
  } while (s !== prev);
  return s
    .replace(/\[\/?[a-z][^\]]*\]/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function notify(fresh) {
  const first = fresh[0];
  const author = first.author || "Someone";
  let verb = "mentioned you";
  if (first.reason === "keyword") verb = 'matched "' + (first.keyword || "keyword") + '"';
  else if (first.quoteType === "direct") verb = "quoted you";
  else if (first.quoteType === "nested") verb = "quoted you (nested)";
  else if (first.kind === "thread") verb = "named you in a thread title";

  let title = author + " " + verb;
  if (fresh.length > 1) title += "  +" + (fresh.length - 1) + " more";

  // body = the actual reply (quotes stripped); fall back to the thread title
  const reply = replyText(first.body);
  const message = reply || ("in “" + (first.threadTitle || "a thread") + "”");

  const nid = "ptg-" + first.key;
  chrome.notifications.create(nid, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: title.slice(0, 110),
    message: message.slice(0, 220),
    contextMessage: first.threadTitle ? "in “" + first.threadTitle + "”" : undefined,
    priority: 1,
  });
}

// clicking a notification opens the dashboard
chrome.notifications.onClicked.addListener((nid) => {
  if (nid && nid.indexOf("ptg-") === 0) {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    chrome.notifications.clear(nid);
  }
});

/* ---------- endpoint capture ---------- */
async function storeEndpoint(ep) {
  if (!ep || !ep.template) return;
  const eps = await getLocal(ENDPOINTS_KEY, {});
  const key = ep.method + " " + ep.template;
  // keep the first seen example of each template (with its shape + a sample search)
  if (!eps[key]) {
    eps[key] = { ...ep, seenAt: Date.now() };
    await setLocal(ENDPOINTS_KEY, eps);
  }
}

/* ---------- background polling (tab-free) ---------- */
// Forum-wide search poll: queries the forum's OWN search API for your handle
// and each watch-keyword, using the browser's existing cookies. No tab needed,
// and no token is stored here — credentials:'include' reuses your live session.
const ORIGIN = "https://www.phantasytour.com";
const SEARCH_BASE = ORIGIN + "/api/bands/1"; // band 1 = Phish (this extension's scope)
const LOOKBACK_DAYS = 60;

async function searchEndpoints() {
  // Query BOTH confirmed endpoints: posts (mentions in post bodies — the
  // important one) AND threads (mentions in thread titles). Posts first.
  const known = [SEARCH_BASE + "/posts/search", SEARCH_BASE + "/threads/search"];
  const eps = await getLocal(ENDPOINTS_KEY, {});
  const found = Object.values(eps)
    .filter((e) => e.method === "GET" && /search/i.test(e.template || ""))
    .map((e) => ORIGIN + String(e.path || "").replace(/\?.*$/, ""));
  return [...new Set([...known, ...found])];
}

async function poll() {
  const settings = await getSettings();
  const handle = (settings.myHandle || "").trim();
  const watch = (settings.watchKeywords || []).map((k) => (k || "").trim()).filter(Boolean);
  const terms = [];
  if (handle) terms.push({ term: handle, reason: "mention", keyword: null });
  watch.forEach((k) => terms.push({ term: k, reason: "keyword", keyword: k }));
  if (!terms.length) return;

  const lookback = (settings.monitor && settings.monitor.lookbackDays) || LOOKBACK_DAYS;
  const now = new Date();
  const start = new Date(now.getTime() - lookback * 86400000);
  const endpoints = await searchEndpoints();
  const hits = [];

  for (const t of terms) {
    for (const base of endpoints) {
      try {
        const qs = new URLSearchParams({
          searchTerm: t.term,
          dateSearchType: "2",
          startDate: start.toISOString(),
          endDate: now.toISOString(),
          authorId: "",
        });
        const res = await fetch(base + "?" + qs.toString(), {
          credentials: "include",
          headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" },
        });
        if (!res.ok) continue;
        const json = await res.json();
        parseSearch(json, t, hits); // accumulate from posts AND threads search
      } catch (_) {
        /* endpoint missing or network error → try next / degrade quietly */
      }
    }
  }
  await ingest(hits);
}

function pick(o, keys) {
  for (const k of keys) if (o && o[k] != null) return o[k];
  return null;
}

// Strip BBCode (the API returns [quote=name]…[/quote], [b], [url], etc.) + any HTML
function cleanBody(s) {
  return String(s || "")
    .replace(/\[\/?quote[^\]]*\]/gi, " ")
    .replace(/\[\/?[a-z][^\]]*\]/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function parseTs(v) {
  // Server timestamps are UTC but sent without a 'Z' — parse them as UTC.
  const t = v ? Date.parse(/([zZ]|[+-]\d\d:?\d\d)$/.test(v) ? v : v + "Z") : NaN;
  return isNaN(t) ? Date.now() : t;
}

// Was your handle quoted directly (top level) or nested deep inside the chain?
// Returns the shallowest depth of a [quote=you] (0 = direct), or -1 if none.
function meQuoteDepth(raw, me) {
  if (!me) return -1;
  me = me.toLowerCase();
  const re = /\[quote=([^\]]+)\]|\[quote\]|\[\/quote\]/gi;
  let depth = 0, m, best = -1;
  while ((m = re.exec(raw))) {
    if (m[0].toLowerCase().indexOf("[quote") === 0) {
      const a = (m[1] || "").trim().toLowerCase();
      if (a === me && (best < 0 || depth < best)) best = depth;
      depth++;
    } else if (depth > 0) depth--;
  }
  return best;
}
function quoteTypeOf(raw, me) {
  const d = meQuoteDepth(raw, me);
  return d === 0 ? "direct" : d > 0 ? "nested" : "mention";
}

// map a search result into an inbox hit. Two shapes:
//   /posts/search   item: { id(post), topicId, topicSlug, topicSubject, body, authorUsername, dateCreated }
//   /threads/search item: { id(thread), subject, slug, authorUsername, dateOfLastPost }
function parseSearch(json, t, out) {
  const list = Array.isArray(json)
    ? json
    : pick(json, ["posts", "threads", "results", "items", "data"]) || [];
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const author = String(pick(item, ["authorUsername", "author", "username"]) || "");
    if (t.reason === "mention" && author.toLowerCase() === t.term.toLowerCase()) continue; // skip your own posts

    const isPost = item.topicId != null || item.body != null;
    const threadId = String((isPost ? item.topicId : item.id) ?? "");
    const slug = String((isPost ? item.topicSlug : item.slug) || "");
    const subject = String(pick(item, ["topicSubject", "subject", "title"]) || "");
    const postId = isPost ? String(item.id ?? "") : "";
    const bodyRaw = String(pick(item, ["body", "formattedBody", "text", "preview"]) || "");
    const snippet = (cleanBody(bodyRaw) || subject).slice(0, 240);
    const ts = parseTs(pick(item, ["dateCreated", "dateOfLastPost", "date"]));

    let url = threadId
      ? ORIGIN + "/bands/phish/threads/" + threadId + (slug ? "/" + slug : "")
      : ORIGIN + "/bands/phish/";
    if (isPost && postId) {
      // deep-link to the exact post: id + a distinctive text fragment (the DOM
      // may not expose the post id, so the content script can match on text)
      const frag = (replyText(bodyRaw) || cleanBody(bodyRaw)).slice(0, 60).trim();
      url += "#ptgpost=" + postId + (frag ? "&ptgtext=" + encodeURIComponent(frag) : "");
    }
    const id = (threadId || "t") + "-" + (postId || "thread");

    out.push({
      key: id + ":" + t.reason + ":" + (t.keyword || ""),
      id,
      kind: isPost ? "post" : "thread",
      reason: t.reason,
      quoteType: t.reason === "mention" ? quoteTypeOf(bodyRaw, t.term) : null,
      keyword: t.keyword || null,
      author,
      authorId: pick(item, ["authorId"]) || null,
      threadId,
      threadTitle: subject,
      snippet,
      body: bodyRaw.slice(0, 6000), // full BBCode for rich expand
      url,
      ts,
      read: false,
      via: "search",
    });
    n++;
  }
  return n;
}

/* ---------- posting (runs inside a forum tab so it's same-origin) ---------- */
function waitForComplete(tabId) {
  return new Promise((resolve) => {
    const check = () => chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError || !t) return resolve();
      if (t.status === "complete") resolve(); else setTimeout(check, 200);
    });
    check();
  });
}
async function postViaTab(url, payload) {
  try {
    const tabs = await chrome.tabs.query({ url: "https://www.phantasytour.com/*" });
    let tab = tabs[0], created = false;
    if (!tab) {
      tab = await chrome.tabs.create({ url: "https://www.phantasytour.com/bands/phish/", active: false });
      created = true;
      await waitForComplete(tab.id);
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      args: [url, payload],
      func: async (u, p) => {
        try {
          // The forum sends the ASP.NET anti-forgery token (PT.antiforgeryToken)
          // in a RequestVerificationToken header. Read it from the global, or
          // scrape it from the inline page script if the global isn't populated.
          let token = (window.PT && window.PT.antiforgeryToken) || "";
          let src = token ? "win" : "";
          if (!token) {
            const html = document.documentElement ? document.documentElement.innerHTML : "";
            const m = html.match(/antiforgeryToken['"]?\s*[:=]\s*['"]([^'"]{10,})['"]/i);
            if (m) { token = m[1]; src = "scrape"; }
          }
          const headers = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
          if (token) headers["RequestVerificationToken"] = token;
          // redirect:"manual" → a logged-out POST that 302s to the login page comes
          // back as an opaque redirect (status 0) instead of silently "succeeding".
          const r = await fetch(u, { method: "POST", credentials: "include", headers, body: JSON.stringify(p), redirect: "manual" });
          if (r.type === "opaqueredirect" || (r.status === 0 && r.type !== "basic")) {
            return { ok: false, status: 401, text: "redirect-to-login", token: token ? src : "missing", auth: false };
          }
          let text = ""; try { text = (await r.text()).slice(0, 400); } catch (e) {}
          // a real post returns JSON; an HTML body (login/error page) means not signed in
          const looksHtml = /^\s*</.test(text) || /Authorization has been denied|log ?in|sign ?in/i.test(text);
          if (r.ok && looksHtml) return { ok: false, status: 401, text: "not-authenticated", token: token ? src : "missing", auth: false };
          return { ok: r.ok, status: r.status, text, token: token ? src : "missing", auth: r.status !== 401 && r.status !== 403 };
        } catch (e) { return { ok: false, status: 0, text: String(e) }; }
      },
    });
    if (created) { try { await chrome.tabs.remove(tab.id); } catch (e) {} }
    return (results && results[0] && results[0].result) || { ok: false, status: 0, text: "no result" };
  } catch (e) {
    return { ok: false, status: 0, text: String(e) };
  }
}

// Same-origin authenticated GET, routed through a forum tab so it carries the
// session cookies + correct Origin (extension-origin requests can be rejected).
// Used for the user's personalized lists (e.g. /api/tags/2/my-topics).
async function getViaTab(url) {
  try {
    const tabs = await chrome.tabs.query({ url: "https://www.phantasytour.com/*" });
    let tab = tabs[0], created = false;
    if (!tab) {
      tab = await chrome.tabs.create({ url: "https://www.phantasytour.com/bands/phish/", active: false });
      created = true;
      await waitForComplete(tab.id);
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      args: [url],
      func: async (u) => {
        try {
          const r = await fetch(u, { method: "GET", credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" } });
          let data = null; try { data = await r.json(); } catch (e) {}
          return { ok: r.ok, status: r.status, data };
        } catch (e) { return { ok: false, status: 0, data: null, error: String(e) }; }
      },
    });
    if (created) { try { await chrome.tabs.remove(tab.id); } catch (e) {} }
    return (results && results[0] && results[0].result) || { ok: false, status: 0, data: null };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e) };
  }
}

// Giphy search on behalf of a content script (which can't reach api.giphy.com
// cross-origin). Reads the user's key from settings. Returns { ok, items[] }.
async function giphySearch(q) {
  const s = await new Promise((r) => chrome.storage.sync.get("ptgold_settings", (o) => r(o.ptgold_settings || {})));
  const key = (s.giphyKey || "").trim();
  if (!key) return { ok: false, reason: "nokey" };
  const base = q
    ? `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}`
    : `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(key)}`;
  try {
    const r = await fetch(`${base}&limit=24&rating=pg-13&bundle=fixed_width_small`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j.meta && j.meta.status >= 400)) return { ok: false, reason: "error", status: (j.meta && j.meta.status) || r.status };
    const items = (j.data || []).map((g) => {
      const im = g.images || {};
      const preview = (im.fixed_width_small || im.fixed_width_downsampled || im.preview_gif || {}).url;
      const full = ((im.downsized_medium || im.original || im.downsized || {}).url || "").split("?")[0];
      return { preview, full, title: g.title || "" };
    }).filter((x) => x.preview && x.full);
    return { ok: true, items };
  } catch (e) { return { ok: false, reason: "network" }; }
}

/* ---------- messages ---------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === "ptg:post") {
    postViaTab(msg.url, msg.payload).then(sendResponse);
    return true; // async
  } else if (msg.type === "ptg:get") {
    getViaTab(msg.url).then(sendResponse);
    return true; // async
  } else if (msg.type === "ptg:giphy") {
    giphySearch(msg.q || "").then(sendResponse);
    return true; // async
  } else if (msg.type === "ptg:newHits") {
    ingest(msg.hits);
  } else if (msg.type === "ptg:endpoint") {
    storeEndpoint(msg.endpoint);
  } else if (msg.type === "ptg:refreshBadge") {
    refreshBadge();
  } else if (msg.type === "ptg:pollNow") {
    poll().then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  return false;
});

// recompute the badge whenever the inbox changes (e.g. side panel marks read)
chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && c[INBOX_KEY]) refreshBadge();
  if (area === "sync" && c[SETTINGS_KEY]) scheduleAlarm();
});

/* ---------- alarms ---------- */
async function scheduleAlarm() {
  const settings = await getSettings();
  const mins = Math.max(1, (settings.monitor && settings.monitor.pollMinutes) || 5);
  chrome.alarms.create(ALARM, { periodInMinutes: mins });
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) poll();
});

// Clicking the toolbar icon opens the side panel (no popup).
function enablePanelOnClick() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}
enablePanelOnClick();
chrome.runtime.onInstalled.addListener(() => { enablePanelOnClick(); scheduleAlarm(); refreshBadge(); poll(); });
chrome.runtime.onStartup.addListener(() => { enablePanelOnClick(); scheduleAlarm(); refreshBadge(); poll(); });
