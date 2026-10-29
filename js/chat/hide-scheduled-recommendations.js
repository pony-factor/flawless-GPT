(() => {
  "use strict";

  const context = globalThis.__ghrcExtensionContext;
  if (context?.active() === false) return;

  const SETTING_KEY = "hideScheduledRecommendations";
  const MARKER = "data-ghrc-scheduled-recommendations";
  const STYLE_ID = "ghrc-hide-scheduled-recommendations-style";
  const HEADING_SELECTOR = 'h2, h3, h4, [role="heading"], button, [role="button"], span';
  const ACTION_SELECTOR = 'button, [role="button"]';
  const PROTECTED_SELECTOR = 'main, [role="main"], nav, form, article, [role="dialog"], [role="tablist"]';
  let enabled = false;
  let scanScheduled = false;

  function scheduledPath(pathname) {
    return /^\/(?:scheduled|tasks)(?:\/|$)/i.test(pathname || "");
  }

  function normalizedText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function findRecommendationGroup(label) {
    if (normalizedText(label?.textContent) !== "Recommended") return null;
    if (label.closest('nav, [role="menu"], [role="dialog"], [role="tablist"]')) return null;

    // The header has a dropdown button; don't confuse it with an actual
    // recommendation's plus button. Require another action in the same card group.
    for (let parent = label.parentElement, depth = 0; parent && depth < 7; parent = parent.parentElement, depth++) {
      if (parent.matches(PROTECTED_SELECTOR)) break;
      const text = normalizedText(parent.textContent);
      if (text.length > 2400) break; // Never hide a whole tasks page or task list.
      if (text.length < 45) continue;
      if (parent.querySelector('form, article, [role="tablist"], input, textarea')) break;
      const otherHeadings = [...parent.querySelectorAll('h1, h2, h3, h4, [role="heading"]')]
        .map((heading) => normalizedText(heading.textContent));
      if (otherHeadings.some((heading) => /^(?:active|paused|completed|your tasks|scheduled tasks)$/i.test(heading))) break;
      const actions = [...parent.querySelectorAll(ACTION_SELECTOR)];
      const cardActions = actions.filter((action) => !action.contains(label) && !label.contains(action));
      if (!cardActions.length || actions.length > 20) continue;
      return parent;
    }
    return null;
  }

  if (globalThis.__GHRC_TEST__) {
    Object.assign(globalThis.__GHRC_TEST__, { scheduledPath, findRecommendationGroup });
    return;
  }

  function ensureStyle() {
    if (!document.documentElement || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = "[" + MARKER + "] { display: none !important; }";
    document.documentElement.append(style);
  }

  function scan() {
    scanScheduled = false;
    if (context?.active() === false) return;
    const matches = new Set();
    if (enabled && scheduledPath(location.pathname)) {
      for (const label of document.querySelectorAll(HEADING_SELECTOR)) {
        const group = findRecommendationGroup(label);
        if (group) matches.add(group);
      }
    }
    for (const old of document.querySelectorAll("[" + MARKER + "]")) {
      if (!matches.has(old)) old.removeAttribute(MARKER);
    }
    for (const group of matches) group.setAttribute(MARKER, "");
  }

  function scheduleScan() {
    if (scanScheduled || context?.active() === false) return;
    scanScheduled = true;
    requestAnimationFrame(scan);
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    if (enabled) ensureStyle();
    scheduleScan();
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document, { childList: true, subtree: true, characterData: true });
  const routeChanged = () => scheduleScan();
  window.addEventListener("ghrc:route-change", routeChanged);
  window.addEventListener("popstate", routeChanged);
  context?.onStop(() => {
    observer.disconnect();
    window.removeEventListener("ghrc:route-change", routeChanged);
    window.removeEventListener("popstate", routeChanged);
    for (const old of document.querySelectorAll("[" + MARKER + "]")) old.removeAttribute(MARKER);
    document.getElementById(STYLE_ID)?.remove();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SETTING_KEY]) setEnabled(changes[SETTING_KEY].newValue ?? true);
  });
  void chrome.storage.local.get({ [SETTING_KEY]: true }).then((settings) => {
    if (context?.active() !== false) setEnabled(settings[SETTING_KEY]);
  }).catch((error) => context?.handleError(error));
})();
