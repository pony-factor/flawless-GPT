(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const ENABLED_KEY = "showClipboardSendButton";
  const BUTTON_ID = "ghrc-clipboard-send-button";

  let enabled = false;
  let mountScheduled = false;
  let actionRunning = false;

  function findComposerInput() {
    return document.querySelector('#prompt-textarea, [data-composer-markdown][contenteditable="true"]');
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
      const queued = await globalThis.__ghrcMessageQueue?.enqueueText(text);
      setButtonMessage(button, queued ? "Queue clipboard as prompt" : "Clipboard message could not be queued; try again");
    } catch (error) {
      if (["NotAllowedError", "SecurityError", "NotFoundError"].includes(error?.name)) {
        setButtonMessage(button, "Clipboard access unavailable; paste into the composer to queue your message");
      } else {
        context.handleError(error);
        setButtonMessage(button, "Clipboard message could not be queued; try again");
      }
    } finally {
      actionRunning = false;
      setButtonBusy(button, false);
      scheduleMount();
    }
  }

  function createButton() {
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.title = "Queue clipboard as prompt";
    button.setAttribute("aria-label", "Queue clipboard as prompt");
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

  function mountButton() {
    if (!context.active()) return;
    mountScheduled = false;
    if (!enabled) {
      removeButton();
      return;
    }

    const composer = findComposerInput();
    const sendButton = globalThis.__ghrcMessageQueue?.findActionButton(composer);
    if (!composer || !sendButton?.parentElement) {
      removeButton();
      return;
    }

    let button = document.getElementById(BUTTON_ID);
    if (!button) button = createButton();
    // Keep a stable order with the queue controls; competing "before Send"
    // observers otherwise move these buttons back and forth indefinitely.
    const hat = document.getElementById("ghrc-message-interrupt-button");
    const anchor = hat?.parentElement === sendButton.parentElement ? hat : sendButton;
    if (button.parentElement !== anchor.parentElement || button.nextElementSibling !== anchor) {
      anchor.before(button);
    }
    setButtonBusy(button, actionRunning);
  }

  function scheduleMount() {
    if (!context.active()) return;
    if (mountScheduled) return;
    mountScheduled = true;
    requestAnimationFrame(mountButton);
  }

  function setEnabled(nextEnabled) {
    enabled = nextEnabled;
    if (!enabled) removeButton();
    else scheduleMount();
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
  context.onStop(() => { observer.disconnect(); removeButton(); });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
