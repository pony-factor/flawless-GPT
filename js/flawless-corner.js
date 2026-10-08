(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;

  const IMAGE_CLASS = "ghrc-flawless-new-chat-image";
  const ICON_CLASS = "ghrc-flawless-new-chat-icon";
  const icons = new Set();

  function replaceIcons() {
    if (!context.active()) return;
    const controls = document.querySelectorAll(
      'button[aria-label="New chat"], a[aria-label="New chat"], '
      + 'button[data-testid="create-new-chat-button"], a[data-testid="create-new-chat-button"]',
    );
    for (const control of controls) {
      if (control.querySelector(`.${IMAGE_CLASS}`)) continue;
      const icon = control.querySelector("svg");
      if (!icon) continue;
      const image = document.createElement("img");
      image.className = IMAGE_CLASS;
      image.alt = "";
      image.decoding = "async";
      image.draggable = false;
      try {
        image.src = chrome.runtime.getURL("artwork/squeaky-belle-full.webp");
      } catch (error) {
        context.handleError(error);
        return;
      }
      icon.before(image);
      icon.classList.add(ICON_CLASS);
      icons.add(icon);
    }
    for (const icon of icons) {
      if (!icon.isConnected) icons.delete(icon);
    }
  }

  const observer = new MutationObserver(replaceIcons);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", replaceIcons, { once: true });
  replaceIcons();

  context.onStop(() => {
    observer.disconnect();
    document.removeEventListener("DOMContentLoaded", replaceIcons);
    document.querySelectorAll(`.${IMAGE_CLASS}`).forEach(image => image.remove());
    icons.forEach(icon => icon.classList.remove(ICON_CLASS));
    icons.clear();
  });
})();
