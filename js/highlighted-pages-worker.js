(() => {
  "use strict";

  const MAX_HTML_BYTES = 2 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 256 * 1024;
  const MAX_FAVICON_BYTES = 64 * 1024;

  function decodeEntities(value) {
    return String(value || "")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number.parseInt(number, 10)))
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&");
  }

  function textValue(value) {
    return decodeEntities(
      String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    );
  }

  function attributes(tag) {
    const result = {};
    const body = tag.replace(/^<\/?[a-z0-9:-]+/i, "").replace(/\/?\s*>$/, "");
    const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g;
    let match;
    while ((match = pattern.exec(body))) {
      result[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
    return result;
  }

  function metaContent(html, keys) {
    const wanted = new Set(keys.map((key) => key.toLowerCase()));
    for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
      const attrs = attributes(tag);
      const key = String(attrs.property || attrs.name || "").toLowerCase();
      if (wanted.has(key) && attrs.content) return textValue(attrs.content);
    }
    return "";
  }

  function documentTitle(html) {
    return metaContent(html, ["og:title", "twitter:title"])
      || textValue(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  }

  function iconHref(html) {
    for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
      const attrs = attributes(tag);
      const rel = String(attrs.rel || "").toLowerCase().split(/\s+/);
      if (rel.includes("icon") && attrs.href) return attrs.href;
    }
    return "/favicon.ico";
  }

  function absoluteUrl(value, base) {
    if (!value) return "";
    try {
      const url = new URL(value, base);
      return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
    } catch {
      return "";
    }
  }

  async function limitedText(response) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const limited = bytes.byteLength > MAX_HTML_BYTES ? bytes.slice(0, MAX_HTML_BYTES) : bytes;
    return new TextDecoder().decode(limited);
  }

  function arrayBufferToDataUrl(buffer, contentType) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return `data:${contentType};base64,${btoa(binary)}`;
  }

  async function cachedImage(candidate, pageUrl, maxBytes) {
    if (!candidate) return "";
    const imageUrl = new URL(candidate, pageUrl);
    const page = new URL(pageUrl);
    if (imageUrl.origin !== page.origin) return "";

    try {
      const response = await fetch(imageUrl.toString(), {
        credentials: "omit",
        redirect: "follow",
      });
      if (!response.ok) return "";
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().startsWith("image/")) return "";
      const length = Number.parseInt(response.headers.get("content-length") || "0", 10);
      if (length > maxBytes) return "";
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) return "";
      return arrayBufferToDataUrl(buffer, contentType.split(";")[0] || "image/png");
    } catch {
      return "";
    }
  }

  async function loadPreview(urlValue) {
    const requestedUrl = new URL(urlValue);
    if (!["http:", "https:"].includes(requestedUrl.protocol)) {
      throw new Error("Only http and https webpages can be highlighted.");
    }

    const response = await fetch(requestedUrl.toString(), {
      credentials: "omit",
      redirect: "follow",
      cache: "no-store",
      headers: { Accept: "text/html,application/xhtml+xml,application/pdf" },
    });
    if (!response.ok) {
      throw new Error(`The webpage returned HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") || "";
    const finalUrl = response.url || requestedUrl.toString();
    const final = new URL(finalUrl);
    if (/^application\/(?:pdf|x-pdf)(?:\s*;|\s*$)/i.test(contentType)) {
      // The options page renders the PDF using its canvas; only metadata is needed here.
      await response.body?.cancel();
      if (requestedUrl.hash) final.hash = requestedUrl.hash;
      let filename = final.pathname.split("/").pop() || "PDF document";
      try {
        filename = decodeURIComponent(filename);
      } catch {
        // Keep the original filename when its URL encoding is malformed.
      }
      return {
        url: final.toString(),
        hostname: final.hostname.replace(/^www\./i, ""),
        title: filename.slice(0, 180),
        description: "PDF document",
        documentType: "pdf",
        siteName: "",
        imageDataUrl: "",
        faviconDataUrl: "",
        fetchedAt: Date.now(),
      };
    }
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error("That URL did not return an HTML webpage or PDF document.");
    }

    const html = await limitedText(response);
    const title = documentTitle(html) || final.hostname;
    const description = metaContent(html, ["og:description", "twitter:description", "description"]);
    const siteName = metaContent(html, ["og:site_name"]);
    const imageUrl = absoluteUrl(metaContent(html, ["og:image", "twitter:image"]), finalUrl);
    const faviconUrl = absoluteUrl(iconHref(html), finalUrl);
    const [imageDataUrl, faviconDataUrl] = await Promise.all([
      cachedImage(imageUrl, finalUrl, MAX_IMAGE_BYTES),
      cachedImage(faviconUrl, finalUrl, MAX_FAVICON_BYTES),
    ]);

    return {
      url: finalUrl,
      hostname: final.hostname.replace(/^www\./i, ""),
      title: title.slice(0, 180),
      description: description.slice(0, 320),
      siteName: siteName.slice(0, 100),
      imageDataUrl,
      faviconDataUrl,
      fetchedAt: Date.now(),
    };
  }

  const testApi = globalThis.__GHRC_HIGHLIGHTED_PAGES_TEST__;
  if (testApi) {
    Object.assign(testApi, {
      attributes,
      metaContent,
      documentTitle,
      iconHref,
      absoluteUrl,
      textValue,
      loadPreview,
    });
    return;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "load-highlighted-page-preview") return false;
    loadPreview(message.url)
      .then((preview) => sendResponse({ ok: true, preview }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
