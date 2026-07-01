/* =========================================================================
 * PT Gold — on-site composer tools (isolated content script).
 *
 * The forum's post box is a plain <textarea> with no emoji/GIF affordance.
 * This adds a 😀 / GIF toolbar above any compose box on the forum and lets you
 * insert emoji, search Giphy (via your key, proxied through the worker), or
 * paste an image/GIF URL — inserted at the cursor. Knockout picks up the change
 * because we dispatch an 'input' event.
 * ========================================================================= */
(() => {
  "use strict";
  const KEY = "ptgold_settings";
  let giphyKey = "";
  chrome.storage.sync.get(KEY, (r) => { giphyKey = ((r[KEY] || {}).giphyKey) || ""; });
  chrome.storage.onChanged.addListener((c, a) => { if (a === "sync" && c[KEY]) giphyKey = ((c[KEY].newValue || {}).giphyKey) || ""; });

  const EMOJI = {
    "Smileys": "😀 😁 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😜 🤪 🤔 🤨 😐 😴 😎 🥳 😏 😒 😞 😢 😭 😤 😡 🤬 🥺 😳 🤯 😬 🙄 😱 🤗 🤫 🤭 😷 🤒 🤠".split(" "),
    "Gestures": "👍 👎 👊 ✊ 🤝 👏 🙌 🙏 🤙 💪 👀 🫡 🤟 ✌️ 🤘 👌 🤞 👋 🖖 💁 🤷 🤦".split(" "),
    "Hearts": "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💯 🔥 ✨ ⭐ 🌟 💫 ⚡".split(" "),
    "Party": "🎉 🎊 🥂 🍻 🍺 🎸 🥁 🎹 🎺 🎶 🎵 🎤 🕺 💃 🪩 🎧".split(" "),
    "Nature": "🌈 ☀️ 🌙 🌊 🌲 🍄 🌻 🐟 🐳 🦋 🐝 🐢 🐐 🦍 🐉 🌵".split(" "),
    "Misc": "💩 👻 💀 👽 🤖 🎃 🍕 🌭 🌮 🍩 ☕ 🚀 🛸 🏆 🎯 ✅ ❌ ❓ ❗ 💬".split(" "),
  };

  function insertAtCursor(ta, text) {
    const s = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    const e = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    const pad = ta.value && s > 0 && !/\s$/.test(ta.value.slice(0, s)) ? " " : "";
    const ins = pad + text + " ";
    ta.value = ta.value.slice(0, s) + ins + ta.value.slice(e);
    const pos = s + ins.length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    ta.dispatchEvent(new Event("input", { bubbles: true }));   // Knockout observable updates
    ta.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* ---- shared popover ---- */
  let pop = null, activeTa = null, gifBtn = null;
  function build() {
    if (pop) return;
    pop = document.createElement("div"); pop.className = "ptg-pick"; pop.style.display = "none";
    const tabs = document.createElement("div"); tabs.className = "ptg-pick-tabs";
    tabs.innerHTML = '<button type="button" data-t="emoji" class="on">😀 Emoji</button><button type="button" data-t="gif">GIF</button>';
    const emo = document.createElement("div"); emo.className = "ptg-pick-emoji";
    Object.keys(EMOJI).forEach((cat) => {
      const h = document.createElement("div"); h.className = "ptg-pick-cat"; h.textContent = cat; emo.appendChild(h);
      const grid = document.createElement("div"); grid.className = "ptg-pick-egrid";
      EMOJI[cat].forEach((ch) => { const b = document.createElement("button"); b.type = "button"; b.className = "ptg-pick-e"; b.textContent = ch; b.addEventListener("click", () => { if (activeTa) insertAtCursor(activeTa, ch); }); grid.appendChild(b); });
      emo.appendChild(grid);
    });
    const gif = document.createElement("div"); gif.className = "ptg-pick-gif"; gif.style.display = "none";
    gif.innerHTML =
      '<input type="text" class="ptg-pick-search" placeholder="Search Giphy…" spellcheck="false">' +
      '<input type="text" class="ptg-pick-paste" placeholder="…or paste an image / GIF URL" spellcheck="false">' +
      '<div class="ptg-pick-ggrid"></div>';
    pop.append(tabs, emo, gif);
    document.body.appendChild(pop);

    tabs.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => tab(b.dataset.t)));
    const gi = gif.querySelector(".ptg-pick-search"); let deb;
    gi.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(() => searchGif(gi.value.trim()), 350); });
    const pi = gif.querySelector(".ptg-pick-paste");
    pi.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const u = pi.value.trim(); if (/^https?:\/\/\S+$/i.test(u) && activeTa) { insertAtCursor(activeTa, u); pi.value = ""; hide(); } } });
    document.addEventListener("click", (e) => { if (pop.style.display === "none") return; if (e.target.closest(".ptg-pick") || e.target.closest(".ptg-ctool")) return; hide(); });
    window.addEventListener("resize", hide);
    // hide on PAGE scroll (the anchor moves), but not when scrolling inside the picker itself
    window.addEventListener("scroll", (e) => {
      if (pop.style.display === "none") return;
      if (e.target && e.target.nodeType === 1 && e.target.closest && e.target.closest(".ptg-pick")) return;
      hide();
    }, true);
  }
  function tab(t) {
    pop.querySelectorAll(".ptg-pick-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
    pop.querySelector(".ptg-pick-emoji").style.display = t === "emoji" ? "" : "none";
    pop.querySelector(".ptg-pick-gif").style.display = t === "gif" ? "" : "none";
    if (t === "gif" && !pop.querySelector(".ptg-pick-ggrid").childElementCount) searchGif("");
  }
  function note(t) { return '<div class="ptg-pick-note">' + t + "</div>"; }
  function searchGif(q) {
    const grid = pop.querySelector(".ptg-pick-ggrid");
    if (!giphyKey) { grid.innerHTML = note("Add a free Giphy API key in the PT Gold panel (Settings → Images &amp; GIFs) to search. Or paste a GIF URL above."); return; }
    grid.innerHTML = note("Loading…");
    chrome.runtime.sendMessage({ type: "ptg:giphy", q }, (res) => {
      if (chrome.runtime.lastError || !res) { grid.innerHTML = note("Couldn’t reach Giphy."); return; }
      if (!res.ok) { grid.innerHTML = note(res.reason === "nokey" ? "Add your Giphy key in the PT Gold panel." : "Giphy error — check your key."); return; }
      if (!res.items.length) { grid.innerHTML = note("No GIFs found."); return; }
      grid.textContent = "";
      res.items.forEach((it) => {
        const b = document.createElement("button"); b.type = "button"; b.className = "ptg-pick-g";
        const img = document.createElement("img"); img.loading = "lazy"; img.src = it.preview; img.alt = it.title || "gif";
        b.appendChild(img);
        b.addEventListener("click", () => { if (activeTa) insertAtCursor(activeTa, it.full); hide(); });
        grid.appendChild(b);
      });
    });
  }
  function position(btn) {
    // pop is position:fixed, so viewport-relative rect coords are used directly
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
    const above = r.top - pop.offsetHeight - 6;
    pop.style.top = (above > 8 ? above : r.bottom + 6) + "px";
  }
  function hide() { if (pop) pop.style.display = "none"; gifBtn = null; }
  function toggle(ta, startTab, btn) {
    build();
    if (pop.style.display !== "none" && gifBtn === btn) { hide(); return; }
    activeTa = ta; gifBtn = btn;
    pop.style.display = ""; tab(startTab); position(btn);
  }

  /* ---- attach toolbar to compose boxes ---- */
  function isComposeBox(ta) {
    if (ta.dataset.ptgTools || ta.disabled || ta.readOnly) return false;
    const ph = (ta.getAttribute("placeholder") || "").toLowerCase();
    const nm = ((ta.name || "") + " " + (ta.id || "") + " " + (ta.className || "")).toLowerCase();
    if (/search/.test(ph) || /search/.test(nm)) return false;
    const r = ta.getBoundingClientRect();
    return r.width >= 180 && r.height >= 28;   // a real post box, not a tiny field
  }
  function attach(ta) {
    ta.dataset.ptgTools = "1";
    const bar = document.createElement("div"); bar.className = "ptg-ctools";
    const emo = document.createElement("button"); emo.type = "button"; emo.className = "ptg-ctool"; emo.textContent = "😀"; emo.title = "Emoji";
    const gif = document.createElement("button"); gif.type = "button"; gif.className = "ptg-ctool ptg-ctool-gif"; gif.textContent = "GIF"; gif.title = "Insert a GIF";
    emo.addEventListener("click", (e) => { e.preventDefault(); toggle(ta, "emoji", emo); });
    gif.addEventListener("click", (e) => { e.preventDefault(); toggle(ta, "gif", gif); });
    bar.append(emo, gif);
    ta.parentNode.insertBefore(bar, ta);
  }
  function scan() { document.querySelectorAll("textarea:not([data-ptg-tools])").forEach((ta) => { if (isComposeBox(ta)) attach(ta); }); }

  let pending = null;
  const schedule = () => { if (pending) return; pending = setTimeout(() => { pending = null; scan(); }, 200); };
  const obs = new MutationObserver(schedule);
  function start() { scan(); obs.observe(document.documentElement, { childList: true, subtree: true }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
