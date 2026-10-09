(() => {
  const TYPE = "open-local-clipboard-url";
  const ENABLE_HINT = "Enable 'Allow access to file URLs' for Flawless in browser Extensions settings, then try again.";

  async function openLocalFile(urlText, sender) {
    let source;
    try { source = new URL(sender?.url); } catch { /* Invalid sender. */ }
    if (source?.origin !== "https://chatgpt.com" || sender?.frameId !== 0
        || !Number.isInteger(sender?.tab?.id)) {
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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== TYPE) return false;
    openLocalFile(message.url, sender)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: "Could not open local file." }));
    return true;
  });
})();
