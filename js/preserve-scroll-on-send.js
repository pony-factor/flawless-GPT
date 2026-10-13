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
  const SIDEBAR_LABELS = /^(?:open|close|expand|collapse|show|hide) sidebar$/i;
  const SIDEBAR_SCROLL_SELECTOR = 'aside, nav, [role="navigation"], [data-testid*="sidebar" i], [data-testid*="history" i], #sidebar';
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
  let inputTimer = null;

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

    // Only search the chat column. A sidebar with a longer history can
    // otherwise win the largest-scroll-range fallback and be mistaken for
    // the conversation scroll container on a new or empty chat.
    const main = document.querySelector('main, [role="main"]');
    const candidates = main ? [
      main,
      ...main.querySelectorAll('[class*="overflow-y-auto"], [class*="overflow-auto"]'),
    ].filter(isScrollableElement) : [];

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

  function isSidebarScrollTarget(target) {
    const element = target?.closest ? target : target?.parentElement;
    return Boolean(element?.closest?.(SIDEBAR_SCROLL_SELECTOR));
  }

  const api = {
    isSendButtonTarget,
    isComposerTarget,
    shouldBeginForKeydown,
    isUserScrollKey,
    isSidebarScrollTarget,
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

  function anchorTop(element, container) {
    // A tall composer can scroll the outer document while the conversation
    // has its own scroller. Compensate layout movement, not that outer scroll.
    return element.getBoundingClientRect().top
      + (container === document.scrollingElement ? 0 : window.scrollY);
  }

  function readingAnchor(container) {
    const viewport = containerViewport(container);
    const messages = [...container.querySelectorAll(MESSAGE_SELECTOR)];
    for (const message of messages) {
      const blocks = [...message.querySelectorAll("p, li, pre, h1, h2, h3")];
      for (const element of [...blocks, message]) {
        const rect = element.getBoundingClientRect();
        if (rect.height && rect.bottom > viewport.top && rect.top < viewport.bottom) {
          return { element, top: anchorTop(element, container) };
        }
      }
    }
    return null;
  }

  function restorePosition() {
    restoreScheduled = false;
    if (!enabled || !guard) return;
    if (guard.path !== location.pathname) {
      // The first send assigns a conversation URL while its reply is streaming.
      if (guard.firstSend && /\/c\/[^/]+$/.test(location.pathname)) {
        guard.path = location.pathname;
        guard.firstSend = false;
      } else { stopGuard(); return; }
    }

    const container = currentGuardContainer();
    if (!container) return;
    if (guard.acceptingInput) { rememberPosition(container); return; }

    const anchor = guard.anchor;
    // Reverse-flex threads use negative offsets relative to the bottom. Keep
    // visible text at the same screen position as streaming adds content.
    const hasAnchor = anchor?.element.isConnected && container.contains(anchor.element);
    // Rects include CSS scaling; scrollTop remains in the element's own units.
    const scale = container.currentCSSZoom
      || container.getBoundingClientRect().height / container.offsetHeight || 1;
    const targetTop = hasAnchor
      ? container.scrollTop + (anchorTop(anchor.element, container) - anchor.top) / scale
      : guard.scrollTop;
    if (Math.abs(container.scrollTop - targetTop) > 0.01) {
      const previousTop = container.scrollTop;
      const previousError = hasAnchor ? Math.abs(anchorTop(anchor.element, container) - anchor.top) : 0;
      container.scrollTop = targetTop;
      // Chromium rounds scroll offsets to available pixels. At a half-pixel
      // boundary, do not turn a small drift into an equally large opposite one.
      if (hasAnchor && Math.abs(anchorTop(anchor.element, container) - anchor.top) >= previousError - 0.01) {
        container.scrollTop = previousTop;
      }
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
    clearTimeout(inputTimer);
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

  function rememberPosition(container) {
    guard.scrollTop = container.scrollTop;
    guard.scrollLeft = container.scrollLeft;
    guard.anchor = readingAnchor(container);
  }

  function allowUserScroll() {
    if (!guard) return;
    guard.acceptingInput = true;
    clearTimeout(inputTimer);
    inputTimer = window.setTimeout(() => {
      if (!guard) return;
      const container = currentGuardContainer();
      if (container) rememberPosition(container);
      guard.acceptingInput = false;
    }, 180);
  }

  function isSidebarTarget(target) {
    return SIDEBAR_LABELS.test(target?.closest?.('button[aria-label]')?.getAttribute('aria-label')?.trim() || '');
  }

  function beginGuard(firstSend = false) {
    if (!enabled) return;
    // Enter, native click, submit and FIFO sends belong to the same reading
    // position. Never replace it with an intermediate native scroll offset.
    if (guard && guard.path === location.pathname) {
      if (firstSend === true) {
        guard.acceptingInput = false;
        guard.firstSend ||= !/\/c\//.test(location.pathname);
      }
      scheduleRestore(); return;
    }
    stopGuard();

    const container = findConversationScrollContainer();
    if (!container) return;

    guard = {
      container,
      scrollTop: container.scrollTop,
      anchor: readingAnchor(container),
      scrollLeft: container.scrollLeft,
      path: location.pathname,
      firstSend: firstSend === true && !/\/c\//.test(location.pathname),
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
    if (enabled && isSidebarTarget(event.target)) beginGuard();
    if (enabled && isSendButtonTarget(event.target)) beginGuard(true);
  }, true);

  document.addEventListener("submit", (event) => {
    if (!enabled) return;
    if (event.target?.querySelector?.('#prompt-textarea, [data-composer-markdown][contenteditable="true"]')) beginGuard(true);
  }, true);

  window.addEventListener("keydown", (event) => {
    if (guard && isUserScrollKey(event) && !event.target?.closest?.('input, textarea, [contenteditable="true"]')) {
      allowUserScroll();
      return;
    }
    if (enabled && shouldBeginForKeydown(event)) beginGuard(true);
  }, true);

  document.addEventListener("scroll", (event) => {
    if (!guard) return;
    const target = event.target === document ? document.scrollingElement : event.target;
    const container = currentGuardContainer();
    if (target === container) {
      if (guard.acceptingInput) allowUserScroll();
      restorePosition(); scheduleRestore();
    }
  }, true);

  document.addEventListener("wheel", (event) => {
    // Let ChatGPT handle chat-history wheel input itself, even when the
    // conversation scroller falls back to document.scrollingElement.
    if (!enabled || event.ctrlKey || event.defaultPrevented || isSidebarScrollTarget(event.target)) return;
    const container = findConversationScrollContainer();
    if (!container.contains(event.target)) return;
    // Horizontal source cards compute overflow-y:auto too, even when they
    // cannot scroll vertically. Only hand off to a pane with a vertical range.
    let nested = event.target instanceof Element ? event.target : event.target?.parentElement;
    while (nested && nested !== container) {
      if (isScrollableElement(nested) && nested.scrollHeight > nested.clientHeight + 1) {
        const style = getComputedStyle(nested);
        const range = nested.scrollHeight - nested.clientHeight;
        const reverse = style.flexDirection === "column-reverse";
        const top = nested.scrollTop;
        const canScroll = event.deltaY < 0
          ? top > (reverse ? -range : 0) + 1
          : event.deltaY > 0 && top < (reverse ? 0 : range) - 1;
        if (canScroll || style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none") return;
      }
      nested = nested.parentElement;
    }
    if (!event.cancelable) { allowUserScroll(); return; }
    beginGuard();
    guard.acceptingInput = false;
    clearTimeout(inputTimer);
    event.preventDefault();
    // A streaming update can move the native scroller before the pending
    // animation frame restores it. Apply the wheel to the reading position.
    restorePosition();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1;
    container.scrollTop += event.deltaY * scale;
    container.scrollLeft += event.deltaX * scale;
    rememberPosition(container);
  }, { capture: true, passive: false });
  document.addEventListener("touchmove", allowUserScroll, { capture: true, passive: true });
  window.addEventListener("pointerdown", (event) => {
    if (isSidebarTarget(event.target)) { beginGuard(); return; }
    allowUserScroll();
    // Capture before focus can scroll a tall composer into view.
    if (isSendButtonTarget(event.target)) {
      if (guard) guard.acceptingInput = false;
      beginGuard(true);
    }
  }, true);
  window.addEventListener("ghrc:before-composer-send", () => beginGuard(true));
  new MutationObserver(scheduleRestore).observe(document.documentElement, { childList: true, subtree: true });

  void loadPreference();
})();
