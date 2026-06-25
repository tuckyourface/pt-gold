/* PT Gold — service worker. Shows the number of hidden items on the toolbar badge. */
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "ptgold:count" || !sender.tab) return;
  const tabId = sender.tab.id;
  const count = msg.count | 0;
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#0a3d2a" });
  chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
});
