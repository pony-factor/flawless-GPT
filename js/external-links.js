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
  let splitViewOnLeft = false;
  let previewPanel = null;
  let previewLink = null;
  let nativeSplitRequest = 0;
  let previewWatch = null;
  let previewWidthPx = null;
  const linkActions = new WeakMap();

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

  function externalUrlForLink(link) {
    if (
      !(link instanceof HTMLAnchorElement)
      || link.hasAttribute("download")
      || link.closest("#github-repositories-for-chatgpt, #ghrc-highlighted-pages, #ghrc-link-preview, .ghrc-link-actions")
    ) return null;

    let url;
    try {
      url = new URL(link.href, window.location.href);
    } catch {
      return null;
    }
    if (!["http:", "https:"].includes(url.protocol) || url.origin === window.location.origin) return null;
    return url;
  }

  function openExternalLink(event, link) {
    if (
      (!externalWarningEnabled && !newTabsEnabled)
      || !isPlainPrimaryActivation(event)
    ) return false;

    const url = externalUrlForLink(link);
    if (!url) return false;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (newTabsEnabled) window.open(url.href, "_blank", "noopener,noreferrer");
    else window.location.assign(url.href);
    return true;
  }

  function closeLinkPreview(restoreFocus = true) {
    nativeSplitRequest += 1;
    if (previewWatch) {
      void chrome.runtime.sendMessage({ type: "unwatch-link-preview", previewId: previewWatch.id }).catch(() => {});
      previewWatch = null;
    }
    previewPanel?.remove();
    previewPanel = null;
    document.documentElement.removeAttribute("data-ghrc-link-preview");
    if (restoreFocus && previewLink?.isConnected) {
      try {
        previewLink.focus({ preventScroll: true });
      } catch {
        previewLink.focus();
      }
    }
    previewLink = null;
  }

  function preserveReadingPosition(anchor, change) {
    const before = anchor?.isConnected ? anchor.getBoundingClientRect().top : null;
    change();
    if (before === null) return;
    requestAnimationFrame(() => {
      if (!anchor?.isConnected) return;
      const delta = anchor.getBoundingClientRect().top - before;
      if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
    });
  }

  function previewWidthBounds() {
    const min = Math.min(360, Math.max(260, window.innerWidth * 0.35));
    const max = Math.max(min, window.innerWidth - Math.min(420, window.innerWidth * 0.35));
    return { min, max };
  }

  function clampPreviewWidth(value) {
    const { min, max } = previewWidthBounds();
    return Math.min(max, Math.max(min, value));
  }

  function applyPreviewWidth() {
    if (!Number.isFinite(previewWidthPx)) {
      document.documentElement.style.removeProperty("--ghrc-preview-width");
      return;
    }
    previewWidthPx = clampPreviewWidth(previewWidthPx);
    document.documentElement.style.setProperty("--ghrc-preview-width", `${Math.round(previewWidthPx)}px`);
  }

  function resizePreview(width, handle) {
    preserveReadingPosition(previewLink, () => {
      previewWidthPx = clampPreviewWidth(width);
      applyPreviewWidth();
      handle?.setAttribute("aria-valuenow", String(Math.round(previewWidthPx)));
    });
  }

  function createPreviewResizer() {
    const handle = document.createElement("div");
    handle.className = "ghrc-preview-resizer";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", "Resize website sidebar");
    handle.tabIndex = 0;

    const currentWidth = () => previewPanel?.getBoundingClientRect().width
      || (Number.isFinite(previewWidthPx) ? previewWidthPx : Math.min(window.innerWidth * 0.48, 800));
    handle.setAttribute("aria-valuemin", String(Math.round(previewWidthBounds().min)));
    handle.setAttribute("aria-valuemax", String(Math.round(previewWidthBounds().max)));
    handle.setAttribute("aria-valuenow", String(Math.round(currentWidth())));

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const onMove = (moveEvent) => resizePreview(
        splitViewOnLeft ? moveEvent.clientX : window.innerWidth - moveEvent.clientX,
        handle,
      );
      const onUp = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        if (Number.isFinite(previewWidthPx)) {
          void chrome.storage.local.set({ linkPreviewWidth: Math.round(previewWidthPx) }).catch(() => {});
        }
      };
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
    });

    handle.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const delta = splitViewOnLeft ? direction * 24 : -direction * 24;
      resizePreview(currentWidth() + delta, handle);
      if (Number.isFinite(previewWidthPx)) {
        void chrome.storage.local.set({ linkPreviewWidth: Math.round(previewWidthPx) }).catch(() => {});
      }
    });

    return handle;
  }

  function showLinkPreview(href, link, nativeGuide = false) {
    closeLinkPreview(false);
    previewLink = link;
    const panel = document.createElement("aside");
    panel.id = "ghrc-link-preview";
    panel.setAttribute("aria-label", "Linked website preview");
    const resizer = createPreviewResizer();
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
    const urlLabel = document.createElement("span");
    const displayHost = url.hostname.replace(/^www\./i, "");
    urlLabel.textContent = `${displayHost}${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
    destination.append(favicon, urlLabel);
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
    close.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>';
    close.title = "Close website preview";
    close.setAttribute("aria-label", "Close website preview");
    close.addEventListener("click", closeLinkPreview);
    header.append(close, open, copy, destination);
    panel.append(resizer, header);

    if (nativeGuide) {
      const content = document.createElement("div");
      content.className = "ghrc-preview-content";
      content.setAttribute("aria-live", "polite");
      panel.append(content);
      showNativeSplitGuide(href, content);
    } else {
      const frame = document.createElement("iframe");
      frame.title = "Website preview: " + url.hostname;
      frame.referrerPolicy = "no-referrer";
      const watch = { id: `${Date.now()}:${nativeSplitRequest}`, href, link, panel };
      previewWatch = watch;
      void (async () => {
        try {
          await chrome.runtime.sendMessage({ type: "watch-link-preview", url: href, previewId: watch.id });
        } catch {
          // Keep usable embedded previews available if the worker is restarting.
        }
        if (previewWatch === watch && panel.isConnected) {
          // Host the remote frame in an extension page so ChatGPT's
          // frame-src policy does not reject ordinary sites and PDF viewers.
          frame.src = `${chrome.runtime.getURL("link-preview.html")}#${encodeURIComponent(href)}`;
          panel.append(frame);
        }
      })();
      frame.addEventListener("error", () => {
        if (previewWatch === watch) handleBlockedPreview();
      });
    }

    preserveReadingPosition(link, () => {
      previewPanel = panel;
      applyPreviewWidth();
      document.body.append(panel);
      document.documentElement.setAttribute("data-ghrc-link-preview", splitViewOnLeft ? "left" : "right");
    });
  }

  function handleBlockedPreview(error) {
    if (!previewWatch) return;
    const { href, link, panel } = previewWatch;
    const hostname = new URL(href).hostname;
    if (hostname !== "github.com" && hostname !== "www.github.com") {
      void openNativeSplitView(href, link);
      return;
    }
    if (!["net::ERR_BLOCKED_BY_RESPONSE", "net::ERR_BLOCKED_BY_CSP"].includes(error)) return;
    // GitHub's API is a fallback for a rejected embed, not the default view.
    void chrome.runtime.sendMessage({ type: "unwatch-link-preview", previewId: previewWatch.id }).catch(() => {});
    previewWatch = null;
    panel.querySelector("iframe")?.remove();
    const content = document.createElement("div");
    content.className = "ghrc-preview-content";
    content.setAttribute("aria-live", "polite");
    content.textContent = "Loading GitHub preview…";
    panel.append(content);
    void loadGitHubPreview(href, content);
  }

  async function loadGitHubPreview(href, content) {
    try {
      const result = await chrome.runtime.sendMessage({ type: "load-github-link-preview", url: href });
      if (!content.isConnected) return;
      if (!result?.ok) throw new Error(result?.error || "GitHub preview is unavailable.");
      content.replaceChildren();
      const appendText = (tag, text, parent = content) => {
        const element = document.createElement(tag);
        element.textContent = text;
        parent.append(element);
        return element;
      };
      appendText("p", result.subtitle).className = "ghrc-preview-meta";
      appendText("h2", result.title);
      if (result.details) appendText("p", result.details);
      if (result.body) appendText("pre", result.body).className = "ghrc-preview-body";
      for (const file of result.files || []) {
        const section = document.createElement("details");
        section.open = true;
        appendText("summary", `${file.filename} (+${file.additions} −${file.deletions})`, section);
        appendText("pre", file.patch || "Diff unavailable. Open the full page to view this file.", section);
        content.append(section);
      }
      if (result.note) appendText("p", result.note);
    } catch (error) {
      if (!content.isConnected) return;
      content.replaceChildren();
      const message = document.createElement("p");
      message.textContent = `${error.message} Use Open in new tab to view the full GitHub page.`;
      content.append(message);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry preview";
      retry.addEventListener("click", () => {
        content.textContent = "Loading GitHub preview…";
        void loadGitHubPreview(href, content);
      });
      content.append(retry);
    }
  }

  async function openNativeSplitView(href, link) {
    closeLinkPreview(false);
    const request = ++nativeSplitRequest;
    try {
      const result = await chrome.runtime.sendMessage({ type: "open-native-split-view", url: href });
      if (request !== nativeSplitRequest) return;
      if (result?.ok) return;
    } catch {
      // Older browsers cannot create a native split through the extension API.
    }
    if (request === nativeSplitRequest) showLinkPreview(href, link, true);
  }

  function showNativeSplitGuide(href, content) {
    content.replaceChildren();
    const title = document.createElement("h2");
    title.textContent = `Open ${new URL(href).hostname} in split view`;
    const instructions = document.createElement("p");
    instructions.textContent = 'Right-click the link below and choose “Open link in split view” to view the full website beside this chat.';
    const destination = document.createElement("a");
    destination.href = href;
    destination.target = "_blank";
    destination.rel = "noopener noreferrer";
    destination.textContent = href;
    const note = document.createElement("p");
    note.textContent = "This browser does not support automatic split-view opening from the extension yet.";
    content.append(title, instructions, destination, note);
  }

  function createLinkActions(link, url) {
    const actions = document.createElement("span");
    actions.className = "ghrc-link-actions";
    actions.setAttribute("contenteditable", "false");

    const mode = document.createElement("span");
    mode.className = "ghrc-link-mode";
    mode.setAttribute("aria-hidden", "true");

    const sidebar = document.createElement("button");
    sidebar.className = "ghrc-link-sidebar-button";
    sidebar.type = "button";
    sidebar.title = "Open beside chat";
    sidebar.setAttribute("aria-label", "Open link beside chat");
    sidebar.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2"/><path d="M11 3v14"/></svg>';
    sidebar.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const href = sidebar.dataset.href;
      if (href) showLinkPreview(href, link);
    });

    actions.append(mode, sidebar);
    linkActions.set(link, actions);
    updateLinkActions(link, url, actions);
    return actions;
  }

  function updateLinkActions(link, url, actions = linkActions.get(link)) {
    const mode = actions?.querySelector(".ghrc-link-mode");
    const sidebar = actions?.querySelector(".ghrc-link-sidebar-button");
    if (!mode || !sidebar) return;
    mode.textContent = newTabsEnabled ? "↗" : "→";
    mode.title = newTabsEnabled ? "Normal click opens in a new tab" : "Normal click opens in this tab";
    sidebar.dataset.href = url.href;
  }

  function ensureLinkActions(link) {
    const existing = linkActions.get(link);
    const url = externalUrlForLink(link);
    if (!splitViewEnabled || !url) {
      existing?.remove();
      return;
    }
    if (existing?.isConnected) {
      updateLinkActions(link, url, existing);
      return;
    }
    link.after(createLinkActions(link, url));
  }

  function decorateExternalLinks(node) {
    if (!(node instanceof Element)) return;
    if (node.matches("a[href]")) ensureLinkActions(node);
    node.querySelectorAll("a[href]").forEach(ensureLinkActions);
  }

  function refreshLinkActions() {
    document.querySelectorAll(".ghrc-link-actions").forEach((actions) => {
      if (!(actions.previousSibling instanceof HTMLAnchorElement)) actions.remove();
    });
    if (!splitViewEnabled) {
      document.querySelectorAll(".ghrc-link-actions").forEach(actions => actions.remove());
      return;
    }
    if (document.documentElement) decorateExternalLinks(document.documentElement);
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type !== "link-preview-navigation-error" || !previewWatch
        || message.previewId !== previewWatch.id || message.url !== previewWatch.href) return;
    handleBlockedPreview(message.error);
  });

  function preserveNativeScroll(event) {
    if (!historyModalEnabled || !modalWasSuppressed) return;
    const modal = document.getElementById(MODAL_ID);
    if (!modal || getComputedStyle(modal).display !== "none") return;
    event.stopImmediatePropagation();
  }

  window.addEventListener("wheel", preserveNativeScroll, { capture: true, passive: true });
  window.addEventListener("touchmove", preserveNativeScroll, { capture: true, passive: true });

  const pendingMutationNodes = new Set();
  let mutationFlushScheduled = false;

  function inspectMutationNode(node) {
    if (!(node instanceof Element)) return;
    inspectDialogs(node);
    stripTrackingFromLinks(node);
    decorateExternalLinks(node);
  }

  function queueMutationNode(node) {
    if (!(node instanceof Element)) return;

    for (const pending of pendingMutationNodes) {
      if (pending.contains(node)) return;
      if (node.contains(pending)) pendingMutationNodes.delete(pending);
    }
    pendingMutationNodes.add(node);
    if (mutationFlushScheduled) return;

    mutationFlushScheduled = true;
    requestAnimationFrame(() => {
      mutationFlushScheduled = false;
      const nodes = [...pendingMutationNodes];
      pendingMutationNodes.clear();
      suppressHistoryRateLimitModal();
      for (const candidate of nodes) inspectMutationNode(candidate);
    });
  }

  function watchChatGPTInterruptions() {
    if (!document.documentElement) {
      requestAnimationFrame(watchChatGPTInterruptions);
      return;
    }
    inspectDialogs(document.documentElement);
    suppressHistoryRateLimitModal();
    stripTrackingFromLinks(document.documentElement);
    decorateExternalLinks(document.documentElement);
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          queueMutationNode(mutation.target);
          continue;
        }
        for (const node of mutation.addedNodes) queueMutationNode(node);
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
      openExternalLinksInSplitViewOnLeft: false,
      linkPreviewWidth: null,
      [HISTORY_MODAL_SETTING_KEY]: true,
      [STRIP_UTM_TRACKING_SETTING_KEY]: true,
    });
    newTabsEnabled = settings.openExternalLinksInNewTabs !== false;
    splitViewEnabled = Boolean(settings.openExternalLinksInSplitView);
    splitViewOnLeft = Boolean(settings.openExternalLinksInSplitViewOnLeft);
    previewWidthPx = Number.isFinite(settings.linkPreviewWidth) ? Number(settings.linkPreviewWidth) : null;
    applyPreviewWidth();
    externalWarningEnabled = Boolean(settings[EXTERNAL_WARNING_SETTING_KEY]);
    historyModalEnabled = Boolean(settings[HISTORY_MODAL_SETTING_KEY]);
    stripUtmTrackingEnabled = Boolean(settings[STRIP_UTM_TRACKING_SETTING_KEY]);
    if (document.documentElement) {
      inspectDialogs(document.documentElement);
      suppressHistoryRateLimitModal();
      stripTrackingFromLinks(document.documentElement);
      decorateExternalLinks(document.documentElement);
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.openExternalLinksInNewTabs) {
      newTabsEnabled = changes.openExternalLinksInNewTabs.newValue !== false;
      refreshLinkActions();
    }
    if (changes.openExternalLinksInSplitView) {
      splitViewEnabled = Boolean(changes.openExternalLinksInSplitView.newValue);
      if (!splitViewEnabled) closeLinkPreview();
      refreshLinkActions();
    }
    if (changes.openExternalLinksInSplitViewOnLeft) {
      splitViewOnLeft = Boolean(changes.openExternalLinksInSplitViewOnLeft.newValue);
      if (previewPanel) {
        document.documentElement.setAttribute("data-ghrc-link-preview", splitViewOnLeft ? "left" : "right");
      }
    }
    if (changes.linkPreviewWidth) {
      previewWidthPx = Number.isFinite(changes.linkPreviewWidth.newValue) ? Number(changes.linkPreviewWidth.newValue) : null;
      applyPreviewWidth();
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
  void loadSettings();
})();
