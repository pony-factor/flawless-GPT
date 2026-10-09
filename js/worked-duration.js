(() => {
  "use strict";

  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;

  const BADGE = "data-ghrc-worked-duration";
  const MINUTES = "data-ghrc-worked-minutes";
  const OWNED_TITLE = "data-ghrc-worked-added-title";
  const ARTWORK = "--ghrc-worked-artwork";
  const artworkURL = `url("${chrome.runtime.getURL("artwork/searching-complete.png")}")`;
  const PREFIX = /^Worked\s+for\s+(.+)$/i;
  const PART = /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*/gi;
  const EXCLUDED = 'pre, code, blockquote, textarea, input, [contenteditable="true"], [data-message-author-role="user"], .markdown, .prose';
  let scheduled = false;

  function durationFrom(text) {
    const label = (text || "").replace(/\s+/g, " ").trim();
    const match = PREFIX.exec(label);
    if (!match) return null;

    let totalSeconds = 0;
    let tokens = 0;
    const extra = match[1].replace(PART, (_, count, unit) => {
      tokens++;
      const amount = Number(count);
      if (/^h/i.test(unit)) totalSeconds += amount * 3600;
      else if (/^m/i.test(unit)) totalSeconds += amount * 60;
      else totalSeconds += amount;
      return "";
    });
    if (!tokens || extra.trim() || !Number.isSafeInteger(totalSeconds)) return null;
    return {
      full: label,
      minutes: totalSeconds < 60 ? "" : `${Math.floor(totalSeconds / 60)}m`,
    };
  }

  function restore(element) {
    element.style.removeProperty(ARTWORK);
    element.removeAttribute(BADGE);
    element.removeAttribute(MINUTES);
    if (element.hasAttribute(OWNED_TITLE)) {
      element.removeAttribute("title");
      element.removeAttribute(OWNED_TITLE);
    }
  }

  function annotate(element, value) {
    if (element.style.getPropertyValue(ARTWORK) !== artworkURL) {
      element.style.setProperty(ARTWORK, artworkURL);
    }
    if (element.getAttribute(MINUTES) !== value.minutes) {
      element.setAttribute(MINUTES, value.minutes);
    }
    if (!element.hasAttribute(BADGE)) element.setAttribute(BADGE, "");
    // The original, precise timing remains available on hover and as text
    // to assistive technology; only its visual presentation changes.
    if (!element.hasAttribute("title")) {
      element.setAttribute(OWNED_TITLE, "");
    }
    if (element.hasAttribute(OWNED_TITLE) && element.getAttribute("title") !== value.full) {
      element.setAttribute("title", value.full);
    }
  }

  function scan() {
    scheduled = false;
    if (!context.active()) return;
    const root = document.querySelector("main");
    if (!root) return;

    for (const element of root.querySelectorAll(`[${BADGE}]`)) {
      const parsed = durationFrom(element.textContent);
      if (!parsed) restore(element);
      else annotate(element, parsed);
    }

    // Match only a complete native label, never the same words in a
    // conversation, code block, input, or longer textual paragraph.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!/^\s*Worked\s+for\s+/i.test(node.nodeValue || "")) continue;
      const element = node.parentElement;
      if (!element || element.closest(EXCLUDED)) continue;
      const raw = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      if ((element.textContent || "").replace(/\s+/g, " ").trim() !== raw) continue;
      const parsed = durationFrom(raw);
      if (parsed) annotate(element, parsed);
    }
  }

  function scheduleScan() {
    if (scheduled || !context.active()) return;
    scheduled = true;
    requestAnimationFrame(scan);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document, { childList: true, subtree: true, characterData: true });
  context.onStop(() => {
    observer.disconnect();
    for (const element of document.querySelectorAll(`[${BADGE}]`)) restore(element);
  });
  scheduleScan();
})();
