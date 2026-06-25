/* PT Gold — popup controller. Persists to chrome.storage.sync. */
(() => {
  "use strict";

  const STORE_KEY = "ptgold_settings";
  const DEFAULTS = { enabled: true, handles: [], keywords: [] };

  let settings = { ...DEFAULTS };

  const $ = (s) => document.querySelector(s);
  const els = {
    body: document.body,
    enabled: $("#enabled"),
    stateLabel: $("#stateLabel"),
    hiddenCount: $("#hiddenCount"),
    handlesChips: $("#handlesChips"),
    keywordsChips: $("#keywordsChips"),
  };

  /* ---- persistence ---- */
  function save() {
    chrome.storage.sync.set({ [STORE_KEY]: settings });
  }

  function load(cb) {
    chrome.storage.sync.get(STORE_KEY, (res) => {
      settings = { ...DEFAULTS, ...((res && res[STORE_KEY]) || {}) };
      settings.handles = Array.isArray(settings.handles) ? settings.handles : [];
      settings.keywords = Array.isArray(settings.keywords) ? settings.keywords : [];
      cb && cb();
    });
  }

  /* ---- rendering ---- */
  function renderEnabled() {
    els.enabled.checked = !!settings.enabled;
    els.stateLabel.textContent = settings.enabled ? "ACTIVE" : "INACTIVE";
    els.body.classList.toggle("off", !settings.enabled);
  }

  function makeChip(value, listName) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const label = document.createElement("span");
    label.textContent = (listName === "handles" ? "@" : "") + value;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.title = "Remove";
    x.addEventListener("click", () => removeItem(listName, value));
    chip.appendChild(label);
    chip.appendChild(x);
    return chip;
  }

  function renderList(listName, container) {
    container.textContent = "";
    settings[listName].forEach((v) => container.appendChild(makeChip(v, listName)));
  }

  function renderAll() {
    renderEnabled();
    renderList("handles", els.handlesChips);
    renderList("keywords", els.keywordsChips);
  }

  /* ---- mutations ---- */
  function addItem(listName, raw) {
    let v = (raw || "").trim();
    if (listName === "handles") v = v.replace(/^@+/, "");
    v = v.toLowerCase();
    if (!v) return;
    if (settings[listName].includes(v)) return;
    settings[listName] = [...settings[listName], v].sort();
    save();
    renderList(listName, listName === "handles" ? els.handlesChips : els.keywordsChips);
  }

  function removeItem(listName, value) {
    settings[listName] = settings[listName].filter((v) => v !== value);
    save();
    renderList(listName, listName === "handles" ? els.handlesChips : els.keywordsChips);
  }

  /* ---- events ---- */
  els.enabled.addEventListener("change", () => {
    settings.enabled = els.enabled.checked;
    save();
    renderEnabled();
  });

  document.querySelectorAll("form.add").forEach((form) => {
    const listName = form.dataset.list;
    const input = form.querySelector("input");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      addItem(listName, input.value);
      input.value = "";
      input.focus();
    });
  });

  /* ---- live count from the active tab ---- */
  function refreshCount() {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || !tab.id) return;
        chrome.tabs.sendMessage(tab.id, { type: "ptgold:getCount" }, (resp) => {
          if (chrome.runtime.lastError) return; // not a PT page
          if (resp && typeof resp.count === "number") {
            els.hiddenCount.textContent = String(resp.count);
          }
        });
      });
    } catch (_) {}
  }

  /* ---- boot ---- */
  load(() => {
    renderAll();
    refreshCount();
    setInterval(refreshCount, 1000);
  });
})();
