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
  let githubPreviewGeneration = 0;
  const linkActions = new WeakMap();

  async function savePreviewWidth() {
    if (!Number.isFinite(previewWidthPx)) return;
    try {
      await chrome.storage.local.set({ linkPreviewWidth: Math.round(previewWidthPx) });
    } catch {
      // A reloaded extension can invalidate this tab's storage API synchronously.
    }
  }

  async function unwatchLinkPreview(previewId) {
    try {
      await chrome.runtime.sendMessage({ type: "unwatch-link-preview", previewId });
    } catch {
      // Local preview cleanup must still work after an extension reload.
    }
  }

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
    githubPreviewGeneration += 1;
    if (previewWatch) {
      void unwatchLinkPreview(previewWatch.id);
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
        void savePreviewWidth();
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
      void savePreviewWidth();
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
    let currentPreviewHref = href;
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
    urlLabel.textContent = `${displayHost}${url.pathname === "/" ? "" : url.pathname}${url.hash}`;
    destination.append(favicon, urlLabel);
    destination.title = urlLabel.textContent;
    const copy = document.createElement("button");
    copy.className = "ghrc-preview-control";
    copy.type = "button";
    copy.title = "Copy link";
    copy.setAttribute("aria-label", "Copy link");
    copy.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>';
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(currentPreviewHref);
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
        window.open(currentPreviewHref, "_blank", "noopener,noreferrer");
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
    } else if (["github.com", "www.github.com"].includes(url.hostname)) {
      // GitHub blocks iframes; use its API immediately rather than waiting for a failed embed.
      const history = [];
      let index = -1;
      const navigation = document.createElement("nav");
      navigation.className = "ghrc-preview-navigation";
      const back = document.createElement("button");
      const forward = document.createElement("button");
      for (const [button, label] of [[back, "Back"], [forward, "Forward"]]) {
        button.type = "button";
        button.className = "ghrc-preview-control";
        button.textContent = label;
        button.setAttribute("aria-label", label);
        navigation.append(button);
      }
      const content = document.createElement("div");
      content.className = "ghrc-preview-content";
      content.setAttribute("aria-live", "polite");
      panel.append(navigation, content);
      const visit = (nextHref, delta = 0) => {
        if (delta) {
          const target = index + delta;
          if (target < 0 || target >= history.length) return;
          index = target;
          nextHref = history[index];
        } else {
          const target = new URL(nextHref);
          if (target.protocol !== "https:" || !["github.com", "www.github.com"].includes(target.hostname)) return;
          history.splice(index + 1);
          history.push(target.href);
          index = history.length - 1;
        }
        currentPreviewHref = nextHref;
        destination.href = nextHref;
        destination.title = nextHref;
        open.href = nextHref;
        const target = new URL(nextHref);
        urlLabel.textContent = target.hostname.replace(/^www\./i, "") + target.pathname + target.hash;
        back.disabled = index === 0;
        forward.disabled = index >= history.length - 1;
        void loadGitHubPreview(nextHref, content, next => visit(next));
      };
      back.addEventListener("click", () => visit(null, -1));
      forward.addEventListener("click", () => visit(null, 1));
      visit(href);
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
          try {
            frame.src = `${chrome.runtime.getURL("link-preview.html")}#${encodeURIComponent(href)}`;
            panel.append(frame);
          } catch {
            // The extension may have reloaded while the navigation watch settled.
          }
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
    void unwatchLinkPreview(previewWatch.id);
    previewWatch = null;
    panel.querySelector("iframe")?.remove();
    const content = document.createElement("div");
    content.className = "ghrc-preview-content";
    content.setAttribute("aria-live", "polite");
    content.textContent = "Loading GitHub preview…";
    panel.append(content);
    void loadGitHubPreview(href, content);
  }

  function githubPreviewLink(parent, title, href, navigate) {
    try {
      const url = new URL(href);
      if (!["http:", "https:"].includes(url.protocol)) return false;
      const anchor = document.createElement("a");
      anchor.href = url.href;
      anchor.textContent = title;
      anchor.rel = "noopener noreferrer";
      if (navigate && ["github.com", "www.github.com"].includes(url.hostname)) {
        anchor.addEventListener("click", event => {
          if (!isPlainPrimaryActivation(event)) return;
          event.preventDefault();
          navigate(url.href);
        });
      } else anchor.target = "_blank";
      parent.append(anchor);
      return true;
    } catch {
      return false;
    }
  }

  // Treat all remote Markdown and code as text, never injectable HTML.
  function githubPreviewMarkdown(parent, body, href, navigate) {
    const block = document.createElement("div");
    block.className = "ghrc-preview-markdown";
    parent.append(block);
    let code = null;
    for (const line of body.split(/\r?\n/).slice(0, 1800)) {
      if (/^\s*(\x60{3}|~~~)/.test(line)) {
        if (code) code = null;
        else {
          code = document.createElement("pre");
          block.append(code);
        }
        continue;
      }
      if (code) {
        code.append(document.createTextNode(line + "\n"));
        continue;
      }
      if (!line.trim()) continue;
      const heading = /^(#{1,6})\s+(.*)/.exec(line);
      const tag = heading ? "h" + Math.min(6, heading[1].length + 1) : "p";
      const element = document.createElement(tag);
      const value = heading ? heading[2] : line.replace(/^\s*[-*+]\s+/, "• ")
        .replace(/^\s*\d+\.\s+/, "• ").replace(/^>\s*/, "❯ ");
      // Linkify Markdown links; leave embedded HTML and images inert.
      const links = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^)\s]+|(?:\.\.?\/)?[^)\s]+)\)/g;
      let position = 0;
      for (const match of value.matchAll(links)) {
        element.append(document.createTextNode(value.slice(position, match.index)));
        try {
          const target = new URL(match[2], href);
          if (!githubPreviewLink(element, match[1], target.href, navigate)) {
            element.append(document.createTextNode(match[0]));
          }
        } catch {
          element.append(document.createTextNode(match[0]));
        }
        position = match.index + match[0].length;
      }
      element.append(document.createTextNode(value.slice(position)));
      block.append(element);
    }
    if (body.split(/\r?\n/).length > 1800) {
      const note = document.createElement("p");
      note.textContent = "Markdown preview truncated. Open the full page for remaining lines.";
      block.append(note);
    }
  }

  async function loadGitHubPreview(href, content, navigate = null) {
    const generation = ++githubPreviewGeneration;
    content.textContent = "Loading GitHub preview…";
    try {
      const result = await chrome.runtime.sendMessage({ type: "load-github-link-preview", url: href });
      if (!content.isConnected || generation !== githubPreviewGeneration) return;
      if (!result?.ok) throw new Error(result?.error || "GitHub preview is unavailable.");
      content.replaceChildren();
      const appendText = (tag, value, parent = content) => {
        const element = document.createElement(tag);
        element.textContent = value;
        parent.append(element);
        return element;
      };
      if (result.subtitle) appendText("p", result.subtitle).className = "ghrc-preview-meta";
      if (result.title) appendText("h2", result.title);
      if (result.details) appendText("p", result.details);
      if (result.parentUrl) {
        const parent = document.createElement("p");
        githubPreviewLink(parent, "← Parent directory", result.parentUrl, navigate);
        content.append(parent);
      }
      if (result.body) githubPreviewMarkdown(content, result.body, href, navigate);
      if (result.image) {
        const image = document.createElement("img");
        image.src = result.image;
        image.alt = result.title || "GitHub image";
        image.className = "ghrc-preview-image";
        content.append(image);
      } else if (typeof result.text === "string") {
        if (result.markdown) githubPreviewMarkdown(content, result.text, href, navigate);
        else appendText("pre", result.text).className = "ghrc-preview-code";
      }
      if (result.entries?.length) {
        const entries = document.createElement("ul");
        entries.className = "ghrc-preview-entries";
        for (const entry of result.entries) {
          const item = document.createElement("li");
          if (!githubPreviewLink(item, entry.title, entry.url, navigate)) appendText("span", entry.title, item);
          if (entry.detail) appendText("small", entry.detail, item);
          entries.append(item);
        }
        content.append(entries);
      }
      for (const file of result.files || []) {
        const section = document.createElement("details");
        section.open = true;
        appendText("summary", file.filename + " (+" + file.additions + " −" + file.deletions + ")", section);
        appendText("pre", file.patch || "Diff unavailable. Open the full page to view this file.", section);
        content.append(section);
      }
      for (const comment of result.comments || []) {
        const section = document.createElement("section");
        section.className = "ghrc-preview-comment";
        githubPreviewLink(section, "@" + comment.author, comment.url, navigate);
        githubPreviewMarkdown(section, comment.body, href, navigate);
        content.append(section);
      }
      if (result.note) appendText("p", result.note);
    } catch (error) {
      if (!content.isConnected || generation !== githubPreviewGeneration) return;
      content.replaceChildren();
      appendError();
      function appendError() {
        const message = document.createElement("p");
        message.textContent = error.message + " Use Open in new tab to view the full GitHub page.";
        content.append(message);
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Retry preview";
        retry.addEventListener("click", () => { void loadGitHubPreview(href, content, navigate); });
        content.append(retry);
      }
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

    actions.append(sidebar);
    linkActions.set(link, actions);
    updateLinkActions(link, url, actions);
    return actions;
  }

  function updateLinkActions(link, url, actions = linkActions.get(link)) {
    const sidebar = actions?.querySelector(".ghrc-link-sidebar-button");
    if (!sidebar) return;
    sidebar.dataset.href = url.href;
  }

  function ensureLinkActions(link) {
    const existing = linkActions.get(link);
    const url = externalUrlForLink(link);
    // Native hover cards repeat the URL in a portal outside the conversation.
    // Only decorate the original chat link, not its popup copy.
    if (!splitViewEnabled || !url || !link.closest('main')
        || link.closest('[role="tooltip"], [data-radix-popper-content-wrapper]')) {
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
    const selector = 'button[data-d-component="pressable"][aria-label^="Open "]';
    if (node.matches(selector)) ensureCitationActions(node);
    node.querySelectorAll(selector).forEach(ensureCitationActions);
  }

  function ensureCitationActions(button) {
    if (!splitViewEnabled || !button.closest('[role="dialog"]')) return;
    button.dispatchEvent(new Event("ghrc-resolve-citation-url", { bubbles: true }));
    const href = button.getAttribute("data-ghrc-citation-url");
    let url;
    try { url = new URL(href); } catch { return; }
    if (!["http:", "https:"].includes(url.protocol)) return;
    let actions = linkActions.get(button);
    if (!actions?.isConnected) {
      actions = createLinkActions(button, url);
      actions.classList.add("ghrc-citation-actions");
      button.after(actions);
    } else updateLinkActions(button, url, actions);
    button.classList.add("ghrc-citation-source");
    button.parentElement.classList.add("ghrc-citation-sources");
    actions.style.top = `${button.offsetTop + 12}px`;
  }

  function refreshLinkActions() {
    document.querySelectorAll(".ghrc-link-actions").forEach((actions) => {
      if (!(actions.previousSibling instanceof HTMLAnchorElement)
          && !actions.previousSibling?.matches?.('.ghrc-citation-source')) actions.remove();
    });
    if (!splitViewEnabled) {
      document.querySelectorAll(".ghrc-link-actions").forEach(actions => actions.remove());
      document.querySelectorAll('.ghrc-citation-source').forEach(button => button.classList.remove('ghrc-citation-source'));
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
