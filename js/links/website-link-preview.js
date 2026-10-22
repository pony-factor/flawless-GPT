async function loadWebsiteLinkPreview(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Unsupported website URL.");
  }
  const response = await fetch(url.href, {
    credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Website returned HTTP ${response.status}.`);
  if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") || "")) {
    await response.body?.cancel();
    throw new Error("This page has no text preview. Use Open in new tab to view it.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error("This page is too large for a text preview.");
      html += decoder.decode(value, { stream: true });
    }
    html += decoder.decode();
  } finally {
    await reader.cancel();
  }
  return { ok: true, html };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["load-website-link-preview", "open-website-verification"].includes(message?.type)) return false;
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith("https://chatgpt.com/")) {
    sendResponse({ ok: false, error: "Website previews are only available from ChatGPT." });
    return false;
  }
  if (message.type === "open-website-verification") {
    (async () => {
      const url = new URL(message.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("Unsupported website URL.");
      }
      // A real top-level website can run its own verification and retain its
      // normal browser cookies. Keep it separate from the summary conversation.
      await chrome.windows.create({ url: url.href, type: "popup", width: 620, height: 800, focused: true });
      return { ok: true };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  loadWebsiteLinkPreview(message.url).then(sendResponse)
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
