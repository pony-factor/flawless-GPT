(() => {
  "use strict";

  const context = globalThis.__ghrcExtensionContext;
  if (context?.active() === false) return;

  const SETTING_KEY = "hideUsageCard";
  const MARKER_ATTR = "data-ghrc-usage-card";
  const STYLE_ID = "ghrc-hide-usage-card-style";
  const USAGE_RE = /\b\d+(?:\.\d+)?%\s+usage remaining\b/i;
  let enabled = true;
  let scanScheduled = false;

  function normalizedText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function controlLabel(element) {
    return normalizedText(
      element.getAttribute?.("aria-label")
      || element.getAttribute?.("title")
      || element.textContent,
    );
  }

  function hasControl(root, label) {
    return [...root.querySelectorAll("button, a, [role=\"button\"]")]
      .some((element) => controlLabel(element).toLowerCase() === label);
  }

  function findUsageCard(control) {
    let candidate = control.parentElement;
    for (let depth = 0; candidate && depth < 10; depth += 1, candidate = candidate.parentElement) {
      const text = normalizedText(candidate.textContent);
      if (text.length > 1200) continue;
      if (!USAGE_RE.test(text)) continue;
      if (!hasControl(candidate, "add credits") || !hasControl(candidate, "upgrade")) continue;
      return candidate;
    }
    return null;
  }

  function ensureStyle() {
    if (!document.documentElement || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `[${MARKER_ATTR}] { display: none !important; }`;
    document.documentElement.append(style);
  }

  function scan() {
    scanScheduled = false;
    if (!enabled || context?.active() === false) return;

    ensureStyle();
    for (const control of document.querySelectorAll("button, a, [role=\"button\"]")) {
      if (controlLabel(control).toLowerCase() !== "add credits") continue;
      const card = findUsageCard(control);
      if (card) card.setAttribute(MARKER_ATTR, "");
    }
  }

  function scheduleScan() {
    if (!enabled || scanScheduled || context?.active() === false) return;
    scanScheduled = true;
    requestAnimationFrame(scan);
  }

  function setEnabled(nextEnabled) {
    enabled = Boolean(nextEnabled);
    ensureStyle();
    if (!enabled) {
      document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((element) => {
        element.removeAttribute(MARKER_ATTR);
      });
      return;
    }
    scheduleScan();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[SETTING_KEY]) return;
    setEnabled(changes[SETTING_KEY].newValue);
  });

  const observer = new MutationObserver(scheduleScan);
  context?.onStop(() => observer.disconnect());
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  void chrome.storage.local.get({ [SETTING_KEY]: true }).then((settings) => {
    if (context?.active() === false) return;
    setEnabled(settings[SETTING_KEY] !== false);
  }).catch((error) => context?.handleError(error));
})();
