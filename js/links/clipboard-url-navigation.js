(() => {
  const TYPE = "open-local-clipboard-url";
  const SEARCH_TYPE = "search-clipboard-text";
  const ENABLE_HINT = "Enable 'Allow access to file URLs' for Flawless in browser Extensions settings, then try again.";

  function trustedChatGPTSender(sender) {
    let source;
    try { source = new URL(sender?.url); } catch { /* Invalid sender. */ }
    return source?.origin === "https://chatgpt.com" && sender?.frameId === 0
      && Number.isInteger(sender?.tab?.id);
  }

  async function openLocalFile(urlText, sender) {
    if (!trustedChatGPTSender(sender)) {
      return { ok: false, error: "Local files can only be opened from ChatGPT." };
    }
    let url;
    try { url = new URL(urlText); } catch { /* Invalid clipboard URL. */ }
    if (url?.protocol !== "file:" || url.host || !url.pathname.startsWith("/")) {
      return { ok: false, error: "Only local file:/// URLs can be opened." };
    }
    // Chrome 118+ requires the user to opt in before extensions can open files.
    if (chrome.extension?.isAllowedFileSchemeAccess
        && !await chrome.extension.isAllowedFileSchemeAccess()) {
      return { ok: false, error: ENABLE_HINT };
    }
    try {
      await chrome.tabs.update(sender.tab.id, { url: url.href });
      return { ok: true };
    } catch {
      return { ok: false, error: "Could not open local file. Check file-URL access and the file path." };
    }
  }

  async function searchClipboardText(text, sender) {
    if (!trustedChatGPTSender(sender)) {
      return { ok: false, error: "Searches can only be started from ChatGPT." };
    }
    if (typeof text !== "string" || !text.trim()) {
      return { ok: false, error: "Clipboard has no text to search." };
    }
    try {
      // tabId targets the originating ChatGPT tab; do not specify disposition.
      // chrome.search uses the browser's configured default search engine.
      await chrome.search.query({ tabId: sender.tab.id, text: text.trim() });
      return { ok: true };
    } catch {
      return { ok: false, error: "Could not search with the browser's default search engine." };
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== TYPE && message?.type !== SEARCH_TYPE) return false;
    const operation = message.type === TYPE
      ? openLocalFile(message.url, sender)
      : searchClipboardText(message.text, sender);
    operation.then(sendResponse).catch(() => sendResponse({
      ok: false, error: "Could not open clipboard text.",
    }));
    return true;
  });
})();
