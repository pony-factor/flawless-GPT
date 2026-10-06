(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const SETTING_KEY = "hoverRevealSidebar";
  const CLOSE_LABELS = new Set(["close sidebar", "collapse sidebar", "hide sidebar"]);
  const OPEN_LABELS = new Set(["open sidebar", "expand sidebar", "show sidebar"]);
  const EDGE_HOTSPOT_WIDTH = 64;
  const FALLBACK_SIDEBAR_WIDTH = 320;
  const COLLAPSE_DELAY_MS = 90;
  const REVEAL_DELAY_MS = 350;
  const REVEAL_RETRY_MS = 750;
  const MENU_HOVER_PADDING = 12;
  const RAIL_CLUSTER_GAP = 32;
  let initialCollapseFinished = false;
  let hoverRevealEnabled = false;
  let collapseTimer = null;
  let revealFrame = null;
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
    if (revealFrame !== null) {
      window.cancelAnimationFrame(revealFrame);
      revealFrame = null;
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
      const label = [
        candidate.getAttribute("aria-label"),
        candidate.getAttribute("title"),
        candidate.textContent,
      ].filter(Boolean).join(" ").trim().toLowerCase();
      const pathname = pathnameFor(candidate);
      if (pathname === "/library" || label === "library") return { element: candidate, bounds };
    }
    return null;
  }

  function presetIconBounds() {
    const library = libraryControl();
    if (!library) return null;

    const scope = library.element.closest(
      'aside, nav, [data-testid*="sidebar"], [data-testid*="navigation"]',
    ) || document;
    const railControls = Array.from(scope.querySelectorAll('a[href], button, [role="button"]'))
      .filter(element => element !== library.element
        && !element.contains(library.element)
        && !library.element.contains(element))
      .map(element => ({ element, bounds: visibleBounds(element) }))
      .filter(({ bounds }) => (
        bounds
        && bounds.left <= EDGE_HOTSPOT_WIDTH + 24
        && bounds.right <= EDGE_HOTSPOT_WIDTH + 32
        && bounds.top >= library.bounds.bottom
      ))
      .sort((a, b) => a.bounds.top - b.bounds.top);

    const presetBounds = [];
    let clusterBottom = library.bounds.bottom;
    for (const { bounds } of railControls) {
      if (bounds.top - clusterBottom > RAIL_CLUSTER_GAP) break;
      presetBounds.push(bounds);
      clusterBottom = Math.max(clusterBottom, bounds.bottom);
    }

    if (!presetBounds.length) return null;
    return {
      top: library.bounds.bottom,
      bottom: clusterBottom,
    };
  }

  function pointerInRevealHotspot() {
    if (!pointer.inside || pointer.x > EDGE_HOTSPOT_WIDTH) return false;
    const band = presetIconBounds();
    return Boolean(band && pointer.y >= band.top && pointer.y <= band.bottom);
  }

  function scheduleReveal() {
    if (revealFrame !== null) return;
    const revealAt = Date.now() + REVEAL_DELAY_MS;
    revealDeadline = revealAt + REVEAL_RETRY_MS;

    const attemptReveal = () => {
      revealFrame = null;

      if (!context.active() || !hoverRevealEnabled || !pointerInRevealHotspot()) {
        revealDeadline = 0;
        return;
      }

      if (Date.now() < revealAt) {
        revealFrame = window.requestAnimationFrame(attemptReveal);
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

      revealFrame = window.requestAnimationFrame(attemptReveal);
    };

    revealFrame = window.requestAnimationFrame(attemptReveal);
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
  }

  document.addEventListener("pointermove", (event) => {
    if (!event.isTrusted) return;
    if (event.pointerType && event.pointerType !== "mouse") return;
    pointer = { x: event.clientX, y: event.clientY, inside: true };
    reconcileHoverState();
  }, true);

  window.addEventListener("pointerout", (event) => {
    if (!event.isTrusted) return;
    if (event.relatedTarget !== null) return;
    pointer.inside = false;
    reconcileHoverState();
  }, true);

  window.addEventListener("blur", () => {
    pointer.inside = false;
    reconcileHoverState();
  });

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
  });

  void context.run(async () => {
    const settings = await chrome.storage.local.get({ [SETTING_KEY]: false });
    if (context.active()) setHoverRevealEnabled(settings[SETTING_KEY]);
  });
})();
