(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (context?.active() === false) return;
  const SETTING_KEY = "blockVoicePrompts";
  const MARKER = "data-ghrc-voice-prompt";
  const STYLE_ID = "ghrc-block-voice-prompts-style";
  const PROMPT_ACTION = /^(?:try|explore|discover|give) voice(?: mode| a try)?$/i;
  const PROMPT_COPY = /talk it through, naturally|continue with voice mode|try voice mode|give voice a try/i;
  let enabled = false;
  let scheduled = false;

  function text(element) {
    return (element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function safeContainer(element) {
    return element
      && !element.matches("main, body, html, article")
      && !element.closest('[data-message-author-role], article')
      && !element.querySelector('[contenteditable="true"], textarea, [data-message-author-role]')
      && element.querySelectorAll("button").length <= 4
      && text(element).length < 600;
  }

  function promptContainer(button) {
    const action = text(button) || button.getAttribute("aria-label") || "";
    if (!PROMPT_ACTION.test(action)) return null;
    const panel = button.closest('aside, [role="dialog"], [role="alertdialog"]');
    if (safeContainer(panel)) return panel;
    let ancestor = button.parentElement;
    for (let depth = 0; ancestor && depth < 5; depth++, ancestor = ancestor.parentElement) {
      if (safeContainer(ancestor) && PROMPT_COPY.test(text(ancestor))) return ancestor;
    }
    return null;
  }

  function ensureStyle() {
    if (!document.documentElement || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `[${MARKER}] { display: none !important; }`;
    document.documentElement.append(style);
  }

  function scan() {
    scheduled = false;
    if (!enabled || context?.active() === false) return;
    ensureStyle();
    const prompts = new Set();
    for (const button of document.querySelectorAll('button, [role="button"]')) {
      const panel = promptContainer(button);
      if (panel) prompts.add(panel);
    }
    for (const panel of document.querySelectorAll('aside, [role="dialog"], [role="alertdialog"]')) {
      if (safeContainer(panel) && PROMPT_COPY.test(text(panel))) prompts.add(panel);
    }
    for (const panel of document.querySelectorAll(`[${MARKER}]`)) {
      if (!prompts.has(panel)) panel.removeAttribute(MARKER);
    }
    for (const panel of prompts) panel.setAttribute(MARKER, "");
  }

  function scheduleScan() {
    if (!enabled || scheduled || context?.active() === false) return;
    scheduled = true;
    requestAnimationFrame(scan);
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    if (enabled) scan();
    else document.querySelectorAll(`[${MARKER}]`).forEach((panel) => panel.removeAttribute(MARKER));
  }

  const observer = new MutationObserver(scheduleScan);
  context?.onStop(() => observer.disconnect());
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "role"],
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SETTING_KEY]) setEnabled(changes[SETTING_KEY].newValue);
  });
  void chrome.storage.local.get({ [SETTING_KEY]: false }).then((settings) => {
    if (context?.active() !== false) setEnabled(settings[SETTING_KEY]);
  }).catch(error => context?.handleError(error));
})();
