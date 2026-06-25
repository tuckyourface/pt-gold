# PT Gold 👑

A customizable moderator for the **Phish forum on Phantasy Tour**
(`https://www.phantasytour.com/bands/phish/` and every child page).

Hide threads, posts, and **posts containing quoted nests** that match user
handles or keywords you define. Preferences persist across browser sessions
via `chrome.storage.sync`.

## What it hides

| Surface | Hidden when… |
|---|---|
| **Thread list** (forum home) | thread starter is a blocked handle, **or** the title contains a blocked keyword |
| **Posts** (thread pages) | the author is a blocked handle, **or** the post *quotes* a blocked handle, **or** the post text (including quoted text) contains a blocked keyword |

Hiding uses `display: none`. The site renders its lists client-side with
Knockout.js, so the content script uses a `MutationObserver` (plus a few timed
passes) to re-apply after every async render and pagination change.

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** and select this folder (`pt-gold/`)
4. Visit the Phish forum — the toolbar badge shows how many items are concealed
5. Click the **PT Gold** crown icon to manage handles & keywords

## Usage

- **Blocked Handles** — type a username (the `@` is optional). Hides their
  posts/threads *and* any post that quotes them.
- **Blocked Keywords** — type a word or phrase. Case-insensitive substring
  match against thread titles and post bodies.
- **Master switch** — turn all moderation on/off without losing your lists.
- Remove an entry with the `×` on its chip. Everything saves instantly and
  syncs across your signed-in Chrome sessions.

## Files

- `manifest.json` — MV3 config (scoped to the Phish band path)
- `content.js` / `content.css` — moderation engine + the hide rule
- `popup.html` / `popup.css` / `popup.js` — the gold dial UI
- `background.js` — toolbar badge counter
- `make_icons.py` — regenerates the crown icons (dev only; not loaded)
