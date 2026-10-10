(() => {
  "use strict";

  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;

  const BADGE = "data-ghrc-worked-duration";
  const MINUTES = "data-ghrc-worked-minutes";
  const DOTS_MODE = "data-ghrc-worked-dots-mode";
  const DOTS = "data-ghrc-worked-dots";
  const OWNED_TITLE = "data-ghrc-worked-added-title";
  const ARTWORK = "--ghrc-worked-artwork";
  const artworkURL = `url("${chrome.runtime.getURL("artwork/searching-complete.png")}")`;
  const PREFIX = /^Worked\s+for\s+(.+)$/i;
  const PART = /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*/gi;
  const EXCLUDED = 'pre, code, blockquote, textarea, input, [contenteditable="true"], [data-message-author-role="user"], .markdown, .prose';
  let scheduled = false;
  let dotMode = false;
  let preferenceUpdated = false;
  let stopped = false;

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
    const minuteCount = Math.floor(totalSeconds / 60);
    return {
      full: label,
      minuteCount,
      minutes: minuteCount ? `${minuteCount}m` : "",
    };
  }

  // Rows of twelve dots keep long durations readable without changing the
  // original accessible label, tooltip, or disclosure-click target.
  function dotsFor(minuteCount) {
    const rows = [];
    for (let start = 0; start < minuteCount; start += 12) {
      rows.push(Array(Math.min(12, minuteCount - start)).fill("•").join(" "));
    }
    return rows.join("\n");
  }

  function restore(element) {
    element.style.removeProperty(ARTWORK);
    element.removeAttribute(BADGE);
    element.removeAttribute(MINUTES);
    element.removeAttribute(DOTS_MODE);
    element.removeAttribute(DOTS);
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
    if (dotMode && value.minuteCount > 0) {
      if (!element.hasAttribute(DOTS_MODE)) element.setAttribute(DOTS_MODE, "");
      const dots = dotsFor(value.minuteCount);
      if (element.getAttribute(DOTS) !== dots) element.setAttribute(DOTS, dots);
    } else {
      if (element.hasAttribute(DOTS_MODE)) element.removeAttribute(DOTS_MODE);
      if (element.hasAttribute(DOTS)) element.removeAttribute(DOTS);
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

  function updateDotMode(enabled) {
    if (stopped || !context.active() || dotMode === (enabled === true)) return;
    dotMode = enabled === true;
    scheduleScan();
  }

  const onSettingsChanged = (changes, areaName) => {
    if (areaName !== "local" || !changes.workedDurationDots) return;
    preferenceUpdated = true;
    updateDotMode(changes.workedDurationDots.newValue);
  };
  chrome.storage.onChanged.addListener(onSettingsChanged);
  // An intervening change event takes precedence over an earlier settings read.
  chrome.storage.local.get({ workedDurationDots: false }).then((settings) => {
    if (!preferenceUpdated) updateDotMode(settings.workedDurationDots);
  }).catch(() => { /* Keep the default counter if storage is unavailable. */ });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document, { childList: true, subtree: true, characterData: true });
  context.onStop(() => {
    stopped = true;
    observer.disconnect();
    chrome.storage.onChanged.removeListener(onSettingsChanged);
    for (const element of document.querySelectorAll(`[${BADGE}]`)) restore(element);
  });
  scheduleScan();
})();
