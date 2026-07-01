# PT Gold — project guide (for contributors / AI sessions)

A Manifest V3 Chrome extension: a **side-panel companion for the Phish forum on
Phantasy Tour** (`https://www.phantasytour.com/bands/phish/`). It adds forum-wide
mention tracking, a topic board with an in-panel thread reader, on-page
moderation, and a themeable panel (Original PT green/gold · Dark · Light).
Everything runs locally; it uses the forum's own public JSON APIs. **The
extension never restyles the forum itself** — the theme setting applies only to
the PT Gold panel.

## Repo & commit workflow (IMPORTANT)
- Published as a public GitHub repo; push with `git push origin main`.
- **Commits are anonymous by design.** The repo's local git identity is
  `PT Gold <ptgold@users.noreply.github.com>` — never change it, never commit
  under a personal name/email.
- Use a **fixed UTC commit date** to avoid leaking work times/timezone, e.g.
  `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` = `YYYY-07-01T12:00:00Z`.
- **Before every push, run a privacy scan** and confirm it's empty:
  `grep -rinE 'AuthToken|eyJhbGci|/Users/|gmail|<any real name/handle>' --include='*.*' . | grep -v .git/`
  The repo must contain **no personal identity, no session tokens/cookies, no
  local paths**. Screenshots and docs included.
- Bump `manifest.json` `version` per release. Current: **1.2.0**.

## Build / validate
- No build step. Load unpacked at `chrome://extensions` (Developer mode). The
  toolbar icon opens the **side panel** (no popup).
- Validate before committing: `for f in *.js; do node --check "$f"; done` and
  `python3 -c "import json;json.load(open('manifest.json'))"`.

## Architecture
Side-panel app (the main UI):
- `dashboard.html/.css/.js` — the app. Tabs: **Mentions · Board · Moderate ·
  Settings**, plus a full-panel **Thread View** overlay (`#threadView`).
- `theme.css` — shared design tokens (dark default; `:root[data-theme="light"]`
  for the light skin, driven by the Site-appearance setting).
- `background.js` — MV3 service worker: `chrome.alarms` poller that queries the
  forum search API for the user's handle + watch-keywords, stores hits, fires
  notifications, and maintains the unread badge. Polls on install/startup and on
  panel open (`ptg:pollNow`).

Content scripts (injected on `…/bands/phish/*`):
- `content.js/.css` — Moderate feature: hides threads/posts/quoted-nests that
  match blocked handles/keywords (Knockout re-renders → MutationObserver).
  (There is intentionally **no** site-skinning content script — themes are
  panel-only, driven by `<html data-theme="pt|light">` in the dashboard via
  `theme.css`. `pt` = Original (white bg, green/gold/black); default/no-attr = Dark.)
- `imagify.js` — **opt-in** (Settings → "Embed images on the forum", default OFF):
  rewrites bare direct-image URLs inside `.post_body_container` into inline
  `<img>` as you browse the live forum. Only PT Gold users see them; does nothing
  while disabled. Styles in `content.css` (`.ptg-embed-img`).
- `compose.js` — injects a 😀 / GIF toolbar + picker onto the forum's own post
  `<textarea>` (heuristic match; skips search fields). Emoji/paste insert at the
  cursor and dispatch `input`/`change` so Knockout observables update; Giphy
  search is proxied through the worker (`ptg:giphy`) to avoid content-script CORS.
- `harvest.js` — small helper: honors `#ptgpost=<id>` deep-links ("Open to this
  post") by scrolling to a post, walking pagination if needed.
- `discover.js` (MAIN world) — learns API endpoint shapes by wrapping fetch/XHR;
  relays them to the worker. (Endpoints are now known/hardcoded; this is
  optional and could be removed to shrink surface.)

## Storage keys
- `chrome.storage.sync` → `ptgold_settings`: `{ enabled, handles[], keywords[],
  myHandle, watchKeywords[], monitor:{notify,badge,pollMinutes,lookbackDays,
  notifyDirect,notifyNested,notifyMention,notifyKeywords}, skin, embedImages,
  giphyKey }`. `skin` now drives the **panel theme only** (`original`→`pt`
  green/gold · `dark` · `light`); `embedImages` toggles `imagify.js`; `giphyKey`
  is the user's own free Giphy key for the composer GIF search (Tenor stopped
  issuing keys Jan 2026; the composer also has a keyless paste-a-GIF-URL box).
