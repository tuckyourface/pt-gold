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

function notify(fresh) {
  const mentions = fresh.filter((h) => h.reason === "mention").length;
  const keywords = fresh.filter((h) => h.reason === "keyword").length;
  const parts = [];
  if (mentions) parts.push(mentions + " mention" + (mentions === 1 ? "" : "s"));
  if (keywords) parts.push(keywords + " keyword hit" + (keywords === 1 ? "" : "s"));
  const title = "PT Gold — " + parts.join(" · ");
  const first = fresh[0];
  const body = (first.author ? first.author + ": " : "") + (first.snippet || first.threadTitle || "");
  const nid = "ptg-" + first.key;
  chrome.notifications.create(nid, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message: body.slice(0, 180),
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
  const t = v ? Date.parse(v) : NaN;
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
    if (isPost && postId) url += "#ptgpost=" + postId; // deep-link to the exact post
    const id = (threadId || "t") + "-" + (postId || "thread");

    out.push({
      key: id + ":" + t.reason + ":" + (t.keyword || ""),
      id,
      kind: isPost ? "post" : "thread",
      reason: t.reason,
      quoteType: t.reason === "mention" ? quoteTypeOf(bodyRaw, t.term) : null,
      keyword: t.keyword || null,
      author,
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

/* ---------- messages ---------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === "ptg:newHits") {
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
