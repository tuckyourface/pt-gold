# PT Gold — project guide (for contributors / AI sessions)

A Manifest V3 Chrome extension: a **side-panel companion for the Phish forum on
Phantasy Tour** (`https://www.phantasytour.com/bands/phish/`). It adds forum-wide
mention tracking, a topic board with an in-panel thread reader, on-page
moderation, and dark/light skins. Everything runs locally; it uses the forum's
own public JSON APIs.

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
- Bump `manifest.json` `version` per release. Current: **1.1.4**.

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
- `skin.js/.css` — sets `data-ptg-skin` on `<html>`; `skin.css` restyles the
  Bootstrap-based forum (dark/light).
- `harvest.js` — small helper: honors `#ptgpost=<id>` deep-links ("Open to this
  post") by scrolling to a post, walking pagination if needed.
- `discover.js` (MAIN world) — learns API endpoint shapes by wrapping fetch/XHR;
  relays them to the worker. (Endpoints are now known/hardcoded; this is
  optional and could be removed to shrink surface.)

## Storage keys
- `chrome.storage.sync` → `ptgold_settings`: `{ enabled, handles[], keywords[],
  myHandle, watchKeywords[], monitor:{notify,badge,pollMinutes,lookbackDays,
  notifyDirect,notifyNested,notifyMention,notifyKeywords}, skin }`.
- `chrome.storage.local` → `ptg_inbox` (mention hits), `ptg_saved` / `ptg_pinned`
  / `ptg_hidden` / `ptg_boardview` (board), `ptg_endpoints` (discovery).

## Forum API — see `docs/API.md` for full detail
Public (work anonymously): search (`/api/bands/1/{posts,threads}/search`), board
topics (`/api/tags/2/topics`), thread posts (`/api/bands/1/threads/{id}/posts`,
30/page), thread/band meta. Posting requires the browser session (automatic via
`credentials:'include'`) — see the "Posting" TODO in `docs/API.md`.

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
- **Done (1.1.4):** mentions monitor, board (table + card views, save/pin/hide,
  group + keyword filter, load >60), lazy thread reader + dedicated thread view
  (order toggle, in-thread search), skins, moderation. Removed the old on-thread
  "Snapshot" DOM injection.
- **Next: native posting** (reply, quote-reply, new thread) from the panel. The
  reply endpoint is `POST /api/bands/1/threads/{threadId}/posts`; still need the
  request **payload** shape and the new-thread endpoint (capture via DevTools →
  Network with **Preserve log** on, since the page redirects after posting).
  Posting works with `credentials:'include'` when logged in.
