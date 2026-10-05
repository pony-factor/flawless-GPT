(() => {
  const EXTERNAL_WARNING_SETTING_KEY = "skipExternalSiteWarning";
  const HISTORY_MODAL_SETTING_KEY = "dismissHistoryRateLimitModal";
  const STRIP_UTM_TRACKING_SETTING_KEY = "stripUtmTracking";
  const MODAL_ID = "modal-conversation-history-rate-limit";
  const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';
  const EXTERNAL_DIALOG_TITLE = "External site";
  const OPEN_LINK_LABEL = "Open link";
  const HISTORY_MODAL_DISMISS_LABEL = "Got it";
  const handledExternalDialogs = new WeakSet();
  const handledHistoryModals = new WeakSet();
  let externalWarningEnabled = false;
  let historyModalEnabled = false;
  let stripUtmTrackingEnabled = false;
  let modalWasSuppressed = false;
  let newTabsEnabled = true;
  let splitViewEnabled = false;
  let previewPanel = null;
  let previewLink = null;

  function normalizedText(element) {
    return (element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findExactControl(dialog, label) {
    return [...dialog.querySelectorAll('button, a[href], [role="button"]')]
      .find((control) => normalizedText(control) === label);
  }

  function approveExternalSiteDialog(dialog) {
    if (!externalWarningEnabled || handledExternalDialogs.has(dialog)) return;

    const title = [...dialog.querySelectorAll('h1, h2, h3, h4, [role="heading"]')]
      .find((heading) => normalizedText(heading) === EXTERNAL_DIALOG_TITLE);
    const openLink = findExactControl(dialog, OPEN_LINK_LABEL);
    if (!title || !openLink) return;

    handledExternalDialogs.add(dialog);
    openLink.click();
  }

  function inspectDialogs(node) {
    if (!externalWarningEnabled || !(node instanceof Element)) return;
    const dialogs = new Set();
    if (node.matches(DIALOG_SELECTOR)) dialogs.add(node);
    const containingDialog = node.closest(DIALOG_SELECTOR);
    if (containingDialog) dialogs.add(containingDialog);
    for (const dialog of node.querySelectorAll(DIALOG_SELECTOR)) dialogs.add(dialog);
    for (const dialog of dialogs) approveExternalSiteDialog(dialog);
  }

  function suppressHistoryRateLimitModal() {
    if (!historyModalEnabled) return;
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;

    modalWasSuppressed = true;
    const dismissControl = findExactControl(modal, HISTORY_MODAL_DISMISS_LABEL);
    if (dismissControl && !handledHistoryModals.has(modal)) {
      handledHistoryModals.add(modal);
      dismissControl.click();
    }
    modal.style.setProperty("display", "none", "important");
    for (const element of [document.documentElement, document.body]) {
      if (!element) continue;
      element.style.setProperty("overflow", "auto", "important");
      element.style.setProperty("pointer-events", "auto", "important");
      element.style.setProperty("touch-action", "auto", "important");
    }
    if (document.body) {
      document.body.removeAttribute("data-scroll-locked");
      document.body.removeAttribute("data-scroll-lock");
      document.body.removeAttribute("inert");
    }
    for (const element of document.querySelectorAll("body > div")) {
      if (element === modal) continue;
      if (getComputedStyle(element).pointerEvents === "none") {
        element.style.setProperty("pointer-events", "auto", "important");
      }
    }
  }

  function stripTrackingFromLink(link) {
    if (!stripUtmTrackingEnabled || !(link instanceof HTMLAnchorElement)) return;

    let url;
    try {
      url = new URL(link.href);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(url.protocol)) return;

    const trackingParameters = [...url.searchParams.keys()]
      .filter((name) => name.toLowerCase().startsWith("utm_"));
    if (!trackingParameters.length) return;

    trackingParameters.forEach((name) => url.searchParams.delete(name));
    link.href = url.href;
  }

  function stripTrackingFromLinks(node) {
    if (!stripUtmTrackingEnabled || !(node instanceof Element)) return;
    if (node.matches("a[href]")) stripTrackingFromLink(node);
    node.querySelectorAll("a[href]").forEach(stripTrackingFromLink);
  }

  function isPlainPrimaryActivation(event) {
    return event.button === 0
      && !event.metaKey
      && !event.ctrlKey
      && !event.shiftKey
      && !event.altKey;
  }

  function openExternalLink(event, link) {
    if (
      (!externalWarningEnabled && !newTabsEnabled && !splitViewEnabled)
      || !isPlainPrimaryActivation(event)
      || !(link instanceof HTMLAnchorElement)
      || link.hasAttribute("download")
      || link.closest("#github-repositories-for-chatgpt, #ghrc-highlighted-pages, #ghrc-link-preview")
    ) return false;

    let url;
    try {
      url = new URL(link.href, window.location.href);
    } catch {
      return false;
    }
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.origin === window.location.origin
    ) return false;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (splitViewEnabled) showLinkPreview(url.href, link);
    else if (newTabsEnabled) window.open(url.href, "_blank", "noopener,noreferrer");
    else window.location.assign(url.href);
    return true;
  }

  function closeLinkPreview() {
    previewPanel?.remove();
    previewPanel = null;
    document.documentElement.removeAttribute("data-ghrc-link-preview");
    previewLink?.focus();
    previewLink = null;
  }

  function showLinkPreview(href, link) {
    closeLinkPreview();
    previewLink = link;
    const panel = document.createElement("aside");
    panel.id = "ghrc-link-preview";
    panel.setAttribute("aria-label", "Linked website preview");
    const header = document.createElement("header");
    const url = new URL(href);
    const destination = document.createElement("a");
    destination.className = "ghrc-preview-destination";
    destination.href = href;
    destination.target = "_blank";
    destination.rel = "noopener noreferrer";
    const favicon = document.createElement("img");
    favicon.className = "ghrc-preview-favicon";
    favicon.src = new URL("/favicon.ico", url.origin).href;
    favicon.alt = "";
    favicon.referrerPolicy = "no-referrer";
    favicon.addEventListener("error", () => favicon.remove());
    const hostname = document.createElement("span");
    hostname.textContent = url.hostname.replace(/^www\./i, "");
    destination.append(favicon, hostname);
    destination.title = href;
    const copy = document.createElement("button");
    copy.className = "ghrc-preview-control";
    copy.type = "button";
    copy.title = "Copy link";
    copy.setAttribute("aria-label", "Copy link");
    copy.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>';
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(href);
      } catch {
        // Leave the preview open if clipboard access is unavailable.
      }
    });
    const open = document.createElement("a");
    open.className = "ghrc-preview-control";
    open.href = href;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.title = "Open in new tab";
    open.setAttribute("aria-label", "Open in new tab");
    open.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7M21 3l-11 11M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></svg>';
    for (const control of [destination, open]) {
      control.addEventListener("click", (event) => {
        if (!isPlainPrimaryActivation(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        window.open(href, "_blank", "noopener,noreferrer");
      });
    }
    const close = document.createElement("button");
    close.className = "ghrc-preview-control";
    close.type = "button";
    close.textContent = "×";
    close.title = "Close website preview";
    close.setAttribute("aria-label", "Close website preview");
    close.addEventListener("click", closeLinkPreview);
    header.append(destination, copy, open, close);
    const frame = document.createElement("iframe");
    frame.title = "Website preview: " + new URL(href).hostname;
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
    frame.referrerPolicy = "no-referrer";
    frame.src = href;
    panel.append(header, frame);
    previewPanel = panel;
    document.body.append(panel);
    document.documentElement.setAttribute("data-ghrc-link-preview", "");
    close.focus();
  }

  function preserveNativeScroll(event) {
    if (!historyModalEnabled || !modalWasSuppressed) return;
    const modal = document.getElementById(MODAL_ID);
    if (!modal || getComputedStyle(modal).display !== "none") return;
    event.stopImmediatePropagation();
  }

  window.addEventListener("wheel", preserveNativeScroll, { capture: true, passive: true });
  window.addEventListener("touchmove", preserveNativeScroll, { capture: true, passive: true });

  function inspectMutationNode(node) {
    if (!(node instanceof Element)) return;
    inspectDialogs(node);
    suppressHistoryRateLimitModal();
    stripTrackingFromLinks(node);
  }

  function watchChatGPTInterruptions() {
    if (!document.documentElement) {
      requestAnimationFrame(watchChatGPTInterruptions);
      return;
    }
    inspectDialogs(document.documentElement);
    suppressHistoryRateLimitModal();
    stripTrackingFromLinks(document.documentElement);
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        inspectMutationNode(mutation.target);
        for (const node of mutation.addedNodes) inspectMutationNode(node);
      }
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
  }

  async function loadSettings() {
    const settings = await chrome.storage.local.get({
      [EXTERNAL_WARNING_SETTING_KEY]: true,
      openExternalLinksInNewTabs: true,
      openExternalLinksInSplitView: false,
      [HISTORY_MODAL_SETTING_KEY]: true,
      [STRIP_UTM_TRACKING_SETTING_KEY]: true,
    });
    newTabsEnabled = settings.openExternalLinksInNewTabs !== false;
    splitViewEnabled = Boolean(settings.openExternalLinksInSplitView);
    externalWarningEnabled = Boolean(settings[EXTERNAL_WARNING_SETTING_KEY]);
    historyModalEnabled = Boolean(settings[HISTORY_MODAL_SETTING_KEY]);
    stripUtmTrackingEnabled = Boolean(settings[STRIP_UTM_TRACKING_SETTING_KEY]);
    if (document.documentElement) {
      inspectDialogs(document.documentElement);
      suppressHistoryRateLimitModal();
      stripTrackingFromLinks(document.documentElement);
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.openExternalLinksInNewTabs) {
      newTabsEnabled = changes.openExternalLinksInNewTabs.newValue !== false;
    }
    if (changes.openExternalLinksInSplitView) {
      splitViewEnabled = Boolean(changes.openExternalLinksInSplitView.newValue);
      if (!splitViewEnabled) closeLinkPreview();
    }
    if (changes[EXTERNAL_WARNING_SETTING_KEY]) {
      externalWarningEnabled = Boolean(changes[EXTERNAL_WARNING_SETTING_KEY].newValue);
      if (externalWarningEnabled && document.documentElement) inspectDialogs(document.documentElement);
    }
    if (changes[HISTORY_MODAL_SETTING_KEY]) {
      historyModalEnabled = Boolean(changes[HISTORY_MODAL_SETTING_KEY].newValue);
      if (historyModalEnabled) suppressHistoryRateLimitModal();
    }
    if (changes[STRIP_UTM_TRACKING_SETTING_KEY]) {
      stripUtmTrackingEnabled = Boolean(changes[STRIP_UTM_TRACKING_SETTING_KEY].newValue);
      if (stripUtmTrackingEnabled && document.documentElement) {
        stripTrackingFromLinks(document.documentElement);
      }
    }
  });

  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    stripTrackingFromLink(link);
    openExternalLink(event, link);
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && previewPanel) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeLinkPreview();
    }
  }, true);

  watchChatGPTInterruptions();
  setInterval(suppressHistoryRateLimitModal, 100);
  void loadSettings();
})();
