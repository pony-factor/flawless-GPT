function githubSplitURL(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname)
      || url.username || url.password || url.port) {
    throw new Error("Unsupported GitHub URL.");
  }
  return url.href;
}

const githubSplitRequests = new Map();

async function openGitHubNativeSplit(value, sourceTabId) {
  const url = githubSplitURL(value);
  if (typeof chrome.tabs.createSplit !== "function") {
    return { ok: false, unavailable: true };
  }
  const source = await chrome.tabs.get(sourceTabId);
  if (Number.isInteger(source.splitViewId) && source.splitViewId !== -1) {
    const tabs = await chrome.tabs.query({ windowId: source.windowId });
    const partner = tabs.find(tab => tab.id !== source.id && tab.splitViewId === source.splitViewId);
    // Reuse our GitHub pane; never replace a different site in an existing split.
    if (partner && partner.url && (() => {
      try { githubSplitURL(partner.url); return true; } catch { return false; }
    })()) {
      await chrome.tabs.update(partner.id, { url, active: true });
      return { ok: true };
    }
    return { ok: false, unavailable: true };
  }
  const destination = await chrome.tabs.create({
    url, windowId: source.windowId, index: source.index + 1,
    pinned: source.pinned, active: false,
  });
  // Leave the complete page available as a normal tab if grouping/splitting fails.
  try {
    if (source.groupId !== undefined && source.groupId !== -1) {
      await chrome.tabs.group({ tabIds: [destination.id], groupId: source.groupId });
    }
    await chrome.tabs.createSplit([source.id, destination.id]);
    await chrome.tabs.update(destination.id, { active: true });
    return { ok: true };
  } catch {
    await chrome.tabs.update(destination.id, { active: true });
    return { ok: false, unavailable: true };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "open-github-split-view") return false;
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith("https://chatgpt.com/")
      || !Number.isInteger(sender.tab?.id)) {
    sendResponse({ ok: false, error: "GitHub splits are only available from ChatGPT." });
    return false;
  }
  // Serialize clicks from one chat so repeated clicks reuse the same native pane.
  const tabId = sender.tab.id;
  const previous = githubSplitRequests.get(tabId) || Promise.resolve();
  const request = previous.catch(() => {}).then(() => openGitHubNativeSplit(message.url, tabId));
  githubSplitRequests.set(tabId, request);
  request.then(sendResponse).catch(() => sendResponse({ ok: false, unavailable: true }))
    .finally(() => {
      if (githubSplitRequests.get(tabId) === request) githubSplitRequests.delete(tabId);
    });
  return true;
});
