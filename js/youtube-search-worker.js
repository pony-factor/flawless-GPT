const YOUTUBE_SEARCH_TAB_ID_KEY = "youtubeSearchTabId";

async function openYouTubeSearch(urlValue) {
  const url = new URL(urlValue);
  if (url.origin !== "https://www.youtube.com" || url.pathname !== "/results") {
    throw new Error("Only YouTube search result URLs can be opened");
  }

  const stored = await chrome.storage.session.get({ [YOUTUBE_SEARCH_TAB_ID_KEY]: null });
  const existingTabId = stored[YOUTUBE_SEARCH_TAB_ID_KEY];
  if (Number.isInteger(existingTabId)) {
    try {
      await chrome.tabs.update(existingTabId, { active: true, url: url.toString() });
      return;
    } catch {
      await chrome.storage.session.remove(YOUTUBE_SEARCH_TAB_ID_KEY);
    }
  }

  const tab = await chrome.tabs.create({ active: true, url: url.toString() });
  if (Number.isInteger(tab.id)) {
    await chrome.storage.session.set({ [YOUTUBE_SEARCH_TAB_ID_KEY]: tab.id });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "open-youtube-search") return false;

  openYouTubeSearch(message.url)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
