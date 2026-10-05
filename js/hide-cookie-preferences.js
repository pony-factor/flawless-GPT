(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (context?.active() === false) return;
  const SETTING_KEY = "hideCookiePreferences";
  const MARKER_ATTR = "data-ghrc-cookie-preferences-link";
  const STYLE_ID = "ghrc-hide-cookie-preferences-style";
  let enabled = false;
  let scanScheduled = false;

  function normalizedText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function isCookiePreferencesLink(element) {
    return element instanceof HTMLAnchorElement
      && normalizedText(element.textContent).toLowerCase() === "cookie preferences";
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
    for (const link of document.querySelectorAll("a")) {
      link.toggleAttribute(MARKER_ATTR, isCookiePreferencesLink(link));
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
      document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((link) => {
        link.removeAttribute(MARKER_ATTR);
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

  void chrome.storage.local.get({ [SETTING_KEY]: false }).then((settings) => {
    if (context?.active() === false) return;
    setEnabled(settings[SETTING_KEY]);
  }).catch(error => context?.handleError(error));
})();
