function nativeSplitURL(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)
      || url.username || url.password) {
    throw new Error("Unsupported website URL.");
  }
  return url.href;
}

const nativeSplitRequests = new Map();

async function openNativeSplit(value, sourceTabId) {
  const url = nativeSplitURL(value);
  if (typeof chrome.tabs.createSplit !== "function") {
    return { ok: false, unavailable: true };
  }
  const source = await chrome.tabs.get(sourceTabId);
  if (Number.isInteger(source.splitViewId) && source.splitViewId !== -1) {
    const tabs = await chrome.tabs.query({ windowId: source.windowId });
    const partner = tabs.find(tab => tab.id !== source.id && tab.splitViewId === source.splitViewId);
    const saved = await chrome.storage.session.get(`nativeSplitPane:${source.id}`);
    // Reuse only a pane this extension created, preserving unrelated split views.
    if (partner && saved[`nativeSplitPane:${source.id}`] === partner.id) {
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
    await chrome.storage.session.set({ [`nativeSplitPane:${source.id}`]: destination.id });
    await chrome.tabs.update(destination.id, { active: true });
    return { ok: true };
  } catch {
    await chrome.tabs.update(destination.id, { active: true });
    return { ok: false, unavailable: true };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["open-native-split-view", "watch-link-preview", "unwatch-link-preview"].includes(message?.type)) return false;
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith("https://chatgpt.com/")
      || !Number.isInteger(sender.tab?.id)) {
    sendResponse({ ok: false, error: "Native splits are only available from ChatGPT." });
    return false;
  }
  const tabId = sender.tab.id;
  if (message.type !== "open-native-split-view") {
    (async () => {
      const key = `linkPreviewWatch:${tabId}`;
      if (message.type === "watch-link-preview") {
        const url = nativeSplitURL(message.url);
        await chrome.storage.session.set({ [key]: { url, id: message.previewId } });
      } else {
        const saved = await chrome.storage.session.get(key);
        if (saved[key]?.id === message.previewId) await chrome.storage.session.remove(key);
      }
      return { ok: true };
    })().then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  // Serialize clicks from one chat so repeated clicks reuse the same native pane.
  const previous = nativeSplitRequests.get(tabId) || Promise.resolve();
  const request = previous.catch(() => {}).then(() => openNativeSplit(message.url, tabId));
  nativeSplitRequests.set(tabId, request);
  request.then(sendResponse).catch(() => sendResponse({ ok: false, unavailable: true }))
    .finally(() => {
      if (nativeSplitRequests.get(tabId) === request) nativeSplitRequests.delete(tabId);
    });
  return true;
});

chrome.webNavigation.onBeforeNavigate.addListener(details => {
  if (details.frameId === 0) return;
  void (async () => {
    const key = `linkPreviewWatch:${details.tabId}`;
    const saved = await chrome.storage.session.get(key);
    const watch = saved[key];
    if (watch && watch.url === details.url) {
      await chrome.storage.session.set({ [key]: { ...watch, frameId: details.frameId } });
    }
  })().catch(() => {});
});

chrome.webNavigation.onErrorOccurred.addListener(details => {
  if (details.frameId === 0 || details.error === "net::ERR_ABORTED") return;
  void (async () => {
    const key = `linkPreviewWatch:${details.tabId}`;
    const saved = await chrome.storage.session.get(key);
    const watch = saved[key];
    if (!watch || (watch.frameId !== details.frameId && watch.url !== details.url)) return;
    await chrome.tabs.sendMessage(details.tabId, {
      type: "link-preview-navigation-error", previewId: watch.id, url: watch.url, error: details.error,
    }, { frameId: 0 });
  })().catch(() => {});
});
