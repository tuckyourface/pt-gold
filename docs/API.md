# Phantasy Tour forum API — reference

Undocumented JSON API the Phish forum SPA uses. Band id `1` = Phish; the forum
topic tag is `2`. All read endpoints below work **anonymously** (no login).
Requests from the extension use `credentials: 'include'` so the browser's own
session cookie rides along automatically when logged in (needed only for
posting) — the extension never stores or handles the cookie.

**Timestamps are UTC but returned WITHOUT a `Z` suffix** (e.g.
`2026-07-01T04:14:16.856`). Parse as UTC (append `Z`). Post bodies are **BBCode**
(`[quote=author]…[/quote]`, nestable; `[b]`, `[url]`, etc.).

## Read endpoints

### Search (mentions)
`GET /api/bands/1/posts/search` and `GET /api/bands/1/threads/search`
Query: `searchTerm`, `dateSearchType=2`, `startDate=<ISO>`, `endDate=<ISO>`,
`authorId=` (blank). Returns a **root JSON array**.
- posts item: `id, topicId, topicSlug, topicSubject, body, authorId,
  authorUsername, authorUrl, dateCreated, isIgnored, isOverlapPost`
- threads item: `id, subject, slug, authorId, authorUsername, isSticky,
  isClosed, dateOfLastPost, postCount`

### Board topics
`GET /api/tags/2/topics?page=1&pageSize=60&activeOnly=true`
Root array of: `id, subject, slug, authorId, authorUsername, isSticky, isClosed,
dateOfLastPost, postCount`. Paginate with `page`; active list shifts between
pages so **dedupe by `id`** when appending.

### Thread posts (reader) — 30/page
`GET /api/bands/1/threads/{threadId}/posts?page=1&pageSize=30`
Root array, oldest→newest (page 1 starts with the OP): `id, body, topicId,
dateCreated, isIgnored, isOverlapPost, authorId, authorUsername, authorUrl`.
Total pages = `ceil(thread.postCount / 30)`.

### Thread / band meta
`GET /api/bands/1/threads/{threadId}` → `{ id, subject, slug?, communityId,
dateOfLastPost, postCount, authorId, author, url, webUrl, isSticky, isClosed }`
`GET /api/bands/1` → band object (has `id, name, forumTagId, colorN, …`).

### Thread web URL
`https://www.phantasytour.com/bands/phish/threads/{threadId}/{slug}`

## Posting — TODO (needs capture)
Reply endpoint is **`POST /api/bands/1/threads/{threadId}/posts`** (same path as
the GET; initiated by jQuery). Still needed to wire it:
- Confirm method = `POST` and the **request payload** (JSON body — likely
  `{ body: "<bbcode>", ... }`; quote-reply may embed `[quote=author]…[/quote]`
  or reference a parent post id).
- The **new-thread** endpoint + payload (likely `POST /api/bands/1/threads` or
  under `/api/tags/2/topics`).
- Response shape (new post/thread object) to update the UI in place.

Capture via DevTools → Network with **Preserve log** enabled (the page redirects
to the forum home after posting, which otherwise clears the log). Posting only
needs the active browser session; `credentials: 'include'` handles auth.
