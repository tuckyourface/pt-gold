/* =========================================================================
 * PT Gold — site skins. Sets data-ptg-skin on <html> as early as possible so
 * skin.css (injected at document_start) can restyle the forum. "original"
 * leaves the site untouched.
 * ========================================================================= */
(() => {
  "use strict";
  const KEY = "ptgold_settings";
  const apply = (skin) => {
    const v = skin || "original";
    if (v === "original") document.documentElement.removeAttribute("data-ptg-skin");
    else document.documentElement.setAttribute("data-ptg-skin", v);
  };
  chrome.storage.sync.get(KEY, (r) => apply((r[KEY] || {}).skin));
  chrome.storage.onChanged.addListener((c, a) => { if (a === "sync" && c[KEY]) apply((c[KEY].newValue || {}).skin); });
})();
