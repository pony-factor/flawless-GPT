(() => {
  "use strict";
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;

  const SETTING_KEY = "disableManualWebSearch";
  const ROOT_ATTR = "data-ghrc-disable-manual-web-search";
  const CONTROL_ATTR = "data-ghrc-manual-web-search-control";
  const CONTROL_SELECTOR = 'button, [role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="radio"]';
  const TOOL_LABEL = /^(?:search(?: the web)?|web search|browse(?: the web)?|find on the web)$/i;
  const clickedToDeselect = new WeakSet();
  let enabled = false;
  let scanScheduled = false;
  let deselecting = false;

  function isManualSearchControl(element) {
    if (!(element instanceof Element) || !element.matches(CONTROL_SELECTOR)) return false;
    if (element.closest('nav, aside, header, [role="navigation"], [role="search"]')) return false;
    if (!element.closest('form, [data-type="unified-composer"], [role="menu"], [role="listbox"], [role="dialog"]')) return false;
    const label = [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent]
      .map(value => (value || "").replace(/\s+/g, " ").trim())
      .find(value => TOOL_LABEL.test(value));
    return Boolean(label);
  }

  function isSelected(element) {
    return ["aria-pressed", "aria-selected", "aria-checked"].some(key => element.getAttribute(key) === "true");
  }

  function scan() {
    scanScheduled = false;
    if (!enabled || !context.active()) return;
    document.querySelectorAll(CONTROL_SELECTOR).forEach((control) => {
      if (!isManualSearchControl(control)) return;
      // Ask the native UI to release an explicitly selected Search tool before
      // hiding it. Avoid repeated clicks if ChatGPT doesn't support toggling.
      if (isSelected(control) && !clickedToDeselect.has(control)) {
        clickedToDeselect.add(control);
        deselecting = true;
        try { control.click(); } finally { deselecting = false; }
      }
      if (!isSelected(control)) clickedToDeselect.delete(control);
      control.setAttribute(CONTROL_ATTR, "true");
    });
  }

  function scheduleScan() {
    if (!enabled || scanScheduled || !context.active()) return;
    scanScheduled = true;
    requestAnimationFrame(scan);
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    document.documentElement.toggleAttribute(ROOT_ATTR, enabled);
    if (enabled) scheduleScan();
    else document.querySelectorAll('[' + CONTROL_ATTR + ']').forEach(control => control.removeAttribute(CONTROL_ATTR));
  }

  function blockManualSelection(event) {
    if (!enabled || deselecting || !(event.target instanceof Element)) return;
    const control = event.target.closest(CONTROL_SELECTOR);
    if (!isManualSearchControl(control)) return;
    if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  for (const eventName of ["pointerdown", "click", "keydown"]) {
    document.addEventListener(eventName, blockManualSelection, true);
  }
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-label", "aria-pressed", "aria-selected", "aria-checked", "title", "role"],
  });

  const onSettingsChange = (changes, area) => {
    if (area === "local" && changes[SETTING_KEY]) setEnabled(changes[SETTING_KEY].newValue);
  };
  chrome.storage.onChanged.addListener(onSettingsChange);
  void chrome.storage.local.get({ [SETTING_KEY]: false }).then(settings => {
    if (context.active()) setEnabled(settings[SETTING_KEY]);
  });
  context.onStop(() => {
    observer.disconnect();
    chrome.storage.onChanged.removeListener(onSettingsChange);
    document.documentElement.removeAttribute(ROOT_ATTR);
    document.querySelectorAll('[' + CONTROL_ATTR + ']').forEach(control => control.removeAttribute(CONTROL_ATTR));
  });
})();