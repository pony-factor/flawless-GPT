(() => {
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
