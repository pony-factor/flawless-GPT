(() => {
  // Citation cards and inline source groups are DIL controls. Their destinations are held in React's
  // rendered host element, rather than an href in the DOM.
  function resolveDestination(event) {
    const button = event.target;
    if (!(button instanceof Element)
        || !(button.matches('[data-d-component="popover-trigger"]') && button.closest('main') && !button.querySelector('a[href]')
          || button.matches('button[data-d-component="pressable"][aria-label^="Open "]')
            && button.closest('[role="dialog"]')
          || button.matches('[data-d-component="pressable"]') && button.closest('main')
            && event.type === "ghrc-resolve-item-url")) return;
    button.removeAttribute("data-ghrc-citation-url");
    button.removeAttribute("data-ghrc-citation-urls");
    button.removeAttribute("data-ghrc-citation-sources");
    const fiberKey = Object.keys(button).find(key => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? button[fiberKey] : null;
    let remaining = 800;
    const visited = new WeakSet();
    const destinations = new Set();
    const titles = new Map();
    function sourceTitle(value, depth = 0) {
      if (depth > 8 || !value) return "";
      if (typeof value === "string") return value.trim();
      if (typeof value !== "object") return "";
      if (Array.isArray(value)) {
        for (const child of value) {
          const title = sourceTitle(child, depth + 1);
          if (title) return title;
        }
        return "";
      }
      return sourceTitle(value.title || value["aria-label"] || value.children || value.props || value.content, depth + 1);
    }
    function destination(value, depth = 0) {
      if (!value || typeof value !== "object" || depth > 24 || --remaining < 0 || visited.has(value)) return null;
      visited.add(value);
      if (Array.isArray(value)) {
        for (const child of value) {
          destination(child, depth + 1);
        }
        return null;
      }
      if (typeof value.onVisibleKey === "string") {
        try {
          const url = new URL(value.onVisibleKey);
          if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) {
            destinations.add(url.href);
            const title = sourceTitle(value).replace(/^Open\s+/i, "");
            if (title && title.length <= 200 && !/^https?:\/\//i.test(title)) titles.set(url.href, title);
          }
        } catch { /* Not a URL visibility key. */ }
      }
      for (const key of ["props", "__dilHostElement", "children", "content"]) {
        destination(value[key], depth + 1);
      }
      return null;
    }
    for (let level = 0; fiber && level < 32; level++, fiber = fiber.return) {
      // Do not search the response or conversation for an unrelated source.
      if (fiber.stateNode !== button
          && fiber.stateNode?.matches?.('main, [data-message-author-role], [data-dil-message-id]')) break;
      const host = fiber.memoizedProps?.__dilHostElement;
      if (!host) continue;
      destination(host);
      if (destinations.size) {
        button.setAttribute("data-ghrc-citation-url", [...destinations][0]);
        button.setAttribute("data-ghrc-citation-urls", JSON.stringify([...destinations]));
        button.setAttribute("data-ghrc-citation-sources", JSON.stringify([...destinations].map(url => ({ url, title: titles.get(url) || "" }))));
        break;
      }
    }
  }
  document.addEventListener("ghrc-resolve-citation-url", resolveDestination);
  document.addEventListener("ghrc-resolve-item-url", resolveDestination);
})();
