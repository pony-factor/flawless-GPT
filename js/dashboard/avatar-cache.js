const OWNER_AVATAR_CACHE_KEY = "ownerAvatarCacheV1";
const OWNER_AVATAR_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OWNER_AVATAR_CACHE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const OWNER_AVATAR_SIZE = 64;
const MAX_AVATAR_BYTES = 256 * 1024;
const ownerAvatarRequests = new Map();
let ownerAvatarWriteQueue = Promise.resolve();

function normalizedAvatarUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "avatars.githubusercontent.com") {
    throw new Error("Unsupported GitHub avatar URL");
  }
  return url.toString();
}

function sizedAvatarUrl(sourceUrl) {
  const url = new URL(sourceUrl);
  url.searchParams.set("s", String(OWNER_AVATAR_SIZE));
  return url.toString();
}

function isAvatarCacheEntry(value) {
  return Boolean(
    value
    && typeof value.dataUrl === "string"
    && value.dataUrl.startsWith("data:image/")
    && Number.isFinite(value.cachedAt),
  );
}

async function loadAvatarCache() {
  const stored = await chrome.storage.local.get({ [OWNER_AVATAR_CACHE_KEY]: {} });
  const cache = stored[OWNER_AVATAR_CACHE_KEY];
  return cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function responseToDataUrl(response) {
  const contentType = response.headers.get("content-type") || "image/png";
  if (!contentType.startsWith("image/")) throw new Error("GitHub avatar response was not an image");

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_AVATAR_BYTES) throw new Error("GitHub avatar was unexpectedly large");
  return `data:${contentType};base64,${bytesToBase64(new Uint8Array(buffer))}`;
}

async function saveAvatarEntry(sourceUrl, entry) {
  ownerAvatarWriteQueue = ownerAvatarWriteQueue.catch(() => {}).then(async () => {
    const cache = await loadAvatarCache();
    const cutoff = Date.now() - OWNER_AVATAR_CACHE_RETENTION_MS;

    for (const [url, cached] of Object.entries(cache)) {
      if (!isAvatarCacheEntry(cached) || cached.cachedAt < cutoff) delete cache[url];
    }

    cache[sourceUrl] = entry;
    await chrome.storage.local.set({ [OWNER_AVATAR_CACHE_KEY]: cache });
  });

  return ownerAvatarWriteQueue;
}

async function cacheOwnerAvatar(value) {
  const sourceUrl = normalizedAvatarUrl(value);
  const cache = await loadAvatarCache();
  const existing = cache[sourceUrl];
  const age = isAvatarCacheEntry(existing) ? Math.max(0, Date.now() - existing.cachedAt) : Infinity;

  if (age <= OWNER_AVATAR_CACHE_TTL_MS) {
    return { sourceUrl, ...existing, cached: true, stale: false };
  }

  if (ownerAvatarRequests.has(sourceUrl)) return ownerAvatarRequests.get(sourceUrl);

  const request = (async () => {
    try {
      const response = await fetch(sizedAvatarUrl(sourceUrl), { cache: "no-store" });
      if (!response.ok) throw new Error(`GitHub avatar returned ${response.status}`);

      const entry = {
        dataUrl: await responseToDataUrl(response),
        cachedAt: Date.now(),
      };
      await saveAvatarEntry(sourceUrl, entry);
      return { sourceUrl, ...entry, cached: false, stale: false };
    } catch (error) {
      if (isAvatarCacheEntry(existing)) {
        return { sourceUrl, ...existing, cached: true, stale: true };
      }
      throw error;
    } finally {
      ownerAvatarRequests.delete(sourceUrl);
    }
  })();

  ownerAvatarRequests.set(sourceUrl, request);
  return request;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "cache-owner-avatar") return false;

  cacheOwnerAvatar(message.url)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
