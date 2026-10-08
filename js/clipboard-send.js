(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const ENABLED_KEY = "showClipboardSendButton";
  const BUTTON_ID = "ghrc-clipboard-send-button";
  const URL_BUTTON_ID = "ghrc-clipboard-open-url-button";
  const ROUTE_CHANGE_EVENT = "ghrc:route-change";

  let enabled = false;
  let mountScheduled = false;
  let actionRunning = false;

  function findComposerInput() {
    // Use the same bottom composer as the queue. Inline message editors reuse
    // the markdown markup and must not receive or compete for these controls.
    return globalThis.__ghrcMessageQueue?.findComposerInput() || null;
  }

  function isNewChatPage() {
    return window.location.pathname === "/";
  }

  function setButtonBusy(button, busy) {
    button.disabled = busy;
    button.toggleAttribute("aria-busy", busy);
  }

  async function readClipboardText() {
    try {
      return await navigator.clipboard.readText();
    } catch (error) {
      // Extension clipboardRead also permits native paste when the page's
      // async Clipboard API is blocked. Keep the user's draft and selection.
      const focused = document.activeElement;
      const selection = window.getSelection();
      const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
      const input = document.createElement("textarea");
      input.setAttribute("aria-hidden", "true");
      input.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0";
      document.body.append(input);
      try {
        input.focus({ preventScroll: true });
        if (!document.execCommand("paste")) throw error;
        return input.value;
      } finally {
        input.remove();
        if (focused?.isConnected) focused.focus({ preventScroll: true });
        if (selection && ranges.length) {
          selection.removeAllRanges();
          for (const range of ranges) selection.addRange(range);
        }
      }
    }
  }

  function setButtonMessage(button, message) {
    button.title = message;
    button.setAttribute("aria-label", message);
  }

  async function openClipboardUrl(button) {
    setButtonBusy(button, true);
    try {
      const text = (await readClipboardText()).trim();
      let url;
      try {
        url = new URL(text);
      } catch {
        setButtonMessage(button, "Clipboard does not contain a valid URL");
        return;
      }

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        setButtonMessage(button, "Clipboard URL must use http or https");
        return;
      }

      window.location.assign(url.href);
    } catch (error) {
      if (["NotAllowedError", "SecurityError", "NotFoundError"].includes(error?.name)) {
        setButtonMessage(button, "Clipboard access unavailable");
      } else {
        context.handleError(error);
        setButtonMessage(button, "Clipboard URL could not be opened");
      }
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function sendClipboardPrompt(button) {
    if (actionRunning) return;
    actionRunning = true;
    setButtonBusy(button, true);

    try {
      const text = await readClipboardText();
      if (!context.active()) return;
      if (!text.trim()) {
        setButtonMessage(button, "Clipboard has no text to queue");
        return;
      }
      const submitted = await globalThis.__ghrcMessageQueue?.sendClipboardText(text);
      setButtonMessage(button, submitted ? "Send clipboard or queue as prompt" : "Clipboard message could not be sent or queued; try again");
    } catch (error) {
      if (["NotAllowedError", "SecurityError", "NotFoundError"].includes(error?.name)) {
        setButtonMessage(button, "Clipboard access unavailable; paste into the composer to queue your message");
      } else {
        context.handleError(error);
        setButtonMessage(button, "Clipboard message could not be sent or queued; try again");
      }
    } finally {
      actionRunning = false;
      setButtonBusy(button, false);
      scheduleMount();
    }
  }

  function createUrlButton() {
    const button = document.createElement("button");
    button.id = URL_BUTTON_ID;
    button.type = "button";
    button.title = "Open clipboard URL in this tab";
    button.setAttribute("aria-label", "Open clipboard URL in this tab");
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7l-1.1 1.1M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7l1.1-1.1" />
      </svg>
    `;
    button.addEventListener("click", () => void openClipboardUrl(button));
    button.addEventListener("mousedown", event => event.preventDefault());
    return button;
  }

  function createButton() {
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.title = "Send clipboard or queue as prompt";
    button.setAttribute("aria-label", "Send clipboard or queue as prompt");
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3M9 3h6v4H9V3Zm1 10h7m0 0-3-3m3 3-3 3" />
      </svg>
    `;
    button.addEventListener("click", () => void sendClipboardPrompt(button));
    button.addEventListener("mousedown", event => event.preventDefault());
    return button;
  }

  function removeButton() {
    document.getElementById(BUTTON_ID)?.remove();
  }

  function removeUrlButton() {
    document.getElementById(URL_BUTTON_ID)?.remove();
  }

  function mountButton() {
    if (!context.active()) return;
    mountScheduled = false;

    const composer = findComposerInput();
    const sendButton = globalThis.__ghrcMessageQueue?.findActionButton(composer);
    if (!composer || !sendButton?.parentElement) {
      removeButton();
      removeUrlButton();
      return;
    }

    // Keep a stable order with the queue controls; competing "before Send"
    // observers otherwise move these buttons back and forth indefinitely.
    const hat = document.getElementById("ghrc-message-interrupt-button");
    const anchor = hat?.parentElement === sendButton.parentElement ? hat : sendButton;

    let urlButton = document.getElementById(URL_BUTTON_ID);
    if (isNewChatPage()) {
      if (!urlButton) urlButton = createUrlButton();
      const launcher = document.getElementById("ghrc-spellcheck-gpt-launcher");
      const urlAnchor = launcher?.parentElement ? launcher : anchor;
      urlButton.toggleAttribute("data-ghrc-beside-spellcheck", Boolean(launcher?.parentElement));
      if (urlButton.parentElement !== urlAnchor.parentElement || urlButton.nextElementSibling !== urlAnchor) {
        urlAnchor.before(urlButton);
      }
    } else {
      removeUrlButton();
      urlButton = null;
    }

    let button = document.getElementById(BUTTON_ID);
    if (enabled) {
      if (!button) button = createButton();
      const buttonAnchor = urlButton?.parentElement === anchor.parentElement ? urlButton : anchor;
      if (button.parentElement !== buttonAnchor.parentElement || button.nextElementSibling !== buttonAnchor) {
        buttonAnchor.before(button);
      }
      setButtonBusy(button, actionRunning);
    } else {
      removeButton();
    }
  }

  function scheduleMount() {
    if (!context.active()) return;
    if (mountScheduled) return;
    mountScheduled = true;
    requestAnimationFrame(mountButton);
  }

  function setEnabled(nextEnabled) {
    enabled = nextEnabled;
    scheduleMount();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[ENABLED_KEY]) return;
    setEnabled(Boolean(changes[ENABLED_KEY].newValue));
  });

  void context.run(async () => {
    const settings = await chrome.storage.local.get({ [ENABLED_KEY]: false });
    if (!context.active()) return;
    setEnabled(Boolean(settings[ENABLED_KEY]));
  });

  const observer = new MutationObserver(scheduleMount);
  window.addEventListener(ROUTE_CHANGE_EVENT, scheduleMount);
  context.onStop(() => {
    window.removeEventListener(ROUTE_CHANGE_EVENT, scheduleMount);
    observer.disconnect();
    removeButton();
    removeUrlButton();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
