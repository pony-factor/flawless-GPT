(() => {
  "use strict";
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const ROOT = '[data-dil-message-id], [data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"]';
  const attempted = new WeakSet();
  const restorations = new Map();
  const sources = new Map();
  let scheduled = false;

  function publicUrl(value, base = location.href) {
    try {
      const url = new URL(value, base);
      if (url.protocol !== "https:" || url.username || url.password || url.port
          || !url.hostname.includes(".") || /(?:\.local|\.localhost)$/.test(url.hostname)
          || url.hostname.includes(":") || /^\d+(\.\d+){3}$/.test(url.hostname)) return null;
      return url.href;
    } catch { return null; }
  }
  const normalize = value => (value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  function sourceImages(html, base) {
    // Keep source markup inert, including lazy-loaded image addresses.
    const inert = html.replace(/(\s)(src|srcset)\s*=/gi, '$1data-ghrc-$2=');
    const doc = new DOMParser().parseFromString(inert, "text/html");
    const result = [];
    for (const img of doc.querySelectorAll("img")) {
      const raw = img.getAttribute("data-src") || img.getAttribute("data-lazy-src")
        || img.getAttribute("data-original") || img.getAttribute("data-ghrc-src");
      const url = raw && publicUrl(raw, base);
      if (!url) continue;
      const tableRow = img.closest("tr");
      let heading = "";
      for (let parent = img.parentElement, depth = 0; !tableRow && parent && depth < 7; parent = parent.parentElement, depth++) {
        const headings = parent.querySelectorAll("h1,h2,h3,h4,figcaption");
        if (headings.length === 1) { heading = headings[0].textContent; break; }
        if (headings.length > 1) break;
      }
      const rowLabel = tableRow?.querySelector("td[id],th[scope=row]")?.textContent;
      // Catalog tables contain decorative species/sex icons beside the artwork.
      const artwork = img.getAttribute("data-relevant") !== "0";
      result.push({ url, alt: normalize(img.getAttribute("alt") || img.getAttribute("title")), heading: normalize(heading), rowLabel: artwork ? normalize(rowLabel) : "", lazy: img.hasAttribute("data-src") || img.hasAttribute("data-lazy-src") });
    }
    return result;
  }

  async function loadSource(url) {
    if (!sources.has(url)) {
      // A bounded per-chat cache avoids refetching a citation for every image.
      if (sources.size >= 30) sources.delete(sources.keys().next().value);
      sources.set(url, chrome.runtime.sendMessage({ type: "recover-image-source", url })
        .then(result => result?.ok ? sourceImages(result.html, result.url) : [])
        .catch(() => []));
    }
    return sources.get(url);
  }

  function originalCandidates(element) {
    element.dispatchEvent(new Event("ghrc-resolve-image-source", { bubbles: true }));
    const urls = [];
    const add = value => { const url = value && publicUrl(value); if (url && !urls.includes(url)) urls.push(url); };
    for (const key of ["data-ghrc-original-image", "data-original-src", "data-src", "data-image-url"]) add(element.getAttribute(key));
    if (element.tagName === "IMG") {
      const src = publicUrl(element.currentSrc || element.getAttribute("src"));
      if (src) {
        const parsed = new URL(src);
        for (const key of ["url", "image_url", "src", "original"]) add(parsed.searchParams.get(key));
        add(src);
      }
    }
    return urls;
  }

  async function sourceCandidates(element) {
    const root = element.closest('[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"]') || element.closest(ROOT);
    if (!root) return [];
    const row = element.closest('[data-d-component="row"], figure');
    const label = element.getAttribute("alt") || row?.querySelector("strong,b,h2,h3,figcaption,[data-d-default-strong]")?.textContent
      || row?.textContent.split(/\s+[—–]\s+/)[0];
    const caption = normalize(label);
    if (!caption || caption.length < 3 || caption === "image unavailable") return [];
    const links = [...root.querySelectorAll("a[href]")].map(link => publicUrl(link.getAttribute("href")))
      .filter(url => url && new URL(url).hostname !== "chatgpt.com");
    element.dispatchEvent(new Event("ghrc-resolve-image-citations", { bubbles: true }));
    try {
      for (const value of JSON.parse(element.getAttribute("data-ghrc-image-citations") || "[]")) {
        const url = publicUrl(value);
        if (url && new URL(url).hostname !== "chatgpt.com") links.push(url);
      }
    } catch { /* No recoverable citation metadata. */ }
    const unique = [...new Set(links)].slice(0, 6);
    const images = (await Promise.all(unique.map(loadSource))).flat();
    const ranked = images.map(image => {
      let score = image.alt === caption ? 100 : image.heading === caption || image.rowLabel === caption ? 80 : 0;
      if (!score && image.alt.includes(caption) && image.alt.length <= caption.length * 2) score = 60;
      // Lazy artwork wins over adjacent decorative symbols under the same heading.
      if (score && image.lazy) score++;
      return { ...image, score };
    }).filter(image => image.score).sort((a, b) => b.score - a.score);
    if (!ranked.length) return [];
    const best = [...new Set(ranked.filter(image => image.score === ranked[0].score).map(image => image.url))];
    return best.length === 1 ? best : [];
  }

  async function recover(element) {
    let urls = originalCandidates(element);
    let triedSources = !urls.length;
    if (triedSources) urls = await sourceCandidates(element);
    if (!urls.length) { attempted.delete(element); return; }
    if (!context.active() || !element.isConnected) return;
    const native = element.tagName === "IMG";
    const image = document.createElement("img");
    const oldLabel = element.getAttribute("aria-label");
    const oldPosition = element.style.position;
    const oldVisibility = element.style.visibility;
    const children = [...element.children];
    const displays = children.map(child => child.style.display);
    const row = element.closest('[data-d-component="row"], figure');
    image.alt = element.getAttribute("alt") || row?.querySelector("strong,b,h2,h3,figcaption,[data-d-default-strong]")?.textContent
      || row?.textContent.split(/\s+[—–]\s+/)[0]?.trim() || "Recovered image";
    image.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none";
    let wrapper;
    const restore = () => {
      image.onload = image.onerror = null;
      image.remove();
      if (wrapper) { wrapper.replaceWith(element); element.style.visibility = oldVisibility; }
      element.style.position = oldPosition;
      if (oldLabel === null) element.removeAttribute("aria-label"); else element.setAttribute("aria-label", oldLabel);
      children.forEach((child, i) => { child.style.display = displays[i]; });
    };
    restorations.set(element, restore);
    let index = 0;
    image.onload = () => {
      if (!context.active() || !element.isConnected) { restore(); restorations.delete(element); return; }
      if (native) {
        wrapper = document.createElement("span");
        wrapper.style.cssText = "position:relative;display:inline-block;max-width:100%";
        element.replaceWith(wrapper);
        wrapper.append(element, image);
        element.style.visibility = "hidden";
      } else {
        element.style.position = "relative";
        children.forEach(child => { child.style.display = "none"; });
        element.append(image);
        element.setAttribute("aria-label", image.alt);
      }
      image.style.display = "block";
    };
    image.onerror = async () => {
      if (context.active() && element.isConnected && ++index < urls.length) { image.src = urls[index]; return; }
      if (!triedSources && context.active() && element.isConnected) {
        triedSources = true;
        const fallback = (await sourceCandidates(element)).filter(url => !urls.includes(url));
        if (context.active() && element.isConnected && fallback.length) {
          urls = fallback;
          index = 0;
          image.src = urls[0];
          return;
        }
      }
      restore(); restorations.delete(element);
    };
    // Keep same-origin attachment authentication; omit cross-site referrers.
    image.referrerPolicy = "no-referrer";
    image.src = urls[0];
  }

  function isCitationFavicon(element) {
    if (element.tagName !== "IMG") return false;
    const raw = element.currentSrc || element.getAttribute("src") || "";
    try {
      const url = new URL(raw, location.href);
      return url.protocol === "https:"
        && ["www.google.com", "google.com"].includes(url.hostname)
        && url.pathname === "/s2/favicons";
    } catch { return false; }
  }

  function scan() {
    scheduled = false;
    if (!context.active()) return;
    for (const element of document.querySelectorAll(`[role="img"][aria-label="Image unavailable"], ${ROOT.split(", ").map(root => `${root} img`).join(", ")}`)) {
      if (attempted.has(element) || isCitationFavicon(element) || element.tagName === "IMG" && (!element.complete || element.naturalWidth || !element.getAttribute("src"))) continue;
      attempted.add(element);
      void recover(element).catch(() => {});
    }
    for (const [element, restore] of restorations) if (!element.isConnected) { restore(); restorations.delete(element); }
  }
  function schedule() {
    if (scheduled || !context.active()) return;
    scheduled = true;
    requestAnimationFrame(scan);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["src", "srcset", "aria-label"] });
  document.addEventListener("error", schedule, true);
  context.onStop(() => {
    observer.disconnect();
    document.removeEventListener("error", schedule, true);
    for (const restore of restorations.values()) restore();
    restorations.clear();
    sources.clear();
  });
  schedule();
})();
