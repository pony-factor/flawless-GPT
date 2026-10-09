(() => {
  "use strict";
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;

  const BUTTON_ID = "ghrc-temporary-chat-inline";
  const SOURCE_ATTR = "data-ghrc-temporary-chat-native";
  const READY_ATTR = "data-ghrc-temporary-chat-inline-ready";
  const ROUTE_EVENT = "ghrc:route-change";
  let scheduled = false;
  let nativeControl = null;

  // Only proxy the top-level native control. Menu items and temporary-chat
  // dialogs have their own workflows, including personalization choices.
  function findNativeControl() {
    const candidates = document.querySelectorAll("button, [role='button']");
    for (const candidate of candidates) {
      if (candidate.id === BUTTON_ID || candidate.closest("form, [data-type='unified-composer'], [role='dialog'], [role='menu'], [role='listbox']")) continue;
      const name = [
        candidate.getAttribute("aria-label"),
        candidate.getAttribute("title"),
        candidate.textContent,
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      const testId = candidate.getAttribute("data-testid") || "";
      const nativeLabel = /^(?:(?:start|open|new|exit|leave|disable|enable|turn (?:on|off))\s+)?temporary(?:\s+chat)?(?:\s+(?:mode|toggle))?$/i;
      const directLabel = [candidate.getAttribute("aria-label"), candidate.getAttribute("title"), candidate.textContent]
        .some(value => nativeLabel.test((value || "").replace(/\s+/g, " ").trim()));
      const directTestId = /(?:^|[-_])temporary[-_]?chat(?:[-_](?:button|toggle|trigger))?$/i.test(testId);
      if (!directLabel && !directTestId) continue;
      // Keep the already-proxied original eligible when our CSS hides it.
      if (!candidate.hasAttribute(SOURCE_ATTR) && !candidate.getClientRects().length) continue;
      return candidate;
    }
    return null;
  }

  function findComposerAction() {
    const composer = globalThis.__ghrcMessageQueue?.findComposerInput();
    const action = globalThis.__ghrcMessageQueue?.findActionButton(composer);
    if (!composer || !action?.parentElement) return null;
    const form = composer.closest("form, [data-type='unified-composer']");
    return form?.contains(action) ? action : null;
  }

  function clearControl() {
    document.getElementById(BUTTON_ID)?.remove();
    document.documentElement?.removeAttribute(READY_ATTR);
    nativeControl?.removeAttribute(SOURCE_ATTR);
    nativeControl = null;
  }

  function createButton() {
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8 8.5 8.5 0 0 1-3-.5L4 20l1-5a8 8 0 1 1 15-3.5Z"/><path d="M9 10h6m-6 3h4"/></svg><span>Temporary</span>';
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => {
      const native = findNativeControl();
      if (!native || native.disabled || native.getAttribute("aria-disabled") === "true") return;
      // Let ChatGPT own the transition and any subsequent choice dialog.
      native.click();
    });
    return button;
  }

  function mount() {
    scheduled = false;
    if (!context.active()) return;
    // Temporary Chat is a new-conversation action, not a way to convert an
    // already-running saved conversation into an unsaved one.
    const action = location.pathname === "/" ? findComposerAction() : null;
    const native = action ? findNativeControl() : null;
    if (!action || !native) {
      clearControl();
      return;
    }

    if (nativeControl !== native) {
      nativeControl?.removeAttribute(SOURCE_ATTR);
      nativeControl = native;
    }
    let button = document.getElementById(BUTTON_ID);
    if (!button) button = createButton();

    const disabled = Boolean(native.disabled || native.getAttribute("aria-disabled") === "true");
    if (button.disabled !== disabled) button.disabled = disabled;
    const active = native.getAttribute("aria-pressed") === "true"
      || native.getAttribute("aria-checked") === "true"
      || /^(?:exit|leave|disable|turn off)\s+temporary/i.test(
        native.getAttribute("aria-label") || native.getAttribute("title") || "");
    if (button.getAttribute("aria-pressed") !== String(active)) {
      button.setAttribute("aria-pressed", String(active));
    }
    const label = active ? "Temporary chat active" : "Start a temporary chat";
    if (button.title !== label) button.title = label;
    if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);

    // Keep stable order with queue/clipboard/interrupt controls, without
    // rearranging React's original composer or competing with those observers.
    const anchor = [
      "ghrc-message-queue-button",
      "ghrc-clipboard-send-button",
      "ghrc-clipboard-open-url-button",
      "ghrc-message-interrupt-button",
    ].map(id => document.getElementById(id))
      .find(candidate => candidate?.parentElement === action.parentElement) || action;
    if (button.parentElement !== anchor.parentElement || button.nextElementSibling !== anchor) {
      anchor.before(button);
    }
    if (!native.hasAttribute(SOURCE_ATTR)) native.setAttribute(SOURCE_ATTR, "");
    if (!document.documentElement.hasAttribute(READY_ATTR)) {
      document.documentElement.setAttribute(READY_ATTR, "");
    }
  }

  function scheduleMount() {
    if (scheduled || !context.active()) return;
    scheduled = true;
    requestAnimationFrame(mount);
  }

  const observer = new MutationObserver(scheduleMount);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-label", "aria-pressed", "aria-checked", "aria-disabled", "disabled", "title", "data-testid"],
  });
  window.addEventListener(ROUTE_EVENT, scheduleMount);
  window.addEventListener("popstate", scheduleMount);
  context.onStop(() => {
    observer.disconnect();
    window.removeEventListener(ROUTE_EVENT, scheduleMount);
    window.removeEventListener("popstate", scheduleMount);
    clearControl();
  });
  scheduleMount();
})();
