(() => {
  "use strict";
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const ATTRIBUTE = "data-ghrc-hide-share-label";
  const LABEL = "data-ghrc-share-label";
  const QUERY = '[data-testid="share-chat-button"], [data-testid="chat-header-share-button"], header button, #conversation-header button';
  let enabled = false;
  let scheduled = false;

  function scan() {
    scheduled = false;
    if (!enabled || !context.active()) return;
    for (const button of document.querySelectorAll(QUERY)) {
      if (button.textContent?.trim() !== "Share" || !button.querySelector("svg")) continue;
      // Keep the accessible button name when its visible text is hidden.
      if (!button.hasAttribute("aria-label") && !button.hasAttribute("aria-labelledby")) {
        button.setAttribute("aria-label", "Share");
      }
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      const labels = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.textContent.trim() === "Share" && !node.parentElement.closest(`svg, [${LABEL}]`)) {
          labels.push(node);
        }
      }
      for (const node of labels) {
        const label = document.createElement("span");
        label.setAttribute(LABEL, "");
        node.replaceWith(label);
        label.append(node);
      }
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
    scheduleScan();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.hideShareLabel && context.active()) {
      apply(changes.hideShareLabel.newValue);
    }
  });
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document, { childList: true, subtree: true, characterData: true });
  context.onStop(() => observer.disconnect());
  void context.run(async () => {
    const settings = await chrome.storage.local.get({ hideShareLabel: false });
    if (context.active()) apply(settings.hideShareLabel);
  });
})();
