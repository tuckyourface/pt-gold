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

## Install

### Chrome / Brave / Edge (Chromium) — no build needed

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`)
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** and select this folder (`pt-gold/`)
4. Visit the Phish forum — the toolbar badge shows how many items are concealed
5. Click the **PT Gold** crown icon to manage handles & keywords

### Firefox

1. Add a `browser_specific_settings` block to `manifest.json` (Firefox needs an
   add-on ID for `storage.sync`):
   ```json
   "browser_specific_settings": { "gecko": { "id": "pt-gold@local", "strict_min_version": "121.0" } }
   ```
2. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on** and pick
   `manifest.json`. (Temporary add-ons are removed on restart; a permanent
   install requires signing the package through Mozilla AMO.)

### Safari (macOS) — requires Xcode

> ⚠️ **Heads-up for Apple users:** Safari cannot load an unpacked extension
> folder the way Chrome and Firefox can. Every Safari extension must be wrapped
> in a native macOS app and **built with Xcode**. **There is no way around
> this** — it is an Apple platform requirement, not a limitation of PT Gold.
> The conversion tool (`safari-web-extension-converter`) ships *inside* Xcode,
> so the full **Xcode** app must be installed (the Command Line Tools alone are
> not enough). If you don't want to install Xcode, just use Chrome, Brave, or
> Firefox instead — they need no build step.

If you do have Xcode:

1. Run Apple's converter against this folder:
   ```bash
   xcrun safari-web-extension-converter /path/to/pt-gold
   ```
   This generates an Xcode project wrapping the extension in a small macOS app.
2. Open the generated project in Xcode and press **Run** (▶) to build and
   install the host app.
3. In Safari: **Settings → Advanced →** enable *“Show features for web
   developers”*, then **Develop → Allow Unsigned Extensions** (re-enable after
   each Safari restart for a locally-built, unsigned extension).
4. **Settings → Extensions** → enable **PT Gold**, then grant it access to
   `phantasytour.com`.

Notes for Safari:
- Distributing the extension to *other* people (vs. running it on your own Mac)
  additionally requires an **Apple Developer account** ($99/yr) and
  notarization. Running it locally on your own machine does not.
- The toolbar **badge count** has limited support in Safari and may not appear;
  the hide/moderation behavior itself works normally.

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