- `chrome.storage.local` → `ptg_inbox` (mention hits), `ptg_saved` / `ptg_pinned`
  / `ptg_hidden` / `ptg_boardview` (board), `ptg_endpoints` (discovery).

## Forum API — see `docs/API.md` for full detail
Public (work anonymously): search (`/api/bands/1/{posts,threads}/search`), board
topics (`/api/tags/2/topics`), thread posts (`/api/bands/1/threads/{id}/posts`,
30/page), thread/band meta.

**Authenticated (needs the user's session):** posting, and the "My Threads" board
tab (`GET /api/tags/2/my-topics?page=1&pageSize=40&activeOnly=true` — same item
shape as `/topics`; unauth returns `{Message:"Authorization has been denied…"}`).
Extension-origin requests can be rejected, so these are routed through a forum
tab via the service worker: `postViaTab` (`ptg:post`) and `getViaTab` (`ptg:get`)
use `chrome.scripting.executeScript` in the MAIN world to run a same-origin
`fetch(..., {credentials:'include'})` (posting also adds the anti-forgery token).

## Conventions & gotchas
- **Timestamps are UTC but sent WITHOUT a `Z`.** Always append `Z` before
  `Date.parse` (`parseUTC` in dashboard.js, `parseTs` in background.js). Parsing
  as local skews everything toward "just now".
- **`[hidden]` trap:** any element with `display:` set via a class overrides the
  `hidden` attribute. Every hideable overlay/view needs an explicit
  `.<class>[hidden]{ display:none !important }` rule (`.view`, `.tview`).
- **No XSS:** forum content is rendered by escaping all text (`esc`,
  `highlightInto`) and emitting only our own tags; post bodies use `textContent`
  or the BBCode renderer (`parseBB` → depth-colored quote elements). Never inject
  raw forum HTML.
- **Post bodies are BBCode:** `[quote=author]…[/quote]` (nestable), `[b]`, `[url]`.
- MV3 alarms can lag; that's why we also poll on panel open.

## Screenshots (docs/*.png)
- Rendered from the real `theme.css`/`dashboard.css` via headless Chrome against
  small preview HTML harnesses (see git history for the pattern).
- **RULE: placeholder / lorem-ipsum content ONLY** — no real handles, names, or
  post text in any screenshot.

## Current status & pending work
- **Done (1.2.0):** mentions monitor; board (table + card views, save/pin/hide,
  group + keyword filter, load >60); lazy thread reader + dedicated thread view
  (order toggle, in-thread search); moderation; **native posting** (reply,
  quote-reply, new thread) via the forum tab + anti-forgery token; **Search tab**;
  **Profile view** (click any handle → their threads, recent posts, posts/day
  chart); **panel themes** decoupled from the site (Original PT green/gold · Dark
  · Light); **image/GIF rendering** in the reader + opt-in on-site `imagify.js`;
  **emoji + Giphy GIF picker** (with keyless paste-a-URL fallback) on composer fields.
- **Done — reader rework:** expanding a board thread now enters a **focus mode**
  (single-open; `#boardList.has-open` dims/blurs the other rows, `#view-board.reading`
  drops the board's sticky header so only the thread's `.rd-bar` floats). Each
  expanded thread has a **pinned quick-reply** (`.rd-compose`, sticky bottom, with
  emoji/GIF tools) and **per-post ❝ Quote** buttons (`renderReaderPost(p,n,onQuote)`)
  that prefill the reply box. Thread View shares the same quote path.
- **Done — #2 rich composer:** reply boxes (Thread View `#tvcBody` + the inline
  pinned reply) are now `contenteditable` (`makeRichComposer`) that render quoted
  posts as formatted, editable `.rce-q` blocks and **serialize back to BBCode on
  send** (`serializeRce`). Emoji/GIF picker + all composers share one target
  interface (`{el, focus, insertText}`; `textareaTarget()` wraps the plain
  new-thread textarea). Quote buttons call `composer.insertQuote(author, text)`.
- **Posting note:** routed through a forum tab (MAIN world) so the POST is
  same-origin; the `RequestVerificationToken` header is read from
  `window.PT.antiforgeryToken` or scraped from page HTML. Confirmed working.
