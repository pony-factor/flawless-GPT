(() => {
  "use strict";

  const HIDDEN = "data-ghrc-stale-rate-limit";
  const TURN = "[data-testid^=\"conversation-turn-\"], [data-turn]";
  const ASSISTANT = "[data-message-author-role=\"assistant\"], [data-content-search-unit-key$=\":assistant\"], [data-turn=\"assistant\"]";
  const EXCLUDED = "nav, aside, header, footer, [role=\"dialog\"], [role=\"alertdialog\"], [data-message-author-role=\"user\"], [data-content-search-unit-key$=\":user\"], [data-turn=\"user\"], .markdown, .prose, pre, code, blockquote, textarea, input, [contenteditable=\"true\"]";
  const INTERACTIVE = "button, a[href], [role=\"button\"], input, textarea";

  function normalizedText(node) {
    return (node.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findDivider(label, root) {
    if (label.closest(EXCLUDED)) return null;
    let divider = null;
    for (let node = label; node && node !== root; node = node.parentElement) {
      if (node.matches(TURN) || node.matches(ASSISTANT) || normalizedText(node) !== "Rate limited") break;
      if (node.matches("div, [role=\"status\"], [role=\"separator\"]")
        && node.querySelector("svg") && !node.querySelector(INTERACTIVE)
        && (node.children.length >= 2 || node.matches('[role="status"], [role="separator"]'))) {
        divider = node;
      }
    }
    return divider;
  }

  function hasLaterResponse(divider, assistants) {
    return assistants.some(assistant => {
      if (assistant.contains(divider) || divider.contains(assistant)) return false;
      if (!(divider.compareDocumentPosition(assistant) & 4)) return false; // DOCUMENT_POSITION_FOLLOWING
      const text = normalizedText(assistant);
      // A later empty assistant placeholder or another interruption is not recovery.
      return Boolean(text && text !== "Rate limited");
    });
  }

  function findStaleDividers(root, doc) {
    const assistants = Array.from(root.querySelectorAll(ASSISTANT));
    const stale = new Set();
    const walker = doc.createTreeWalker(root, 4); // SHOW_TEXT
    let text;
    while ((text = walker.nextNode())) {
      if ((text.nodeValue || "").trim() !== "Rate limited") continue;
      const divider = text.parentElement && findDivider(text.parentElement, root);
      if (divider && hasLaterResponse(divider, assistants)) stale.add(divider);
    }
    return stale;
  }

  function synchronize(root, doc, enabled) {
    const stale = enabled && root ? findStaleDividers(root, doc) : new Set();
    for (const node of doc.querySelectorAll(`[${HIDDEN}]`)) {
      if (!stale.has(node)) node.removeAttribute(HIDDEN);
    }
    for (const node of stale) {
      if (!node.hasAttribute(HIDDEN)) node.setAttribute(HIDDEN, "");
    }
  }

  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;

  // Share the existing interruption-dismissal preference, but never dismiss
  // a current rate limit or remove React-owned elements from the conversation.
  const setting = "dismissHistoryRateLimitModal";
  let enabled = false;
  let preferenceUpdated = false;
  let stopped = false;
  let timer = null;

  function schedule() {
    if (stopped || timer !== null || !context.active()) return;
    timer = setTimeout(() => {
      timer = null;
      if (!context.active()) return;
      const root = document.querySelector('[aria-label="Conversation"]') || document.querySelector("main");
      synchronize(root, document, enabled);
    }, 150);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["data-message-author-role", "data-content-search-unit-key", "data-turn", "data-testid"],
  });

  function changed(changes, area) {
    if (area !== "local" || !changes[setting]) return;
    preferenceUpdated = true;
    enabled = Boolean(changes[setting].newValue);
    schedule();
  }
  chrome.storage.onChanged.addListener(changed);
  context.run(async () => {
    const settings = await chrome.storage.local.get({ [setting]: true });
    if (!preferenceUpdated && !stopped) {
      enabled = Boolean(settings[setting]);
      schedule();
    }
  });

  context.onStop(() => {
    stopped = true;
    observer.disconnect();
    clearTimeout(timer);
    chrome.storage.onChanged.removeListener(changed);
    synchronize(null, document, false);
  });
})();
