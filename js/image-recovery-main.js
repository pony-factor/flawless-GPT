(() => {
  document.addEventListener("ghrc-resolve-image-citations", event => {
    const element = event.target;
    if (!(element instanceof Element) || !element.matches('[role="img"][aria-label="Image unavailable"], img')) return;
    const root = element.closest('[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"]')
      || element.closest('[data-dil-message-id]');
    const urls = new Set();
    let remaining = 1500;
    function visit(value, depth = 0) {
      if (!value || typeof value !== "object" || depth > 24 || --remaining < 0) return;
      if (Array.isArray(value)) { value.forEach(child => visit(child, depth + 1)); return; }
      if (typeof value.onVisibleKey === "string") {
        try {
          const url = new URL(value.onVisibleKey);
          if (url.protocol === "https:" && !url.username && !url.password) urls.add(url.href);
        } catch { /* Not a citation destination. */ }
      }
      for (const key of ["props", "__dilHostElement", "children", "content"]) visit(value[key], depth + 1);
    }
    for (const trigger of root?.querySelectorAll('[data-d-component="popover-trigger"]') || []) {
      const key = Object.keys(trigger).find(key => key.startsWith("__reactFiber$"));
      let fiber = key ? trigger[key] : null;
      for (let depth = 0; fiber && depth < 32; depth++, fiber = fiber.return) {
        const host = fiber.memoizedProps?.__dilHostElement;
        if (host) visit(host);
        // Stay within this response's rendered component tree.
        if (fiber.stateNode === root) break;
      }
    }
    element.setAttribute("data-ghrc-image-citations", JSON.stringify([...urls].slice(0, 6)));
  });
  // Read image-specific props only, never the conversation store or account data.
  document.addEventListener("ghrc-resolve-image-source", event => {
    const element = event.target;
    if (!(element instanceof Element) || !element.matches('[role="img"][aria-label="Image unavailable"], img')) return;
    const key = Object.keys(element).find(key => key.startsWith("__reactFiber$"));
    let fiber = key ? element[key] : null;
    for (let depth = 0; fiber && depth < 22; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      for (const item of [props, props?.resetKey?.props, props?.__dilHostElement?.props]) {
        for (const name of ["src", "imageUrl", "image_url", "originalUrl"]) {
          const value = item?.[name];
          if (typeof value !== "string") continue;
          try {
            const url = new URL(value);
            if (url.protocol !== "https:" || url.username || url.password) continue;
            element.setAttribute("data-ghrc-original-image", url.href);
            return;
          } catch { /* The image has no recoverable URL. */ }
        }
      }
    }
  });
})();
