(() => {
  "use strict";

  const context = globalThis.__ghrcExtensionContext;
  if (context?.active() === false) return;

  const SETTING_KEY = "hideUpgradePromotions";
  const MARKER = "data-ghrc-upgrade-promotion";
  const STYLE_ID = "ghrc-hide-upgrade-promotions-style";
  const UPGRADE_ACTION = /^(?:upgrade to (?:plus|pro)|get (?:plus|pro)|try (?:plus|pro)|(?:view|see) (?:all )?plans)$/i;
  const PROMOTIONAL_COPY = /\b(?:built for work like this|stronger judgment|more polished results|upgrade to (?:plus|pro) for|unlock (?:more|advanced|premium)|(?:get|enjoy) more with (?:plus|pro)|try (?:plus|pro) for)\b/i;
  const PROTECTED_CONTENT = 'article, [data-message-author-role], [data-content-search-unit-key], [data-testid^="conversation-turn"], form, textarea, [contenteditable="true"], [role="textbox"]';
  let enabled = false;
  let scanScheduled = false;

  function normalizedText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function controlLabel(element) {
    return normalizedText(element.textContent)
      || normalizedText(element.getAttribute("aria-label"))
      || normalizedText(element.getAttribute("title"));
  }

  function isPromotionPanel(element) {
    if (!element || element.matches('html, body, main, article, form, nav, header, footer, [role="navigation"]')) return false;
    if (element.closest('article, [data-message-author-role], [data-content-search-unit-key], [data-testid^="conversation-turn"], [role="dialog"], [role="alertdialog"]')) return false;
    if (element.querySelector(PROTECTED_CONTENT)) return false;
    const copy = normalizedText(element.textContent);
    if (copy.length < 25 || copy.length > 700 || !PROMOTIONAL_COPY.test(copy)) return false;
    return element.querySelectorAll('button, [role="button"]').length <= 5;
  }

  function findPromotionPanel(action) {
    if (!UPGRADE_ACTION.test(controlLabel(action))) return null;
    if (action.closest('article, [data-message-author-role], [data-content-search-unit-key], [data-testid^="conversation-turn"], [role="dialog"], [role="alertdialog"]')) return null;
    let match = null;
    let ancestor = action.parentElement;
    for (let depth = 0; ancestor && depth < 9; depth++, ancestor = ancestor.parentElement) {
      if (!isPromotionPanel(ancestor)) {
        if (match) break;
        continue;
      }
      // Prefer the enclosing card rather than a single text/button row.
      match = ancestor;
    }
    return match;
  }

  if (globalThis.__GHRC_TEST__) {
    Object.assign(globalThis.__GHRC_TEST__, { isPromotionPanel, findPromotionPanel });
    return;
  }

  function ensureStyle() {
    if (!document.documentElement || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = '[' + MARKER + '] { display: none !important; }';
    document.documentElement.append(style);
  }

  function scan() {
    scanScheduled = false;
    if (!enabled || context?.active() === false) return;
    ensureStyle();
    const matching = new Set();
    for (const action of document.querySelectorAll('button, a, [role="button"]')) {
      const panel = findPromotionPanel(action);
      if (panel) matching.add(panel);
    }
    for (const previous of document.querySelectorAll('[' + MARKER + ']')) {
      if (!matching.has(previous)) previous.removeAttribute(MARKER);
    }
    for (const panel of matching) panel.setAttribute(MARKER, "");
  }

  function scheduleScan() {
    if (!enabled || scanScheduled || context?.active() === false) return;
    scanScheduled = true;
    requestAnimationFrame(scan);
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    if (!enabled) {
      for (const panel of document.querySelectorAll('[' + MARKER + ']')) panel.removeAttribute(MARKER);
      return;
    }
    ensureStyle();
    scheduleScan();
  }

  const observer = new MutationObserver(scheduleScan);
  context?.onStop(() => {
    observer.disconnect();
    for (const panel of document.querySelectorAll('[' + MARKER + ']')) panel.removeAttribute(MARKER);
    document.getElementById(STYLE_ID)?.remove();
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "title", "role"],
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SETTING_KEY]) setEnabled(changes[SETTING_KEY].newValue);
  });

  void chrome.storage.local.get({ [SETTING_KEY]: false }).then((settings) => {
    if (context?.active() !== false) setEnabled(settings[SETTING_KEY]);
  }).catch((error) => context?.handleError(error));
})();
