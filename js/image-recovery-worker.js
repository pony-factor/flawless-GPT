// Public source recovery deliberately omits cookies and authentication.
function imageRecoveryPublicUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port
      || !host.includes(".") || host.endsWith(".local") || host.endsWith(".localhost")
      || host.includes(":") || /^\d+(\.\d+){3}$/.test(host)) throw new Error("Unsupported image source.");
  url.hash = "";
  return url;
}

async function loadImageRecoverySource(value) {
  let url = imageRecoveryPublicUrl(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    let response;
    // Validate every redirect before contacting its destination.
    for (let redirects = 0; redirects < 5; redirects++) {
      response = await fetch(url.href, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        url = imageRecoveryPublicUrl(new URL(response.headers.get("location"), url).href);
        continue;
      }
      break;
    }
    if (!response?.ok || !/text\/html/i.test(response.headers.get("content-type") || "")) throw new Error("Source page unavailable.");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > 2_000_000) { await reader.cancel(); throw new Error("Source page too large."); }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { ok: true, url: url.href, html: new TextDecoder().decode(bytes) };
  } finally { clearTimeout(timeout); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "recover-image-source") return false;
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith("https://chatgpt.com/")) return false;
  loadImageRecoverySource(message.url).then(sendResponse)
    .catch(() => sendResponse({ ok: false }));
  return true;
});
