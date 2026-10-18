async function openYouTubeSearch(urlValue, sender) {
  let source;
  try { source = new URL(sender?.url); } catch { /* Invalid sender. */ }
  if (source?.origin !== "https://chatgpt.com" || sender?.frameId !== 0
      || !Number.isInteger(sender?.tab?.id)) {
    throw new Error("YouTube searches must originate from a ChatGPT tab");
  }
  const url = new URL(urlValue);
  if (url.origin !== "https://www.youtube.com" || url.pathname !== "/results") {
    throw new Error("Only YouTube search result URLs can be opened");
  }
  await chrome.tabs.update(sender.tab.id, { url: url.toString() });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "open-youtube-search") return false;
  openYouTubeSearch(message.url, sender)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
