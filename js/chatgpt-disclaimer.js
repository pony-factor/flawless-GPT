(() => {
  "use strict";
  const context = globalThis.__ghrcExtensionContext;
  if (context?.active() === false) return;
  const SETTING_KEY = "showChatgptDisclaimer";
  const MARKER = "data-ghrc-chatgpt-disclaimer";
  const STYLE_ID = "ghrc-chatgpt-disclaimer-style";
  let shown = false;
  let scheduled = false;

  function scan() {
    scheduled = false;
    if (!document.documentElement || context?.active() === false) return;
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `html:not([data-ghrc-show-disclaimer]) [${MARKER}] { display: none !important; }`;
      document.documentElement.append(style);
    }
    document.documentElement.toggleAttribute("data-ghrc-show-disclaimer", shown);
    for (const node of document.querySelectorAll("div, p, span")) {
      if (node.closest('article, [data-message-author-role], [data-content-search-unit-key], [contenteditable], [role="dialog"]')) continue;
      const text = node.textContent.replace(/\s+/g, " ").trim();
      const matches = /^ChatGPT can make mistakes\b/i.test(text) && text.length < 300
        && !node.querySelector('form, textarea, [contenteditable], [role="textbox"]');
      if (node.hasAttribute(MARKER) !== matches) node.toggleAttribute(MARKER, matches);
    }
  }

  function scheduleScan() {
    if (scheduled || context?.active() === false) return;
    scheduled = true;
    requestAnimationFrame(scan);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTING_KEY]) return;
    shown = Boolean(changes[SETTING_KEY].newValue);
    scheduleScan();
  });
  const observer = new MutationObserver(scheduleScan);
  context?.onStop(() => observer.disconnect());
  observer.observe(document, { childList: true, subtree: true, characterData: true });
  void chrome.storage.local.get({ [SETTING_KEY]: false }).then(settings => {
    if (context?.active() === false) return;
    shown = Boolean(settings[SETTING_KEY]);
    scheduleScan();
  }).catch(error => context?.handleError(error));
})();
