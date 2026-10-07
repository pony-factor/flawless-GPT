(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const LAUNCHER_ID = "ghrc-spellcheck-gpt-launcher";
  const HOST_ATTR = "data-ghrc-spellcheck-launcher-host";
  const ENABLED_KEY = "showSpellcheckGptLauncher";
  const LEGACY_ICON_KEY = "spellcheckGptCanonicalIcon";
  const PLUGIN_NAME = "Spellcheck Only";
  const ICON_PATH = "artwork/spellcheck-only.png";
  const PICKER_RETRY_MS = 100;
  const PICKER_TIMEOUT_MS = 5_000;
  const SUBMIT_RETRY_MS = 100;
  const SUBMIT_TIMEOUT_MS = 5_000;

  let enabled = false;
  let mountScheduled = false;
  let launchStarted = false;

  function isHomePage() {
    return location.pathname === "/";
  }

  function findComposerInput() {
    return document.querySelector('#prompt-textarea, [data-composer-markdown][contenteditable="true"]');
  }

  function findComposer() {
    const prompt = findComposerInput();
    if (!prompt) return null;
    return prompt.closest("form") || prompt.closest('[data-type="unified-composer"]');
  }

  function isVisible(node) {
    return Boolean(node?.isConnected !== false && node?.getClientRects?.().length);
  }

  function actionLabels(node) {
    return [
      node?.getAttribute?.("aria-label"),
      node?.getAttribute?.("title"),
      node?.textContent,
    ].filter(Boolean).map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean);
  }

  function actionText(node) {
    return actionLabels(node).join(" ");
  }

  function findVisibleAction(labels, { exact = false, root = document } = {}) {
    const wanted = labels.map((label) => label.toLowerCase());
    const candidates = root.querySelectorAll([
      "button",
      '[role="button"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
    ].join(", "));

    return [...candidates].find((candidate) => {
      if (!isVisible(candidate)) return false;
      const candidateLabels = actionLabels(candidate).map((label) => label.toLowerCase());
      const combined = candidateLabels.join(" ");
      return wanted.some((needle) => exact
        ? candidateLabels.includes(needle)
        : combined.includes(needle));
    }) || null;
  }

  function findComposerMenuButton(composer) {
    const selectors = [
      'button[aria-label*="add" i]',
      'button[aria-label*="attach" i]',
      'button[aria-label*="tools" i]',
      'button[aria-label*="more" i]',
      'button[title*="add" i]',
      'button[title*="attach" i]',
      'button[title*="tools" i]',
      'button[title*="more" i]',
    ];
    for (let container = composer.parentElement; container; container = container.parentElement) {
      for (const selector of selectors) {
        const button = [...container.querySelectorAll(selector)].find((candidate) => {
          if (!isVisible(candidate)) return false;
          const label = actionText(candidate);
          return !/send|stop|voice|microphone/i.test(label);
        });
        if (button) return button;
      }
      if (container.matches("main, body")) break;
    }
    return null;
  }

  async function waitForAction(labels, options = {}) {
    const deadline = Date.now() + (options.timeout ?? PICKER_TIMEOUT_MS);
    while (Date.now() < deadline && isHomePage()) {
      const action = findVisibleAction(labels, options);
      if (action) return action;
      await new Promise((resolve) => window.setTimeout(resolve, PICKER_RETRY_MS));
    }
    return null;
  }

  async function activateSpellcheckPlugin(composer) {
    const pickerButton = findComposerMenuButton(composer);
    if (!pickerButton) return false;
    pickerButton.click();

    let pluginAction = await waitForAction([PLUGIN_NAME], { exact: true, timeout: 800 });
    if (!pluginAction) {
      const pluginsAction = await waitForAction(["Plugins", "Apps"], { exact: true });
      if (!pluginsAction) return false;
      pluginsAction.click();
      pluginAction = await waitForAction([PLUGIN_NAME], { exact: true });
    }
    if (!pluginAction) return false;

    pluginAction.click();
    await new Promise((resolve) => window.setTimeout(resolve, PICKER_RETRY_MS));
    return isHomePage();
  }

  function replaceTextControlValue(control, text) {
    const prototype = control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) return false;

    setter.call(control, text);
    control.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text,
    }));
    return control.value === text;
  }

  function composerText(composer) {
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      return composer.value;
    }
    const paragraphs = [...(composer.children || [])];
    if (paragraphs.length && paragraphs.every((node) => node.tagName === "P")) {
      const readNode = (node) => {
        if (node.nodeType === 3) return node.nodeValue || "";
        if (node.nodeName === "BR") {
          return node.classList.contains("ProseMirror-trailingBreak") ? "" : "\n";
        }
        return [...node.childNodes].map(readNode).join("");
      };
      return paragraphs.map(readNode).join("\n");
    }
    return composer.innerText || composer.textContent || "";
  }

  function matchesClipboard(composer, text) {
    const normalize = (value) => value.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    return normalize(composerText(composer)) === normalize(text);
  }

  async function waitForClipboard(composer, text) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      if (!isHomePage() || !composer.isConnected || findComposerInput() !== composer) return false;
      if (matchesClipboard(composer, text)) return true;
    }
    return false;
  }

  async function pasteIntoComposer(composer, text) {
    if (!text.trim()) return false;
    if (matchesClipboard(composer, text)) return true;
    composer.focus({ preventScroll: true });

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      return replaceTextControlValue(composer, text);
    }
    if (!composer.isContentEditable) return false;

    const selection = window.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    try {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      const unhandled = composer.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }));
      if (!unhandled) return waitForClipboard(composer, text);
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      if (matchesClipboard(composer, text)) return true;
      if (composerText(composer).trim()) return false;
    } catch {
      // Fall through when synthetic clipboard data is unsupported.
    }

    document.execCommand("insertText", false, text);
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    return matchesClipboard(composer, text);
  }

  function findSendButton(composer) {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label^="Send" i]',
      'button#composer-submit-button:not([data-testid="stop-button"]):not([aria-label*="Stop" i]):not([aria-label*="voice" i])',
    ];
    for (let container = composer.parentElement; container; container = container.parentElement) {
      for (const selector of selectors) {
        const button = [...container.querySelectorAll(selector)].find((candidate) => isVisible(candidate));
        if (button) return button;
      }
      if (container.matches("main, body")) break;
    }
    const form = composer.closest("form");
    return form?.querySelector('button[type="submit"]') || null;
  }

  function submitWhenReady(composer, text, deadline, shortcutAttempted = false) {
    if (
      Date.now() >= deadline
      || !isHomePage()
      || !composer.isConnected
      || findComposerInput() !== composer
      || !matchesClipboard(composer, text)
    ) return;

    const sendButton = findSendButton(composer);
    if (sendButton && !sendButton.disabled && sendButton.getAttribute("aria-disabled") !== "true") {
      sendButton.click();
      return;
    }
    if (!sendButton && !shortcutAttempted) {
      composer.focus({ preventScroll: true });
      for (const type of ["keydown", "keyup"]) {
        composer.dispatchEvent(new KeyboardEvent(type, {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        }));
      }
      window.setTimeout(() => submitWhenReady(composer, text, deadline, true), 500);
      return;
    }
    window.setTimeout(() => submitWhenReady(composer, text, deadline, shortcutAttempted), SUBMIT_RETRY_MS);
  }

  async function launchSpellcheck() {
    if (launchStarted || !isHomePage()) return;
    launchStarted = true;
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return;

      const composer = findComposerInput();
      if (!composer) return;
      if (!await activateSpellcheckPlugin(composer)) {
        console.warn("Spellcheck Only plugin could not be selected from the composer.");
        return;
      }
      if (!await pasteIntoComposer(composer, text)) return;

      const deadline = Date.now() + SUBMIT_TIMEOUT_MS;
      window.setTimeout(() => submitWhenReady(composer, text, deadline), SUBMIT_RETRY_MS);
    } catch (error) {
      console.warn("Spellcheck Only could not read the system clipboard:", error);
    } finally {
      launchStarted = false;
    }
  }

  function removeLauncher() {
    document.getElementById(LAUNCHER_ID)?.remove();
    document.querySelectorAll(`[${HOST_ATTR}]`).forEach((host) => {
      host.removeAttribute(HOST_ATTR);
    });
  }

  function createLauncher() {
    const button = document.createElement("button");
    button.id = LAUNCHER_ID;
    button.type = "button";
    button.title = `Run ${PLUGIN_NAME}`;
    button.setAttribute("aria-label", `Run ${PLUGIN_NAME} plugin`);

    const image = document.createElement("img");
    image.src = chrome.runtime.getURL(ICON_PATH);
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    button.append(image);

    button.addEventListener("click", () => {
      void launchSpellcheck();
    });

    return button;
  }

  function mountLauncher() {
    if (!context.active()) return;

    if (!enabled || !isHomePage()) {
      removeLauncher();
      return;
    }

    const composer = findComposer();
    if (!composer) return;

    let launcher = document.getElementById(LAUNCHER_ID);
    if (!launcher || launcher.parentElement !== composer) {
      launcher?.remove();
      launcher = createLauncher();
      composer.append(launcher);
    }
    composer.setAttribute(HOST_ATTR, "true");
  }

  function scheduleMount() {
    if (!context.active()) return;
    if (mountScheduled) return;
    mountScheduled = true;
    requestAnimationFrame(() => {
      mountScheduled = false;
      mountLauncher();
    });
  }

  async function loadSettings() {
    const settings = await chrome.storage.local.get({ [ENABLED_KEY]: false });
    if (!context.active()) return;
    enabled = Boolean(settings[ENABLED_KEY]);
    await chrome.storage.local.remove(LEGACY_ICON_KEY);
    scheduleMount();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[ENABLED_KEY]) return;
    enabled = Boolean(changes[ENABLED_KEY].newValue);
    scheduleMount();
  });

  void context.run(loadSettings);
  const observer = new MutationObserver(scheduleMount);
  context.onStop(() => observer.disconnect());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
