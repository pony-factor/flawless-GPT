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
  const EXCLUDED = 'pre, code, blockquote, textarea, input, [contenteditable="true"], [data-message-author-role="user"], [data-conversation-role="user"], .markdown, .prose';
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

  // The browser wraps between dots only when the conversation width runs out,
  // rather than inserting a fixed line break every twelve minutes.
  function dotsFor(minuteCount) {
    return Array(minuteCount).fill("•").join(" ");
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

  function scanRegion(root, includeRoot = false) {
    const badged = Array.from(root.querySelectorAll(`[${BADGE}]`));
    if (includeRoot && root.hasAttribute(BADGE)) badged.unshift(root);
    for (const element of badged) {
      const parsed = durationFrom(element.textContent) ||
        durationFrom(element.getAttribute("aria-label"));
      if (!parsed) restore(element);
      else annotate(element, parsed);
    }

    // Live durations may be split over nested text nodes rather than held in
    // the single text node that ChatGPT uses after a response completes.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!/^\s*Worked\b/i.test(node.nodeValue || "")) continue;
      let element = node.parentElement;
      while (element && (element !== root || includeRoot)) {
        if (element.closest(EXCLUDED)) break;
        const parsed = durationFrom(element.textContent);
        if (parsed) {
          annotate(element, parsed);
          break;
        }
        if (element === root) break;
        element = element.parentElement;
      }
    }

    // Some running status widgets update only their accessible name.
    const labelled = Array.from(root.querySelectorAll("[aria-label]"));
    if (includeRoot && root.hasAttribute("aria-label")) labelled.unshift(root);
    for (const element of labelled) {
      if (element.closest(EXCLUDED)) continue;
      const parsed = durationFrom(element.getAttribute("aria-label"));
      if (parsed) annotate(element, parsed);
    }
  }

  function scan() {
    scheduled = false;
    if (!context.active()) return;
    const main = document.querySelector("main");
    if (main) scanRegion(main);

    // Live activity may be mounted in a portal outside the chat's <main>.
    // Search only narrow status regions rather than scanning the whole page.
    for (const region of document.querySelectorAll('[role="status"], [aria-live="polite"], [aria-live="assertive"]')) {
      if (region === main || main?.contains(region) || region.closest("nav, aside, header, footer")) continue;
      scanRegion(region, true);
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
  observer.observe(document, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["aria-label"],
  });
  context.onStop(() => {
    stopped = true;
    observer.disconnect();
    chrome.storage.onChanged.removeListener(onSettingsChanged);
    for (const element of document.querySelectorAll(`[${BADGE}]`)) restore(element);
  });
  scheduleScan();
})();
