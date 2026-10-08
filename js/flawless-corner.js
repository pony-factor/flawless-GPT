(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const TOGGLE_SELECTOR = 'button[aria-label="Show sidebar"], button[aria-label="Open sidebar"], button[aria-label="Expand sidebar"]';
  const NEW_CHAT_SELECTOR = 'button[aria-label="New chat"], a[aria-label="New chat"], [data-testid="create-new-chat-button"]';
  const toggles = new Set();
  const newChats = new Set();
  let link = null;

  function reconcile() {
    if (!context.active() || !document.body) return;
    if (!link?.isConnected) {
      link = document.createElement("a");
      link.id = "ghrc-flawless-corner";
      link.href = "/";
      link.setAttribute("aria-label", "New chat");
      link.title = "New chat";
      const image = document.createElement("img");
      image.alt = "";
      image.draggable = false;
      image.src = chrome.runtime.getURL("artwork/squeaky-belle-full.webp");
      link.append(image);
      link.addEventListener("click", event => {
        const controls = Array.from(document.querySelectorAll(NEW_CHAT_SELECTOR)).filter(control => control !== link);
        const native = controls.find(control => control.getClientRects().length) || controls[0];
        if (!native) return;
        event.preventDefault();
        native.click();
      });
      document.body.append(link);
    }
    const controls = Array.from(document.querySelectorAll(TOGGLE_SELECTOR));
    const visible = controls.find(control => {
      const bounds = control.getBoundingClientRect();
      return bounds.width && bounds.height && getComputedStyle(control).visibility !== "hidden";
    });
    for (const toggle of controls) {
      toggle.classList.add("ghrc-flawless-logo-button");
      toggles.add(toggle);
    }
    for (const control of document.querySelectorAll(NEW_CHAT_SELECTOR)) {
      if (control !== link) newChats.add(control);
    }
    for (const control of newChats) {
      control.classList.toggle("ghrc-flawless-hidden-new-chat", Boolean(visible));
      if (!control.isConnected) newChats.delete(control);
    }
    for (const toggle of toggles) {
      if (!toggle.isConnected || !controls.includes(toggle)) {
        toggle.classList.remove("ghrc-flawless-logo-button");
        toggles.delete(toggle);
      }
    }
  }

  const observer = new MutationObserver(reconcile);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label"] });
  window.addEventListener("resize", reconcile);
  reconcile();
  context.onStop(() => {
    observer.disconnect();
    window.removeEventListener("resize", reconcile);
    link?.remove();
    toggles.forEach(toggle => toggle.classList.remove("ghrc-flawless-logo-button"));
    newChats.forEach(control => control.classList.remove("ghrc-flawless-hidden-new-chat"));
  });
})();
