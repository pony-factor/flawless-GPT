(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const SETTING_KEY = "hoverRevealSidebar";
  const CLOSE_LABELS = new Set(["close sidebar", "collapse sidebar", "hide sidebar"]);
  const OPEN_LABELS = new Set(["open sidebar", "expand sidebar", "show sidebar"]);
  const EDGE_HOTSPOT_WIDTH = 64;
  const FALLBACK_SIDEBAR_WIDTH = 320;
  const COLLAPSE_DELAY_MS = 90;
  const REVEAL_DELAY_MS = 650;
  const REVEAL_RETRY_MS = 750;
  const MENU_HOVER_PADDING = 12;
  let initialCollapseFinished = false;
  let hoverRevealEnabled = false;
  let collapseTimer = null;
  let revealTimer = null;
  let revealDeadline = 0;
  let pointer = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, inside: false };

  function sidebarToggleState() {
    const buttons = document.querySelectorAll("button[aria-label]");

    for (const button of buttons) {
      const label = button.getAttribute("aria-label")?.trim().toLowerCase();
      if (!CLOSE_LABELS.has(label) && !OPEN_LABELS.has(label)) continue;
      const style = getComputedStyle(button);
      if (!button.getClientRects().length || style.visibility === "hidden"
        || style.visibility === "collapse" || button.closest('[inert], [aria-hidden="true"]')) continue;
      if (CLOSE_LABELS.has(label)) return { state: "expanded", button };
      if (OPEN_LABELS.has(label)) return { state: "collapsed", button };
    }

    return null;
  }

  function finishInitialCollapse(observer) {
    if (initialCollapseFinished) return;
    initialCollapseFinished = true;
    observer?.disconnect();
    reconcileHoverState();
  }

  function collapseOnLoad(observer) {
    if (!context.active()) return;
    if (initialCollapseFinished) return;

    const toggle = sidebarToggleState();
    if (!toggle) return;

    if (toggle.state === "expanded") {
      toggle.button.click();
      return;
    }

    finishInitialCollapse(observer);
  }

  function clearCollapseTimer() {
    if (collapseTimer === null) return;
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }

  function clearRevealRetry() {
    if (revealTimer !== null) {
      window.clearTimeout(revealTimer);
      revealTimer = null;
    }
    revealDeadline = 0;
  }

  function visibleBounds(element) {
    if (!(element instanceof Element) || !element.getClientRects().length) return null;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden"
      || style.visibility === "collapse" || element.closest('[inert], [aria-hidden="true"]')) return null;
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    return bounds;
  }

  function pathnameFor(element) {
    const href = element instanceof HTMLAnchorElement ? element.href : element.closest?.("a[href]")?.href;
    if (!href) return "";
    try {
      return new URL(href, location.href).pathname.replace(/\/+$/, "") || "/";
    } catch {
      return "";
    }
  }

  function libraryControl() {
    const candidates = document.querySelectorAll('a[href], button, [role="button"]');
    for (const candidate of candidates) {
      const bounds = visibleBounds(candidate);
      if (!bounds || bounds.left > EDGE_HOTSPOT_WIDTH + 24) continue;
      const labels = [
        candidate.getAttribute("aria-label"),
        candidate.getAttribute("title"),
        candidate.textContent,
      ].filter(Boolean).map(label => label.trim().toLowerCase());
      const pathname = pathnameFor(candidate);
      if (pathname === "/library" || labels.includes("library")) return { element: candidate, bounds };
    }
    return null;
  }

  function pointerInRevealHotspot() {
    if (!pointer.inside || pointer.x < 0 || pointer.x > EDGE_HOTSPOT_WIDTH) return false;
    const library = libraryControl();
    // The entire left rail below Library is a hover target, even when there
    // are no preset icons or the pointer is near the bottom of the viewport.
    return Boolean(library && pointer.y >= library.bounds.bottom
      && pointer.y < window.innerHeight);
  }

  function scheduleReveal() {
    if (revealTimer !== null) return;
    revealDeadline = Date.now() + REVEAL_DELAY_MS + REVEAL_RETRY_MS;

    const attemptReveal = () => {
      revealTimer = null;

      if (!context.active() || !hoverRevealEnabled || !pointerInRevealHotspot()) {
        revealDeadline = 0;
        return;
      }

      const toggle = sidebarToggleState();
      const disabled = toggle?.button.disabled
        || toggle?.button.getAttribute("aria-disabled") === "true";

      if (toggle?.state === "collapsed" && !disabled) {
        revealDeadline = 0;
        toggle.button.click();
        return;
      }

      if (toggle?.state === "expanded" || Date.now() >= revealDeadline) {
        revealDeadline = 0;
        return;
      }

      // Backgrounded or unfocused windows may pause animation frames even
      // while their page still receives mouse hover events. Retry on a timer
      // instead; a missing or temporarily disabled toggle can still recover.
      revealTimer = window.setTimeout(attemptReveal, 50);
    };

    // A timer does not depend on rendering or keyboard focus. The reveal
    // happens after the same delay when the pointer stays below Library.
    revealTimer = window.setTimeout(attemptReveal, REVEAL_DELAY_MS);
  }

  function sidebarLike(element) {
    if (!(element instanceof Element)) return false;
    const bounds = element.getBoundingClientRect();
    const maxWidth = Math.min(480, window.innerWidth * 0.65);
    return bounds.left <= 8
      && bounds.width >= 180
      && bounds.width <= maxWidth
      && bounds.height >= window.innerHeight * 0.6;
  }

  function sidebarFor(toggleButton) {
    const semanticSidebar = toggleButton.closest(
      'aside, nav, [data-testid*="sidebar"], [data-testid*="navigation"]',
    );
    if (sidebarLike(semanticSidebar)) return semanticSidebar;

    let candidate = toggleButton.parentElement;
    let match = null;
    for (let depth = 0; candidate && depth < 10; depth += 1) {
      if (sidebarLike(candidate)) match = candidate;
      candidate = candidate.parentElement;
    }
    return match;
  }

  function pointerOverSidebar(toggle) {
    if (!pointer.inside) return false;

    const sidebar = sidebarFor(toggle.button);
    if (!sidebar) return pointer.x <= FALLBACK_SIDEBAR_WIDTH;

    const bounds = sidebar.getBoundingClientRect();
    if (pointer.x >= bounds.left
      && pointer.x <= bounds.right
      && pointer.y >= bounds.top
      && pointer.y <= bounds.bottom) return true;

    // Include overflowing children and menus portaled outside the sidebar.
    const hovered = document.elementFromPoint(pointer.x, pointer.y);
    if (hovered && sidebar.contains(hovered)) return true;

    const regions = [sidebar];
    const menus = document.querySelectorAll('[role="menu"], [role="listbox"], [popover]');
    for (let index = 0; index < regions.length; index += 1) {
      const region = regions[index];
      const triggers = region.querySelectorAll('[aria-expanded="true"][aria-controls]');
      const controlledIds = new Set(Array.from(triggers).flatMap(trigger =>
        trigger.getAttribute("aria-controls").split(/\s+/)));

      for (const menu of menus) {
        if (regions.includes(menu) || !menu.getClientRects().length) continue;
        const style = getComputedStyle(menu);
        if (style.visibility === "hidden" || menu.closest('[inert], [aria-hidden="true"]')) continue;
        const labelledBy = (menu.getAttribute("aria-labelledby") || "").split(/\s+/);
        const owned = controlledIds.has(menu.id) || labelledBy.some(id => {
          const trigger = id && document.getElementById(id);
          return trigger && region.contains(trigger)
            && trigger.getAttribute("aria-expanded") === "true";
        });
        if (!owned) continue;
        regions.push(menu);
        const menuBounds = menu.getBoundingClientRect();
        if (pointer.x >= menuBounds.left - MENU_HOVER_PADDING
          && pointer.x <= menuBounds.right + MENU_HOVER_PADDING
          && pointer.y >= menuBounds.top - MENU_HOVER_PADDING
          && pointer.y <= menuBounds.bottom + MENU_HOVER_PADDING) return true;
      }
    }
    return false;
  }

  function scheduleCollapse() {
    if (collapseTimer !== null) return;
    collapseTimer = window.setTimeout(() => {
      collapseTimer = null;
      if (!context.active() || !hoverRevealEnabled) return;

      const toggle = sidebarToggleState();
      if (!toggle || toggle.state !== "expanded" || pointerOverSidebar(toggle)) return;
      toggle.button.click();
    }, COLLAPSE_DELAY_MS);
  }

  function reconcileHoverState() {
    if (!context.active() || !hoverRevealEnabled) return;

    const overRevealHotspot = pointerInRevealHotspot();
    const toggle = sidebarToggleState();

    if (!toggle) {
      if (overRevealHotspot) scheduleReveal();
      else clearRevealRetry();
      return;
    }

    if (toggle.state === "collapsed") {
      clearCollapseTimer();
      if (overRevealHotspot) scheduleReveal();
      else clearRevealRetry();
      return;
    }

    clearRevealRetry();
    if (pointerOverSidebar(toggle)) clearCollapseTimer();
    else scheduleCollapse();
  }

  function setHoverRevealEnabled(nextEnabled) {
    hoverRevealEnabled = Boolean(nextEnabled);
    clearCollapseTimer();
    clearRevealRetry();

    if (!hoverRevealEnabled || !initialCollapseFinished) return;
    const toggle = sidebarToggleState();
    if (toggle?.state === "expanded") toggle.button.click();
    // The pointer may already be below Library before storage finishes loading
    // or while this preference is enabled. Do not require another mouse move.
    reconcileHoverState();
  }

  function trackMouse(event) {
    if (!event.isTrusted) return;
    if (event.pointerType && event.pointerType !== "mouse") return;
    pointer = { x: event.clientX, y: event.clientY, inside: true };
    reconcileHoverState();
  }

  function trackMouseExit(event) {
    if (!event.isTrusted || event.relatedTarget !== null) return;
    pointer.inside = false;
    reconcileHoverState();
  }

  // Listen for trusted mouse entry as well as movement. A visible but
  // unfocused window should not require a click before its hover is detected.
  const mouseEntryEvents = ["pointermove", "pointerover", "pointerenter", "mousemove", "mouseover", "mouseenter"];
  const mouseExitEvents = ["pointerout", "mouseout"];
  mouseEntryEvents.forEach(type => document.addEventListener(type, trackMouse, true));
  mouseExitEvents.forEach(type => window.addEventListener(type, trackMouseExit, true));

  // Keyboard focus can leave a visible window while the mouse remains over
  // the rail. Collapse on mouse exit, never on window blur. Hidden tabs do not
  // have a hoverable pointer; discard stale coordinates if a tab is hidden.
  function trackVisibility() {
    if (!document.hidden) return;
    pointer.inside = false;
    clearRevealRetry();
  }
  document.addEventListener("visibilitychange", trackVisibility);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[SETTING_KEY]) return;
    setHoverRevealEnabled(changes[SETTING_KEY].newValue);
  });

  const observer = new MutationObserver(() => collapseOnLoad(observer));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-label"],
  });

  collapseOnLoad(observer);
  const initialCollapseTimer = window.setTimeout(() => finishInitialCollapse(observer), 10000);
  context.onStop(() => {
    observer.disconnect();
    clearTimeout(initialCollapseTimer);
    clearCollapseTimer();
    clearRevealRetry();
    mouseEntryEvents.forEach(type => document.removeEventListener(type, trackMouse, true));
    mouseExitEvents.forEach(type => window.removeEventListener(type, trackMouseExit, true));
    document.removeEventListener("visibilitychange", trackVisibility);
  });

  void context.run(async () => {
    const settings = await chrome.storage.local.get({ [SETTING_KEY]: false });
    if (context.active()) setHoverRevealEnabled(settings[SETTING_KEY]);
  });
})();
