(() => {
  "use strict";
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;

  // Verified on https://mascots.pone.voyage/. ChatGPT's DIL response
  // sometimes retains only imageObservation: "unavailable", with no URL.
  const mascots = new Map([
    ["Clipper Ship", "image06.png?v=166c56bc"],
    ["Treasure Trove", "image07.png?v=166c56bc"],
    ["Sunkissed", "image03.png?v=166c56bc"],
  ]);
  const attempted = new WeakSet();
  const restorations = new Map();
  let scheduled = false;

  function hasSource(root) {
    return [...root.querySelectorAll("a[href]")].some(link => {
      try {
        const url = new URL(link.getAttribute("href"), location.href);
        return url.protocol === "https:" && url.hostname === "mascots.pone.voyage"
          && url.pathname === "/";
      } catch { return false; }
    });
  }

  function scan() {
    scheduled = false;
    if (!context.active()) return;
    for (const placeholder of document.querySelectorAll('[role="img"][aria-label="Image unavailable"]')) {
      if (attempted.has(placeholder)) continue;
      const root = placeholder.closest('[data-dil-message-id], [data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"]');
      const row = placeholder.closest('[data-d-component="row"]');
      if (!root || !row || !hasSource(root)) continue;
      const caption = row.textContent.replace(/\s+/g, " ").trim();
      const match = [...mascots].find(([name]) => caption.startsWith(`${name} —`) || caption.startsWith(`${name} –`) || caption === name);
      if (!match) continue;
      attempted.add(placeholder);
      const [name, file] = match;
      const image = document.createElement("img");
      image.alt = name;
      image.referrerPolicy = "no-referrer";
      image.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none";
      const oldPosition = placeholder.style.position;
      const icons = [...placeholder.children];
      const oldDisplays = icons.map(icon => icon.style.display);
      const restore = () => {
        image.remove();
        placeholder.style.position = oldPosition;
        placeholder.setAttribute("aria-label", "Image unavailable");
        icons.forEach((icon, i) => { icon.style.display = oldDisplays[i]; });
      };
      restorations.set(placeholder, restore);
      image.onload = () => {
        if (!context.active() || !placeholder.isConnected) return;
        placeholder.style.position = "relative";
        icons.forEach(icon => { icon.style.display = "none"; });
        image.style.display = "block";
        placeholder.setAttribute("aria-label", name);
      };
      image.onerror = () => {
        restore();
        restorations.delete(placeholder);
      };
      placeholder.append(image);
      image.src = `https://mascots.pone.voyage/assets/images/${file}`;
    }
    for (const [element] of restorations) {
      if (!element.isConnected) restorations.delete(element);
    }
  }

  function schedule() {
    if (scheduled || !context.active()) return;
    scheduled = true;
    requestAnimationFrame(scan);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document, { childList: true, subtree: true, characterData: true });
  context.onStop(() => {
    observer.disconnect();
    for (const restore of restorations.values()) restore();
    restorations.clear();
  });
  schedule();
})();
