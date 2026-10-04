(() => {
  "use strict";

  const SETTING_KEY = "preserveScrollPositionOnSend";
  const SEND_BUTTON_SELECTOR = [
    'button[data-testid="send-button"]',
    'button[aria-label*="send" i]',
    'button[aria-label*="submit" i]',
  ].join(",");
  const MESSAGE_SELECTOR = '[data-testid^="conversation-turn-"], [data-message-author-role], [data-content-search-unit-key]';
  const COMPOSER_SELECTOR = '#prompt-textarea, [contenteditable="true"]';
  const USER_SCROLL_KEYS = new Set([
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    " ",
  ]);

  let enabled = false;
  let guard = null;
  let restoreScheduled = false;
  let resizeObserver = null;

  function isScrollableElement(element) {
    if (!element) return false;
    try {
      const overflowY = getComputedStyle(element).overflowY;
      return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
    } catch {
      return false;
    }
  }

  function scrollableAncestor(node) {
    let element = node instanceof Element ? node : node?.parentElement;
    while (element) {
      if (isScrollableElement(element)) return element;
      element = element.parentElement;
    }
    return null;
  }

  function findConversationScrollContainer() {
    const turns = document.querySelectorAll(MESSAGE_SELECTOR);
    const lastTurn = turns[turns.length - 1];
    const turnScroller = scrollableAncestor(lastTurn);
    if (turnScroller) return turnScroller;

    const mainScroller = scrollableAncestor(document.querySelector("main, [role='main']"));
    if (mainScroller) return mainScroller;

    const candidates = [...document.querySelectorAll(
      'main, [role="main"], [class*="overflow-y-auto"], [class*="overflow-auto"]',
    )].filter(isScrollableElement);

    if (candidates.length) {
      return candidates.reduce((best, candidate) => {
        const bestRange = best.scrollHeight - best.clientHeight;
        const candidateRange = candidate.scrollHeight - candidate.clientHeight;
        return candidateRange > bestRange ? candidate : best;
      });
    }

    return document.scrollingElement || document.documentElement;
  }

  function isSendButtonTarget(target) {
    return Boolean(target?.closest?.(SEND_BUTTON_SELECTOR));
  }

  function isComposerTarget(target) {
    const composer = target?.closest?.(COMPOSER_SELECTOR);
    if (!composer) return false;
    if (composer.id === "prompt-textarea") return true;
    return Boolean(composer.closest?.("form"));
  }

  function shouldBeginForKeydown(event) {
    return (
      event.key === "Enter"
      && !event.shiftKey
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.isComposing
      && isComposerTarget(event.target)
    );
  }

  function isUserScrollKey(event) {
    return USER_SCROLL_KEYS.has(event.key);
  }

  const api = {
    isSendButtonTarget,
    isComposerTarget,
    shouldBeginForKeydown,
    isUserScrollKey,
  };

  if (globalThis.__GHRC_TEST__) {
    Object.assign(globalThis.__GHRC_TEST__, api);
    return;
  }

  function currentGuardContainer() {
    if (!guard) return null;
    if (guard.container?.isConnected) return guard.container;

    const replacement = findConversationScrollContainer();
    if (!replacement) return null;
    for (const [property, value, priority] of guard.styles) {
      if (value) guard.container.style.setProperty(property, value, priority);
      else guard.container.style.removeProperty(property);
    }
    guard.container = replacement;
    protectContainer(replacement);
    return replacement;
  }

  function containerViewport(container) {
    return container === document.scrollingElement
      ? { top: 0, bottom: window.innerHeight }
      : container.getBoundingClientRect();
  }

  function readingAnchor(container) {
    const viewport = containerViewport(container);
    const messages = [...container.querySelectorAll(MESSAGE_SELECTOR)];
    for (const message of messages) {
      const blocks = [...message.querySelectorAll("p, li, pre, h1, h2, h3")];
      for (const element of [...blocks, message]) {
        const rect = element.getBoundingClientRect();
        if (rect.height && rect.bottom > viewport.top && rect.top < viewport.bottom) {
          return { element, offset: rect.top - viewport.top };
        }
      }
    }
    return null;
  }

  function restorePosition() {
    restoreScheduled = false;
    if (!enabled || !guard) return;
    if (guard.path !== location.pathname) { stopGuard(); return; }

    const container = currentGuardContainer();
    if (!container) return;

    const anchor = guard.anchor;
    // Reverse-flex threads use negative offsets relative to the bottom. Keep
    // visible text at the same screen position as streaming adds content.
    const hasAnchor = anchor?.element.isConnected && container.contains(anchor.element);
    const targetTop = hasAnchor
      ? container.scrollTop + anchor.element.getBoundingClientRect().top
        - containerViewport(container).top - anchor.offset
      : guard.scrollTop;
    if (Math.abs(container.scrollTop - targetTop) > 0.5) {
      container.scrollTop = targetTop;
    }
    if (hasAnchor) guard.scrollTop = container.scrollTop;
    else guard.anchor = readingAnchor(container);
    if (Math.abs(container.scrollLeft - guard.scrollLeft) > 0.5) {
      container.scrollLeft = guard.scrollLeft;
    }
  }

  function scheduleRestore() {
    if (!enabled || !guard || restoreScheduled) return;
    restoreScheduled = true;
    requestAnimationFrame(restorePosition);
  }

  function stopGuard() {
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (guard?.container) {
      for (const [property, value, priority] of guard.styles) {
        if (value) guard.container.style.setProperty(property, value, priority);
        else guard.container.style.removeProperty(property);
      }
    }
    guard = null;
    restoreScheduled = false;
  }

  function protectContainer(container) {
    guard.styles = ["scroll-behavior", "overflow-anchor"].map(property => [
      property, container.style.getPropertyValue(property), container.style.getPropertyPriority(property),
    ]);
    container.style.setProperty("scroll-behavior", "auto", "important");
    container.style.setProperty("overflow-anchor", "none", "important");
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => { restorePosition(); scheduleRestore(); });
    resizeObserver.observe(container);
    for (const child of container.children) resizeObserver.observe(child);
  }

  function beginGuard() {
    if (!enabled) return;
    // Enter, native click, submit and FIFO sends belong to the same reading
    // position. Never replace it with an intermediate native scroll offset.
    if (guard && guard.path === location.pathname) { scheduleRestore(); return; }
    stopGuard();

    const container = findConversationScrollContainer();
    if (!container) return;

    guard = {
      container,
      scrollTop: container.scrollTop,
      anchor: readingAnchor(container),
      scrollLeft: container.scrollLeft,
      path: location.pathname,
      styles: [],
    };
    protectContainer(container);

    queueMicrotask(scheduleRestore);
    requestAnimationFrame(scheduleRestore);
    window.setTimeout(scheduleRestore, 50);
    window.setTimeout(scheduleRestore, 150);
    window.setTimeout(scheduleRestore, 350);
  }

  async function loadPreference() {
    const settings = await chrome.storage.local.get({ [SETTING_KEY]: false });
    enabled = Boolean(settings[SETTING_KEY]);
    if (!enabled) stopGuard();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[SETTING_KEY]) return;
    enabled = Boolean(changes[SETTING_KEY].newValue);
    if (!enabled) stopGuard();
  });

  document.addEventListener("click", (event) => {
    if (enabled && isSendButtonTarget(event.target)) beginGuard();
  }, true);

  document.addEventListener("submit", (event) => {
    if (!enabled) return;
    if (event.target?.querySelector?.('#prompt-textarea, [data-composer-markdown][contenteditable="true"]')) beginGuard();
  }, true);

  window.addEventListener("keydown", (event) => {
    if (guard && isUserScrollKey(event) && !event.target?.closest?.('input, textarea, [contenteditable="true"]')) {
      stopGuard();
      return;
    }
    if (enabled && shouldBeginForKeydown(event)) beginGuard();
  }, true);

  document.addEventListener("scroll", (event) => {
    if (!guard) return;
    const target = event.target === document ? document.scrollingElement : event.target;
    const container = currentGuardContainer();
    if (target === container) { restorePosition(); scheduleRestore(); }
  }, true);

  document.addEventListener("wheel", stopGuard, { capture: true, passive: true });
  document.addEventListener("touchmove", stopGuard, { capture: true, passive: true });
  window.addEventListener("pointerdown", (event) => {
    stopGuard();
    // Capture before focus can scroll a tall composer into view.
    if (isSendButtonTarget(event.target)) beginGuard();
  }, true);
  window.addEventListener("ghrc:before-composer-send", beginGuard);
  new MutationObserver(scheduleRestore).observe(document.documentElement, { childList: true, subtree: true });

  void loadPreference();
})();
