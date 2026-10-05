(() => {
  const SETTING_KEY = "disableWorkMode";
  const ROOT_ATTR = "data-ghrc-disable-work-mode";
  const CONTROL_ATTR = "data-ghrc-work-mode-control";
  const SELECTOR_ATTR = "data-ghrc-work-mode-selector";
  const CONTROL_SELECTOR = [
    "button",
    "a[href]",
    "label",
    '[role="button"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="radio"]',
    '[role="tab"]',
  ].join(", ");
  const WORK_LABEL = /^(?:chatgpt\s+)?work(?:\s+mode)?$/i;
  const CHAT_LABEL = /^(?:chatgpt\s+)?chat(?:\s+mode)?$/i;
  const MAX_CHAT_SELECTION_ATTEMPTS = 3;
  let enabled = false;
  let scanScheduled = false;
  let selectingChat = false;
  let needsChatSelection = false;
  let chatSelectionAttempts = 0;

  function normalizedText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function labelledByText(control) {
    const ids = normalizedText(control.getAttribute("aria-labelledby")).split(" ");
    if (!ids[0]) return "";
    return normalizedText(ids.map((id) => document.getElementById(id)?.textContent || "").join(" "));
  }

  function controlLabel(control) {
    return normalizedText(control.getAttribute("aria-label"))
      || labelledByText(control)
      || normalizedText(control.getAttribute("title"))
      || normalizedText(control.textContent);
  }

  function isWorkControl(control) {
    return control instanceof Element
      && control.matches(CONTROL_SELECTOR)
      && WORK_LABEL.test(controlLabel(control));
  }

  function modeSelectorFor(workControl) {
    const explicitGroup = workControl.closest('[role="tablist"], [role="radiogroup"], [role="group"]');
    if (
      explicitGroup
      && [...explicitGroup.querySelectorAll(CONTROL_SELECTOR)]
        .some((control) => CHAT_LABEL.test(controlLabel(control)))
    ) {
      return explicitGroup;
    }

    let ancestor = workControl.parentElement;
    for (let depth = 0; ancestor && depth < 3; depth += 1) {
      const controls = [...ancestor.querySelectorAll(CONTROL_SELECTOR)];
      if (controls.some((control) => CHAT_LABEL.test(controlLabel(control)))) return ancestor;
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  function findChatControl(workControl) {
    return [...(modeSelectorFor(workControl)?.querySelectorAll(CONTROL_SELECTOR) || [])]
      .find((control) => control !== workControl && CHAT_LABEL.test(controlLabel(control))) || null;
  }

  function pageAppearsToBeWorkMode() {
    if ([...document.querySelectorAll(CONTROL_SELECTOR)].some((control) =>
      isWorkControl(control) && ["aria-pressed", "aria-selected", "aria-checked"]
        .some((attribute) => control.getAttribute(attribute) === "true")
    )) return true;
    return [...document.querySelectorAll("[placeholder], [data-placeholder], [aria-label]")]
      .some((element) => [
        element.getAttribute("placeholder"),
        element.getAttribute("data-placeholder"),
        element.getAttribute("aria-label"),
      ].some((label) => /^work (?:on anything|with chatgpt)$/i.test(normalizedText(label))));
  }

  function selectChat(chatControl) {
    selectingChat = true;
    try {
      chatControl.click();
    } finally {
      selectingChat = false;
    }
  }

  function disableControl(control) {
    const selector = modeSelectorFor(control);
    if (selector) selector.setAttribute(SELECTOR_ATTR, "true");
    control.setAttribute(CONTROL_ATTR, "true");
    return findChatControl(control);
  }

  function scanControls() {
    scanScheduled = false;
    if (!enabled || !document.documentElement) return;
    document.documentElement.setAttribute(ROOT_ATTR, "true");
    let chatControl = null;
    document.querySelectorAll(CONTROL_SELECTOR).forEach((control) => {
      if (!isWorkControl(control)) return;
      const matchingChatControl = disableControl(control);
      chatControl ||= matchingChatControl;
    });
    const shouldSelectChat = needsChatSelection || pageAppearsToBeWorkMode();
    if (
      chatControl
      && shouldSelectChat
      && chatSelectionAttempts < MAX_CHAT_SELECTION_ATTEMPTS
    ) {
      needsChatSelection = false;
      chatSelectionAttempts += 1;
      selectChat(chatControl);
    }
  }

  function scheduleScan() {
    if (!enabled || scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(scanControls);
  }

  function setEnabled(nextEnabled) {
    enabled = nextEnabled;
    needsChatSelection = enabled;
    chatSelectionAttempts = 0;
    if (!document.documentElement) {
      requestAnimationFrame(() => setEnabled(nextEnabled));
      return;
    }

    document.documentElement.toggleAttribute(ROOT_ATTR, enabled);
    if (enabled) {
      scheduleScan();
      return;
    }

    document.querySelectorAll(`[${CONTROL_ATTR}], [${SELECTOR_ATTR}]`).forEach((element) => {
      element.removeAttribute(CONTROL_ATTR);
      element.removeAttribute(SELECTOR_ATTR);
    });
  }

  function blockWorkSelection(event) {
    if (!enabled || selectingChat || !(event.target instanceof Element)) return;
    if (event.target.closest(`[${SELECTOR_ATTR}]`)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const control = event.target.closest(CONTROL_SELECTOR);
    const group = control?.closest('[role="tablist"], [role="radiogroup"], [role="group"]');
    const navigatesModeGroup = event.type === "keydown"
      && ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(event.key)
      && group?.querySelector(`[${CONTROL_ATTR}]`);
    if (!isWorkControl(control) && !navigatesModeGroup) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  for (const eventName of ["pointerdown", "mousedown", "click", "keydown"]) {
    document.addEventListener(eventName, blockWorkSelection, true);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[SETTING_KEY]) return;
    setEnabled(Boolean(changes[SETTING_KEY].newValue));
  });

  new MutationObserver(scheduleScan).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-pressed", "aria-selected", "aria-checked", "aria-label", "placeholder", "data-placeholder"],
  });
  void chrome.storage.local.get({ [SETTING_KEY]: false }).then((settings) => {
    setEnabled(Boolean(settings[SETTING_KEY]));
  });
})();
