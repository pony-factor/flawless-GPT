(() => {
  // Citation cards are DIL buttons. Their destination is held in React's
  // rendered host element, rather than an href in the DOM.
  document.addEventListener("ghrc-resolve-citation-url", (event) => {
    const button = event.target;
    if (!(button instanceof Element)
        || !button.matches('button[data-d-component="pressable"][aria-label^="Open "]')
        || !button.closest('[role="dialog"]')) return;
    button.removeAttribute("data-ghrc-citation-url");
    const fiberKey = Object.keys(button).find(key => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? button[fiberKey] : null;
    let remaining = 200;
    function destination(value, depth = 0) {
      if (!value || typeof value !== "object" || depth > 16 || --remaining < 0) return null;
      if (Array.isArray(value)) {
        for (const child of value) {
          const url = destination(child, depth + 1);
          if (url) return url;
        }
        return null;
      }
      if (typeof value.onVisibleKey === "string") {
        try {
          const url = new URL(value.onVisibleKey);
          if (["https:", "http:"].includes(url.protocol)) return url.href;
        } catch { /* Not a URL visibility key. */ }
      }
      for (const key of ["props", "__dilHostElement", "children"]) {
        const url = destination(value[key], depth + 1);
        if (url) return url;
      }
      return null;
    }
    for (let level = 0; fiber && level < 10; level++, fiber = fiber.return) {
      const host = fiber.memoizedProps?.__dilHostElement;
      if (!host) continue;
      const url = destination(host);
      if (url) button.setAttribute("data-ghrc-citation-url", url);
      break;
    }
  });
})();
