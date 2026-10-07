(() => {
  "use strict";

  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;

  const SOURCE = "flawless-gpt";
  const DATA_EVENT = "ghrc:conversation-dates";
  const REQUEST_EVENT = "ghrc:conversation-dates:request";
  const DATE_CLASS = "ghrc-chat-date";
  const LINK_SELECTOR = 'a[href*="/c/"]';
  const dates = new Map();
  let scheduled = false;

  function conversationId(link) {
    try {
      const pathname = new URL(link.href, location.href).pathname.replace(/\/+$/, "");
      return pathname.match(/^\/c\/([^/]+)$/)?.[1] || "";
    } catch {
      return "";
    }
  }

  function asDate(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return new Date(value < 1e12 ? value * 1000 : value);
    }
    if (typeof value !== "string" || !value.trim()) return null;
    const text = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) {
      const numeric = Number(text);
      return Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : null;
    }
    const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text);
    return new Date(hasZone ? text : text + "Z");
  }

  function formatAbsoluteDate(value) {
    const date = asDate(value);
    if (!date || Number.isNaN(date.getTime())) return "";
    const options = {
      day: "numeric",
      month: "short",
    };
    if (date.getFullYear() !== new Date().getFullYear()) options.year = "numeric";
    return new Intl.DateTimeFormat("en-GB", options).format(date).replace(/,/g, "");
  }

  function formatAge(value) {
    const date = asDate(value);
    if (!date || Number.isNaN(date.getTime())) return "";

    const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
    if (days < 30) return `${days}d`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    return `${Math.floor(days / 365)}y`;
  }

  function annotateLink(link) {
    const id = conversationId(link);
    const createTime = id ? dates.get(id) : null;
    const label = formatAge(createTime);
    let badge = link.querySelector(`:scope > .${DATE_CLASS}`);
    if (!label) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = DATE_CLASS;
      badge.setAttribute("aria-hidden", "true");
      link.prepend(badge);
    }
    if (badge.textContent !== label) badge.textContent = label;
    badge.title = "Created " + formatAbsoluteDate(createTime);
  }

  function scan() {
    scheduled = false;
    if (!context.active()) return;
    for (const link of document.querySelectorAll(LINK_SELECTOR)) annotateLink(link);
  }

  function scheduleScan() {
    if (scheduled || !context.active()) return;
    scheduled = true;
    requestAnimationFrame(scan);
  }

  function receive(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.source !== SOURCE || event.data?.type !== DATA_EVENT) return;
    for (const item of event.data.items || []) {
      const id = typeof item?.id === "string" ? item.id : "";
      const label = formatAge(item?.createTime);
      if (id && label) dates.set(id, item.createTime);
    }
    scheduleScan();
  }

  window.addEventListener("message", receive);
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href"],
  });
  const refreshTimer = setInterval(scheduleScan, 60 * 60 * 1000);

  context.onStop(() => {
    clearInterval(refreshTimer);
    observer.disconnect();
    window.removeEventListener("message", receive);
  });

  window.postMessage({ source: SOURCE, type: REQUEST_EVENT }, location.origin);
  scheduleScan();
})();
