(() => {
  "use strict";
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const ATTRIBUTE = "data-ghrc-hide-share-label";
  const BUTTON_MARKER = "data-ghrc-share-button";
  const QUERY = '[data-testid="share-chat-button"], [data-testid="chat-header-share-button"], header button, #conversation-header button';
  const markedButtons = new Set();
  let enabled = false;
  let scheduled = false;

  function isShareButton(button) {
    return button.textContent?.trim() === "Share" && Boolean(button.querySelector("svg"));
  }

  function clearMarkedButtons() {
    for (const button of markedButtons) button.removeAttribute(BUTTON_MARKER);
    markedButtons.clear();
  }

  function scan() {
    scheduled = false;
    if (!enabled || !context.active()) return;
    for (const button of markedButtons) {
      if (button.isConnected && isShareButton(button)) continue;
      button.removeAttribute(BUTTON_MARKER);
      markedButtons.delete(button);
    }
    for (const button of document.querySelectorAll(QUERY)) {
      if (!isShareButton(button)) continue;
      // CSS hides only the visible label. React retains ownership of its text
      // nodes, so opening the native Share dialog cannot break reconciliation.
      if (!button.hasAttribute("aria-label") && !button.hasAttribute("aria-labelledby")) {
        button.setAttribute("aria-label", "Share");
      }
      if (!button.hasAttribute(BUTTON_MARKER)) button.setAttribute(BUTTON_MARKER, "");
      markedButtons.add(button);
    }
  }

  function scheduleScan() {
    if (!enabled || scheduled || !context.active()) return;
    scheduled = true;
    requestAnimationFrame(scan);
  }

  function apply(value) {
    enabled = Boolean(value);
    document.documentElement?.toggleAttribute(ATTRIBUTE, enabled);
    if (enabled) scheduleScan();
    else clearMarkedButtons();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.hideShareLabel && context.active()) {
      apply(changes.hideShareLabel.newValue);
    }
  });
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document, { childList: true, subtree: true, characterData: true });
  context.onStop(() => {
    observer.disconnect();
    clearMarkedButtons();
    document.documentElement?.removeAttribute(ATTRIBUTE);
  });
  void context.run(async () => {
    const settings = await chrome.storage.local.get({ hideShareLabel: false });
    if (context.active()) apply(settings.hideShareLabel);
  });
})();
