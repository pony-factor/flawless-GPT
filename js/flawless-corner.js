(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;

  const IMAGE_CLASS = "ghrc-flawless-logo-image";
  const ICON_CLASS = "ghrc-flawless-logo-icon";
  const icons = new Set();
  const buttons = new Set();

  function replaceIcons() {
    if (!context.active()) return;
    const controls = document.querySelectorAll(
      'button[aria-label="Show sidebar"], button[aria-label="Open sidebar"], '
      + 'button[aria-label="Expand sidebar"]',
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
      control.classList.add("ghrc-flawless-logo-button");
      buttons.add(control);
      icons.add(icon);
    }
    for (const button of buttons) {
      if (!button.isConnected) buttons.delete(button);
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
    buttons.forEach(button => button.classList.remove("ghrc-flawless-logo-button"));
    buttons.clear();
  });
})();
