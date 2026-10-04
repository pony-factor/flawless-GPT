(() => {
  "use strict";

  const STORAGE_KEY = "queuedChatMessages";
  const PAUSED_STORAGE_KEY = "queuedChatMessagesPaused";
  const QUEUE_BUTTON_SETTING_KEY = "showMessageQueueButton";
  const PANEL_ID = "ghrc-message-queue";
  const QUEUE_BUTTON_ID = "ghrc-message-queue-button";
  const INTERRUPT_BUTTON_ID = "ghrc-message-interrupt-button";
  const COMPLETE_SETTLE_MS = 1_500;
  const PUMP_INTERVAL_MS = 250;
  const SUBMIT_TIMEOUT_MS = 5_000;
  const SAVE_DEBOUNCE_MS = 180;

  const pageSessionId = globalThis.crypto?.randomUUID?.()
    || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let activeKey = conversationKey();
  let queue = [];
  let storageState = {};
  let stateLoaded = false;
  let routeSyncRunning = false;
  let lastHref = location.href;
  let mountScheduled = false;
  let pumpScheduled = false;
  let pumpScheduleHandle = null;
  let pumpScheduleMode = null;
  let completionCandidateSince = null;
  let sendingItemId = null;
  let saveTimer = null;
  let interruptRunning = false;
  let enqueueRunning = false;
  let queuePaused = false;
  let showQueueButton = false;
  let persistPending = Promise.resolve();
  let queueStateRequest = null;
  let enterPending = 0;
  let enterChain = Promise.resolve();
  const pendingEnterTexts = new Set();
  let nativeSubmission = null;
  const capturedFiles = new Map();

  function composerContext(composer = findComposerInput()) {
    const form = findComposerForm(composer);
    if (!form) return { files: [], selections: [], quote: null, mentions: [] };
    const files = [...form.querySelectorAll('button[aria-label*="Remove" i]')]
      .filter(button => /file|attachment|image|upload/i.test(button.getAttribute("aria-label") || ""));
    const quoteRoot = form.querySelector('[data-composer-quote], [data-testid="composer-reply-preview"], [data-testid="composer-quote"], blockquote');
    const quoteButton = quoteRoot?.querySelector("button") || form.querySelector('button[aria-label*="Remove quote" i], button[aria-label*="Remove quoted" i], button[aria-label*="Clear quote" i]');
    const quote = quoteRoot || quoteButton?.closest('[data-composer-quote], blockquote')
      || quoteButton?.parentElement;
    const attachmentSurface = form.querySelector('[data-composer-attachments]');
    const selections = [...form.querySelectorAll('button[aria-label^="Remove selected text" i]')]
      .map(button => ({
        button,
        root: button.parentElement,
        text: button.parentElement?.querySelector('.whitespace-pre-wrap')?.textContent || "",
      }));
    return { files, selections, quote, quoteButton, mentions: composerMentions(composer), unknown: Boolean(attachmentSurface?.childElementCount && !files.length && !quote && !selections.length) };
  }

  function hasComposerContext(composer) {
    const state = composerContext(composer);
    return Boolean(state.files.length || state.selections.length || state.quote || state.unknown);
  }

  async function captureComposerContext(composer) {
    const state = composerContext(composer);
    if (state.unknown) return null;
    const attachments = [];
    for (const button of state.files) {
      const label = button.getAttribute("aria-label") || "";
      const card = button.closest('.group\\/composer-attachment') || button.parentElement;
      const imageNames = [...card.querySelectorAll("img")].flatMap(image => [image.alt, image.title]);
      const file = [...capturedFiles.values()].find(file => label.includes(file.name)
        || card.textContent.includes(file.name) || imageNames.includes(file.name));
      if (!file) return null;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      if (attachments.some(attachment => attachment.name === file.name)) return null;
      attachments.push({ name: file.name, type: file.type, lastModified: file.lastModified, dataUrl });
    }
    const quotedContent = state.quote?.cloneNode(true);
    for (const button of quotedContent?.querySelectorAll("button") || []) button.remove();
    const legacyQuote = (quotedContent?.textContent || "").trim();
    if (state.quote && (!legacyQuote || !state.quoteButton)) return null;
    if (state.selections.some(selection => !selection.text.trim())) return null;
    const quote = [legacyQuote, ...state.selections.map(selection => selection.text.trim())].filter(Boolean).join("\n\n");
    return { attachments, quote, mentions: state.mentions, state };
  }

  async function clearComposerContext(snapshot, composer) {
    for (const button of [...snapshot.state.files, snapshot.state.quoteButton, ...snapshot.state.selections.map(selection => selection.button)].filter(Boolean)) button.click();
    await new Promise(resolve => window.setTimeout(resolve, 80));
    return !hasComposerContext(composer);
  }

  function contextMatches(snapshot, composer) {
    const current = composerContext(composer);
    return current.quote === snapshot.quote && current.unknown === snapshot.unknown
      && JSON.stringify(current.mentions) === JSON.stringify(snapshot.mentions)
      && current.selections.length === snapshot.selections.length
      && current.selections.every((selection, index) => selection.button === snapshot.selections[index].button
        && selection.root === snapshot.selections[index].root && selection.text === snapshot.selections[index].text)
      && current.files.length === snapshot.files.length
      && current.files.every((button, index) => button === snapshot.files[index]);
  }

  async function restoreAttachments(item, composer) {
    const key = activeKey;
    if (!item.attachments?.length) return true;
    const input = findComposerForm(composer)?.querySelector('input[type="file"][aria-label="Attach files"], input[type="file"]');
    if (!input) return false;
    const transfer = new DataTransfer();
    for (const attachment of item.attachments) {
      if (typeof attachment?.name !== "string" || typeof attachment.dataUrl !== "string"
        || !/^data:[^,]*;base64,/.test(attachment.dataUrl)) return false;
      const bytes = Uint8Array.from(atob(attachment.dataUrl.slice(attachment.dataUrl.indexOf(",") + 1)), char => char.charCodeAt(0));
      transfer.items.add(new File([bytes], attachment.name, { type: attachment.type, lastModified: attachment.lastModified }));
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (!context.active() || composer !== findComposerInput() || conversationKey() !== key || activeKey !== key) return false;
      const state = composerContext(composer);
      if (state.files.length === item.attachments.length
        && !findComposerForm(composer)?.querySelector('[role="progressbar"], [aria-busy="true"]')) return true;
      await new Promise(resolve => window.setTimeout(resolve, 80));
    }
    return false;
  }

  const MENTION_ATTRIBUTES = [
    "app-mention-name", "app-mention-display-name", "app-mention-path",
    "app-mention-icon", "app-mention-brand-color",
    "data-prompt-link-href", "data-prompt-link-label",
  ];

  function normalizeMentions(mentions, text) {
    if (!Array.isArray(mentions)) return [];
    let end = 0;
    return mentions.filter(mention => {
      if (!mention || !Number.isInteger(mention.start) || !Number.isInteger(mention.end)
        || mention.start < end || mention.end <= mention.start || mention.end > text.length
        || text.slice(mention.start, mention.end) !== mention.label
        || !/^app:\/\//.test(mention.attributes?.["app-mention-path"] || "")) return false;
      end = mention.end;
      return true;
    }).map(mention => ({
      start: mention.start, end: mention.end, label: mention.label,
      attributes: Object.fromEntries(MENTION_ATTRIBUTES
        .filter(name => typeof mention.attributes[name] === "string")
        .map(name => [name, mention.attributes[name]])),
    }));
  }

  function composerMentions(composer) {
    if (!composer?.querySelector("[app-mention-path]")) return [];
    const clone = composer.cloneNode(true);
    const mentions = [...clone.querySelectorAll("[app-mention-path]")].map((node, index) => {
      const label = composerText(node);
      const marker = `\u0000ghrc-mention-${index}\u0000`;
      const attributes = Object.fromEntries(MENTION_ATTRIBUTES
        .filter(name => node.hasAttribute(name)).map(name => [name, node.getAttribute(name)]));
      node.replaceWith(document.createTextNode(marker));
      return { marker, label, attributes };
    });
    let text = composerText(clone);
    return mentions.map(mention => {
      const start = text.indexOf(mention.marker);
      text = text.replace(mention.marker, mention.label);
      return { start, end: start + mention.label.length, label: mention.label, attributes: mention.attributes };
    });
  }

  function mentionsMatch(composer, mentions) {
    return JSON.stringify(composerMentions(composer)) === JSON.stringify(mentions);
  }

  function moveMentions(mentions, before, after) {
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let end = before.length;
    let newEnd = after.length;
    while (end > start && newEnd > start && before[end - 1] === after[newEnd - 1]) { end--; newEnd--; }
    const delta = after.length - before.length;
    return mentions.flatMap(mention => {
      if (mention.end <= start) return [mention];
      if (mention.start >= end) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
      return [];
    });
  }

  function mentionClipboardHtml(text, mentions) {
    const escape = value => value.replace(/[&<>"']/g, char =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    let cursor = 0;
    let html = "";
    for (const mention of mentions) {
      html += escape(text.slice(cursor, mention.start)).replace(/\n/g, "<br>");
      const attributes = MENTION_ATTRIBUTES.filter(name => name in mention.attributes)
        .map(name => `${name}="${escape(mention.attributes[name])}"`).join(" ");
      html += `<span ${attributes} contenteditable="false">${escape(mention.label)}</span>`;
      cursor = mention.end;
    }
    return `<p>${html}${escape(text.slice(cursor)).replace(/\n/g, "<br>")}</p>`;
  }

  function conversationIdFromPath(pathname = location.pathname) {
    return String(pathname || "").match(/\/c\/([^/?#]+)(?:[/?#]|$)/i)?.[1] || "";
  }

  function conversationKey(pathname = location.pathname) {
    const conversationId = conversationIdFromPath(pathname);
    return conversationId ? `conversation:${conversationId}` : `new:${pageSessionId}`;
  }

  function normalizedText(value) {
    return typeof value === "string" ? value.replace(/\r\n/g, "\n") : "";
  }

  function textWithQuote(text, quote) {
    if (!quote) return text;
    const quoted = quote.split("\n").map(line => line.trim() ? `> ${line}` : ">").join("\n");
    return text.trim() ? `${quoted}\n\n${text}` : quoted;
  }

  function normalizeQueueItems(items) {
    if (!Array.isArray(items)) return [];

    return items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const text = normalizedText(item.text);
      const attachments = Array.isArray(item.attachments) ? item.attachments : [];
      const mentions = normalizeMentions(item.mentions, text);
      if (!text.trim() && !attachments.length) return [];
      return [{
        id: typeof item.id === "string" && item.id
          ? item.id
          : `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        text,
        attachments,
        mentions,
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      }];
    });
  }

  function queueCanAdvance(snapshot, settledMs) {
    if (!snapshot?.roleStateKnown) return false;
    if (snapshot.responseActive || !snapshot.composerReady) return false;
    if (snapshot.userTurns > 0 && !snapshot.latestUserAnswered) return false;
    if (snapshot.userTurns > 0 && !snapshot.latestAssistantComplete) return false;
    return settledMs >= COMPLETE_SETTLE_MS;
  }

  function shouldQueueComposerEnter(event) {
    return Boolean(
      event
      && event.key === "Enter"
      && !event.shiftKey
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.isComposing
      && event.keyCode !== 229
    );
  }

  function pumpSchedulingMode(hidden) {
    return hidden ? "timeout" : "frame";
  }

  const testApi = {
    COMPLETE_SETTLE_MS,
    conversationIdFromPath,
    normalizeQueueItems,
    pumpSchedulingMode,
    queueCanAdvance,
    shouldQueueComposerEnter,
  };

  if (globalThis.__GHRC_TEST__) {
    Object.assign(globalThis.__GHRC_TEST__, testApi);
    return;
  }

  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;

  // Keep the original bytes: uploaded chips alone cannot recreate a file.
  for (const type of ["change", "drop", "paste"]) {
    document.addEventListener(type, event => {
      const form = findComposerForm();
      if (!form?.contains(event.target)) return;
      const files = event.target?.files || event.dataTransfer?.files || event.clipboardData?.files;
      for (const file of files || []) capturedFiles.set(file.name, file);
    }, true);
  }

  function isVisible(element) {
    return Boolean(element?.isConnected && element.getClientRects().length);
  }

  function findComposerInput() {
    return document.querySelector('#prompt-textarea, [data-composer-markdown][contenteditable="true"]');
  }

  function findComposerForm(composer = findComposerInput()) {
    return composer?.closest("form")
      || composer?.closest('[data-type="unified-composer"]')
      || null;
  }

  function findActionButton(composer = findComposerInput()) {
    const form = findComposerForm(composer);
    if (!composer || !form) return null;

    const selectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop" i]',
      'button[data-testid="send-button"]',
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="Stop response" i]',
      'button[aria-label^="Send" i]:not([id^="ghrc-"])',
      'button#composer-submit-button',
      'button[aria-label="Start Voice" i]',
      'button[aria-label*="voice mode" i]',
      'button[type="submit"]:not([id^="ghrc-"]):not([class*="ghrc-"]):not([aria-label*="Search" i])',
    ];

    for (const selector of selectors) {
      const button = [...form.querySelectorAll(selector)].find(isVisible);
      if (button) return button;
    }
    // The hidden voice control still provides the correct position for an empty hat.
    if (document.documentElement.hasAttribute("data-ghrc-hide-dictation")) {
      return form.querySelector('button[aria-label="Start Voice" i], button[aria-label*="voice mode" i], button[data-testid*="voice" i], button[data-testid="composer-speech-button"]');
    }
    return null;
  }

  function findSendButton(composer = findComposerInput()) {
    const form = findComposerForm(composer);
    if (!composer || !form) return null;

    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label^="Send" i]:not([id^="ghrc-"])',
      'button#composer-submit-button:not([data-testid="stop-button"]):not([aria-label*="Stop" i]):not([aria-label*="voice" i])',
    ];

    for (const selector of selectors) {
      const button = [...form.querySelectorAll(selector)].find(isVisible);
      if (button) return button;
    }

    return [...form.querySelectorAll('button[type="submit"]')]
      .find((button) => (
        isVisible(button)
        && button.getAttribute("data-testid") !== "stop-button"
        && !button.id.startsWith("ghrc-")
        && !button.className.includes("ghrc-")
        && !/stop|voice|search/i.test(button.getAttribute("aria-label") || "")
      )) || null;
  }

  function responseIsActive(composer = findComposerInput()) {
    const form = findComposerForm(composer);
    const selectors = [
      'button[data-testid="stop-button"]',
      'button[data-testid*="stop" i]',
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="Stop response" i]',
      'button[aria-label="Stop" i]',
    ];

    const root = form || document;
    return selectors.some((selector) =>
      [...root.querySelectorAll(selector)].some(isVisible)
    );
  }

  function composerText(composer = findComposerInput()) {
    if (!composer) return "";
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      return composer.value;
    }

    const paragraphs = [...(composer.children || [])];
    if (paragraphs.length && paragraphs.every((node) => node.tagName === "P")) {
      const readNode = (node) => {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
        if (node.nodeName === "BR") {
          return node.classList.contains("ProseMirror-trailingBreak") ? "" : "\n";
        }
        return [...node.childNodes].map(readNode).join("");
      };
      return paragraphs.map(node => node.childNodes.length === 1
        && node.firstChild.nodeName === "BR" ? "" : readNode(node)).join("\n");
    }

    return composer.innerText || composer.textContent || "";
  }

  function textMatchesComposer(composer, text) {
    const normalize = (value) => normalizedText(value).replace(/\n+$/, "");
    return normalize(composerText(composer)) === normalize(text);
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
      inputType: text ? "insertText" : "deleteContentBackward",
      data: text || null,
    }));
    return control.value === text;
  }

  async function replaceComposerText(composer, text, mentions = []) {
    if (!composer) return false;
    if (textMatchesComposer(composer, text) && mentionsMatch(composer, mentions)) return true;

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

    if (!text) {
      document.execCommand("delete");
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
        data: null,
      }));
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      return !composerText(composer).trim();
    }

    if (mentions.length) {
      // Let the host editor parse app nodes so React/ProseMirror retains their identity.
      // Never fall back to plain text when that would silently lose the selected app.
      try {
        document.execCommand("delete");
        await new Promise(resolve => window.setTimeout(resolve, 40));
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", text);
        clipboardData.setData("text/html", mentionClipboardHtml(text, mentions));
        composer.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
        await new Promise(resolve => window.setTimeout(resolve, 60));
        return textMatchesComposer(composer, text) && mentionsMatch(composer, mentions);
      } catch {
        return false;
      }
    }

    // Native text insertion keeps large queued prompts as text. ChatGPT's
    // paste handler converts long clipboard text into a file attachment.
    document.execCommand("insertText", false, text);
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    if (textMatchesComposer(composer, text)) return true;

    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      const unhandled = composer.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }));
      if (!unhandled) {
        await new Promise((resolve) => window.setTimeout(resolve, 60));
        if (textMatchesComposer(composer, text)) return true;
      }
    } catch {
      // Fall through to insertText for browsers that reject synthetic clipboard data.
    }

    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("insertText", false, text);
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    return textMatchesComposer(composer, text);
  }

  function roleTurns(role) {
    const roleNodes = [...document.querySelectorAll(
      `[data-message-author-role="${role}"], [data-content-search-unit-key$=":${role}"]`
      + (role === "assistant" ? ', [data-testid="generated-image-gallery"]' : '')
    )];
    const turns = [];
    const seen = new Set();

    for (const node of roleNodes) {
      const turn = node.closest('[data-testid^="conversation-turn-"]')
        || node.closest("article")
        || (node.matches('[data-content-search-unit-key], [data-testid="generated-image-gallery"]') ? node.closest(".group") : null)
        || node;
      if (!seen.has(turn)) {
        seen.add(turn);
        turns.push(turn);
      }
    }
    return turns;
  }

  function latestAssistantIsComplete(assistantTurns) {
    const latest = assistantTurns[assistantTurns.length - 1];
    if (!latest) return false;

    // Image-only replies can omit the assistant role and text action toolbar.
    // Require a decoded generated preview, rather than a loading placeholder.
    const generatedImages = [...latest.querySelectorAll('[data-testid="generated-image-preview"] img')];
    if (generatedImages.length && generatedImages.every(image => image.complete && image.naturalWidth > 0)
      && !latest.querySelector('[aria-busy="true"], [role="progressbar"]')) return true;

    // Current ChatGPT groups user and assistant content in the same container.
    // Its user "Copy message" action must not count as assistant completion.
    if (latest.querySelector('[data-content-search-unit-key]')
      && !latest.querySelector('[data-message-author-role="assistant"]')) {
      return Boolean(latest.querySelector(
        '.turn-action-controls button[aria-label="Copy"], '
        + '.turn-action-controls button[aria-label*="Good response" i], '
        + '.turn-action-controls button[aria-label*="Bad response" i], '
        + '.turn-action-controls button[aria-label*="Regenerate" i]'
      ));
    }

    const completionSelectors = [
      '[data-message-status="finished"]',
      '[data-state="complete"]',
      'button[data-testid="copy-turn-action-button"]',
      'button[data-testid*="copy" i]',
      'button[aria-label^="Copy" i]',
      'button[aria-label*="Good response" i]',
      'button[aria-label*="Bad response" i]',
      'button[aria-label*="Regenerate" i]',
    ];

    return completionSelectors.some((selector) =>
      Boolean(latest.matches?.(selector) || latest.querySelector?.(selector))
    );
  }

  function lifecycleSnapshot() {
    const composer = findComposerInput();
    const userTurns = roleTurns("user");
    const assistantTurns = roleTurns("assistant");
    // Earlier interrupted replies can leave more user messages than answers.
    // Check message order instead of requiring lifetime counts to balance.
    const latestUser = [...document.querySelectorAll('[data-message-author-role="user"], [data-content-search-unit-key$=":user"]')].at(-1);
    const latestAssistant = [...document.querySelectorAll('[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"], [data-testid="generated-image-gallery"]')].at(-1);
    const latestUserAnswered = Boolean(latestUser && latestAssistant
      && (latestUser.compareDocumentPosition(latestAssistant) & Node.DOCUMENT_POSITION_FOLLOWING));
    const turnCount = document.querySelectorAll('[data-testid^="conversation-turn-"], [data-content-search-unit-key]').length;
    const roleStateKnown = turnCount === 0 || userTurns.length + assistantTurns.length > 0;

    return {
      responseActive: responseIsActive(composer),
      composerReady: Boolean(composer && isVisible(composer) && !composer.disabled
        && composer.getAttribute("aria-disabled") !== "true"),
      userTurns: userTurns.length,
      assistantTurns: assistantTurns.length,
      latestUserAnswered,
      latestAssistantComplete: latestAssistantIsComplete(assistantTurns),
      roleStateKnown,
    };
  }

  function itemId() {
    return globalThis.crypto?.randomUUID?.()
      || `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function storageCopy() {
    return queue.map(({ id, text, createdAt, attachments, mentions }) => ({ id, text, createdAt, attachments, mentions }));
  }

  function persistQueue() {
    if (!context.active()) return Promise.resolve();
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    // Capture the conversation before asynchronous storage reads or navigation.
    const key = activeKey;
    const items = storageCopy();
    const paused = queuePaused;
    persistPending = persistPending.catch(() => {}).then(async () => {
      if (!context.active()) return;
      const stored = await chrome.storage.local.get({
        [STORAGE_KEY]: {}, [PAUSED_STORAGE_KEY]: {},
      });
      if (!context.active()) return;
      const next = { ...stored[STORAGE_KEY] };
      const pausedState = { ...stored[PAUSED_STORAGE_KEY] };
      if (items.length) next[key] = items;
      else delete next[key];
      if (paused) pausedState[key] = true;
      else delete pausedState[key];
      await chrome.storage.local.set({
        [STORAGE_KEY]: next, [PAUSED_STORAGE_KEY]: pausedState,
      });
    });
    return persistPending;
  }

  function schedulePersist() {
    if (!context.active()) return;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void context.run(() => persistQueue());
    }, SAVE_DEBOUNCE_MS);
  }

  async function loadQueueState() {
    if (!context.active()) return;
    const stored = await chrome.storage.local.get({
      [STORAGE_KEY]: {},
      [PAUSED_STORAGE_KEY]: {},
      [QUEUE_BUTTON_SETTING_KEY]: false,
    });
    if (!context.active()) return;
    showQueueButton = Boolean(stored[QUEUE_BUTTON_SETTING_KEY]);
    storageState = stored[STORAGE_KEY] && typeof stored[STORAGE_KEY] === "object"
      ? stored[STORAGE_KEY]
      : {};
    queuePaused = Boolean(stored[PAUSED_STORAGE_KEY]?.[activeKey]);
    queue = normalizeQueueItems(storageState[activeKey]);
    stateLoaded = true;
    renderQueue();
    scheduleMount();
    schedulePump();
  }

  async function syncConversationKey() {
    if (!context.active()) return;
    if (routeSyncRunning) return;
    const nextKey = conversationKey();
    if (nextKey === activeKey) return;

    routeSyncRunning = true;
    try {
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
        await persistQueue();
      }

      await persistPending;
      if (!context.active()) return;
      const previousKey = activeKey;
      const stored = await chrome.storage.local.get({ [STORAGE_KEY]: {}, [PAUSED_STORAGE_KEY]: {} });
      if (!context.active()) return;
      const nextState = stored[STORAGE_KEY] && typeof stored[STORAGE_KEY] === "object"
        ? { ...stored[STORAGE_KEY] }
        : {};
      const previousItems = normalizeQueueItems(nextState[previousKey]);
      const nextItems = normalizeQueueItems(nextState[nextKey]);

      if (
        previousKey.startsWith("new:")
        && nextKey.startsWith("conversation:")
        && previousItems.length
      ) {
        nextState[nextKey] = [...previousItems, ...nextItems];
        delete nextState[previousKey];
        const pausedState = { ...stored[PAUSED_STORAGE_KEY] };
        if (pausedState[previousKey]) pausedState[nextKey] = true;
        delete pausedState[previousKey];
        stored[PAUSED_STORAGE_KEY] = pausedState;
        await chrome.storage.local.set({ [STORAGE_KEY]: nextState, [PAUSED_STORAGE_KEY]: pausedState });
      }

      activeKey = nextKey;
      queuePaused = Boolean(stored[PAUSED_STORAGE_KEY]?.[nextKey]);
      storageState = nextState;
      queue = normalizeQueueItems(nextState[nextKey]);
      completionCandidateSince = null;
      renderQueue();
      scheduleMount();
      schedulePump();
    } finally {
      routeSyncRunning = false;
    }
  }

  function autosizeTextarea(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(180, Math.max(44, textarea.scrollHeight))}px`;
  }

  function moveItem(id, direction) {
    const index = queue.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= queue.length) return;
    [queue[index], queue[target]] = [queue[target], queue[index]];
    void context.run(() => persistQueue());
    renderQueue();
    schedulePump();
  }

  function removeItem(id) {
    queue = queue.filter((item) => item.id !== id);
    void context.run(() => persistQueue());
    renderQueue();
    schedulePump();
  }

  function createItemRow(item, index) {
    const row = document.createElement("article");
    row.className = "ghrc-message-queue-item";
    row.dataset.queueId = item.id;
    if (item.id === sendingItemId) row.dataset.sending = "true";

    const ordinal = document.createElement("span");
    ordinal.className = "ghrc-message-queue-index";
    ordinal.textContent = index === 0 ? "Next" : String(index + 1);

    const textarea = document.createElement("textarea");
    textarea.className = "ghrc-message-queue-editor";
    textarea.value = item.text;
    textarea.rows = 1;
    textarea.spellcheck = true;
    textarea.disabled = item.id === sendingItemId;
    textarea.setAttribute("aria-label", `Queued message ${index + 1}`);
    textarea.addEventListener("input", () => {
      const target = queue.find((candidate) => candidate.id === item.id);
      if (!target) return;
      target.mentions = moveMentions(target.mentions || [], target.text, textarea.value);
      target.text = textarea.value;
      autosizeTextarea(textarea);
      schedulePersist();
    });
    requestAnimationFrame(() => autosizeTextarea(textarea));

    const controls = document.createElement("div");
    controls.className = "ghrc-message-queue-controls";

    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "↑";
    up.title = "Move earlier";
    up.setAttribute("aria-label", "Move queued message earlier");
    up.disabled = index === 0 || item.id === sendingItemId;
    up.addEventListener("click", () => moveItem(item.id, -1));

    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "↓";
    down.title = "Move later";
    down.setAttribute("aria-label", "Move queued message later");
    down.disabled = index === queue.length - 1 || item.id === sendingItemId;
    down.addEventListener("click", () => moveItem(item.id, 1));

    const moveControls = document.createElement("span");
    moveControls.className = "ghrc-message-queue-move-controls";
    moveControls.append(up, down);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove queued message";
    remove.setAttribute("aria-label", "Remove queued message");
    remove.disabled = item.id === sendingItemId;
    remove.addEventListener("click", () => removeItem(item.id));

    const steer = document.createElement("button");
    steer.type = "button";
    steer.className = "ghrc-message-queue-steer";
    steer.textContent = "Steer";
    steer.title = "Interrupt and send this queued message";
    steer.setAttribute("aria-label", "Steer queued message");
    steer.disabled = Boolean(sendingItemId) || interruptRunning || enqueueRunning || routeSyncRunning;
    steer.addEventListener("click", () => void context.run(() => sendQueueHead(item.id, true)));

    controls.append(steer, moveControls, remove);
    if (item.attachments?.length) {
      const names = item.attachments.map(file => file.name).join(", ");
      textarea.setAttribute("aria-description", `Attachments: ${names}`);
      row.title = `Attachments: ${names}`;
    }
    row.append(ordinal, textarea, controls);
    return row;
  }

  function createPanel() {
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.setAttribute("aria-label", "Queued messages");

    const header = document.createElement("header");
    header.className = "ghrc-message-queue-header";

    const title = document.createElement("strong");
    title.className = "ghrc-message-queue-title";

    const status = document.createElement("span");
    status.className = "ghrc-message-queue-status";
    status.hidden = true;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ghrc-message-queue-toggle";
    toggle.addEventListener("click", () => {
      queuePaused = !queuePaused;
      completionCandidateSince = null;
      void context.run(() => persistQueue());
      renderQueue();
      schedulePump();
    });
    header.append(title, status, toggle);

    const list = document.createElement("div");
    list.className = "ghrc-message-queue-list";
    panel.append(header, list);
    return panel;
  }

  function renderQueue() {
    let panel = document.getElementById(PANEL_ID);
    if (!queue.length) {
      panel?.remove();
      return;
    }

    if (!panel) panel = createPanel();
    const title = panel.querySelector(".ghrc-message-queue-title");
    const list = panel.querySelector(".ghrc-message-queue-list");
    title.textContent = `Queue · ${queue.length}`;
    const status = panel.querySelector(".ghrc-message-queue-status");
    status.hidden = !queuePaused;
    status.textContent = queuePaused ? "Stopped - messages saved" : "";
    const toggle = panel.querySelector(".ghrc-message-queue-toggle");
    toggle.textContent = queuePaused ? "Resume" : "Wait";
    toggle.setAttribute("aria-label", toggle.textContent);
    list.replaceChildren(...queue.map(createItemRow));

    const form = findComposerForm();
    if (form?.parentElement && panel.parentElement !== form.parentElement) {
      form.parentElement.insertBefore(panel, form);
    } else if (form && panel.nextElementSibling !== form) {
      form.before(panel);
    }

  }

  function createQueueButton() {
    const button = document.createElement("button");
    button.id = QUEUE_BUTTON_ID;
    button.type = "button";
    button.title = "Queue current message";
    button.setAttribute("aria-label", "Queue current message");
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 6h10M7 11h10M7 16h6M18 14v6m-3-3h6" />
      </svg>
      <span class="ghrc-message-queue-badge" aria-hidden="true"></span>
    `;
    button.addEventListener("click", () => {
      void context.run(() => enqueueComposerMessage());
    });
    return button;
  }

  function mountQueueUi() {
    if (!context.active()) return;
    mountScheduled = false;
    const steeringBusy = Boolean(sendingItemId) || interruptRunning || enqueueRunning || routeSyncRunning;
    for (const steer of document.querySelectorAll(".ghrc-message-queue-steer")) {
      if (steer.disabled !== steeringBusy) steer.disabled = steeringBusy;
    }
    const composer = findComposerInput();
    const actionButton = findActionButton(composer);
    if (!composer || !actionButton?.parentElement) {
      document.getElementById(QUEUE_BUTTON_ID)?.remove();
      document.getElementById(INTERRUPT_BUTTON_ID)?.remove();
      return;
    }

    let button = document.getElementById(QUEUE_BUTTON_ID);
    if (showQueueButton) {
      if (!button) button = createQueueButton();
      button.disabled = !stateLoaded || steeringBusy || Boolean(enterPending);

      const badge = button.querySelector(".ghrc-message-queue-badge");
      const badgeText = queue.length ? String(queue.length) : "";
      if (badge.textContent !== badgeText) badge.textContent = badgeText;
      if (badge.hidden !== (queue.length === 0)) badge.hidden = queue.length === 0;
      const title = queue.length
        ? `Queue current message (${queue.length} waiting)`
        : "Queue current message";
      if (button.title !== title) button.title = title;
    } else {
      button?.remove();
      button = null;
    }

    let interruptButton = document.getElementById(INTERRUPT_BUTTON_ID);
    const hasDraft = Boolean(composerText(composer).trim());
    const activeResponse = responseIsActive(composer);
    const emptyHat = !activeResponse && !hasDraft && !findSendButton(composer)
      && document.documentElement.hasAttribute("data-ghrc-hide-dictation");
    if ((activeResponse && hasDraft) || emptyHat) {
      if (!interruptButton) {
        interruptButton = document.createElement("button");
        interruptButton.id = INTERRUPT_BUTTON_ID;
        interruptButton.type = "button";
        interruptButton.addEventListener("click", () => void context.run(interruptAndSend));
      }
      const title = emptyHat ? "Write a message to send" : "Interrupt response and send now";
      const label = emptyHat ? "Send message" : "Interrupt and send";
      if (interruptButton.title !== title) interruptButton.title = title;
      if (interruptButton.getAttribute("aria-label") !== label) interruptButton.setAttribute("aria-label", label);
      interruptButton.disabled = emptyHat || interruptRunning || Boolean(sendingItemId) || enqueueRunning;
      if (interruptButton.parentElement !== actionButton.parentElement
        || interruptButton.nextElementSibling !== actionButton) {
        actionButton.before(interruptButton);
      }
    } else {
      interruptButton?.remove();
      interruptButton = null;
    }
    const clipboardButton = document.getElementById("ghrc-clipboard-send-button");
    const nextButton = clipboardButton?.parentElement === actionButton.parentElement
      ? clipboardButton : (interruptButton || actionButton);
    if (button && (button.parentElement !== actionButton.parentElement || button.nextElementSibling !== nextButton)) {
      nextButton.before(button);
    }

    if (queue.length) {
      const panel = document.getElementById(PANEL_ID);
      const form = findComposerForm(composer);
      if (!panel) {
        renderQueue();
      } else if (form?.parentElement && panel.parentElement !== form.parentElement) {
        form.parentElement.insertBefore(panel, form);
      } else if (form && panel.nextElementSibling !== form) {
        form.before(panel);
      }
    }
  }

  function scheduleMount() {
    if (!context.active()) return;
    if (mountScheduled) return;
    mountScheduled = true;
    requestAnimationFrame(mountQueueUi);
  }

  async function interruptAndSend() {
    if (!context.active()) return false;
    if (interruptRunning || sendingItemId || enqueueRunning || routeSyncRunning) return;
    const composer = findComposerInput();
    const text = composerText(composer);
    const key = activeKey;
    if (!composer || !text.trim()) return;

    interruptRunning = true;
    completionCandidateSince = null;
    scheduleMount();
    try {
      if (responseIsActive(composer)) {
        const stop = findActionButton(composer);
        if (!stop || stop.disabled) return;
        stop.click();
      }
      const deadline = Date.now() + SUBMIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (!context.active() || key !== activeKey || conversationKey() !== key || routeSyncRunning
          || composer !== findComposerInput() || !composer.isConnected
          || !textMatchesComposer(composer, text)) return;

        const sendButton = findSendButton(composer);
        if (!responseIsActive(composer) && sendButton && !sendButton.disabled
          && sendButton.getAttribute("aria-disabled") !== "true") {
          const beforeUserTurns = roleTurns("user").length;
          sendButton.click();
          await waitForSubmission(composer, text, beforeUserTurns);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 80));
      }
    } finally {
      interruptRunning = false;
      scheduleMount();
      schedulePump();
    }
  }

  async function enqueueText(text, attachments = [], mentions = []) {
    if (!context.active()) return false;
    if (!stateLoaded || routeSyncRunning || conversationKey() !== activeKey) return false;
    text = normalizedText(text);
    if (!text.trim() && !attachments.length) return false;
    const item = { id: itemId(), text, attachments, mentions, createdAt: Date.now() };
    queue.push(item);
    completionCandidateSince = null;
    renderQueue();
    scheduleMount();
    try {
      await persistQueue();
    } catch (error) {
      queue = queue.filter(entry => entry.id !== item.id);
      renderQueue();
      scheduleMount();
      throw error;
    }
    if (!context.active()) return false;
    schedulePump();
    return true;
  }

  // Content scripts share an isolated world. Clipboard sends enter the FIFO
  // without replacing the user's draft or clicking the native Stop button.
  globalThis.__ghrcMessageQueue = { enqueueText: text => context.run(() => enqueueText(text)), findActionButton };

  async function enqueueComposerMessage() {
    if (!context.active()) return false;
    if (!stateLoaded || enqueueRunning || sendingItemId || routeSyncRunning || interruptRunning) return false;
    window.dispatchEvent(new Event("ghrc:before-composer-send"));
    enqueueRunning = true;
    scheduleMount();
    try {
      const composer = findComposerInput();
      const text = normalizedText(composerText(composer));
      if (!composer) return false;
      const snapshot = await captureComposerContext(composer);
      if (!snapshot || !contextMatches(snapshot.state, composer)) return false;
      const queuedText = textWithQuote(text, snapshot.quote);
      const queued = await enqueueText(queuedText, snapshot.attachments, snapshot.mentions.map(mention => ({
        ...mention, start: mention.start + queuedText.length - text.length, end: mention.end + queuedText.length - text.length,
      })));
      if (queued && !await clearComposerContext(snapshot, composer)) {
        queuePaused = true;
        await persistQueue();
      }
      // Keep the draft until storage accepts it, and preserve edits made while saving.
      if (queued && composer === findComposerInput() && textMatchesComposer(composer, text)) {
        await replaceComposerText(composer, "");
        composer.focus({ preventScroll: true });
      }
      return queued;
    } finally {
      enqueueRunning = false;
      scheduleMount();
      schedulePump();
    }
  }

  async function waitForSubmission(composer, originalText, beforeUserTurns) {
    const deadline = Date.now() + SUBMIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 80));
      const userTurns = roleTurns("user").length;
      if (userTurns > beforeUserTurns) return true;
      if (!textMatchesComposer(composer, originalText) && responseIsActive()) return true;
    }
    return false;
  }

  async function sendQueueHead(id = queue[0]?.id, steer = false) {
    if (!context.active()) return false;
    if (!stateLoaded || sendingItemId || enqueueRunning || interruptRunning
      || routeSyncRunning || conversationKey() !== activeKey || (queuePaused && !steer)) return;

    const key = activeKey;
    const item = queue.find(candidate => candidate.id === id);
    if (!item) return;
    if (!item.text.trim() && !item.attachments?.length) {
      queue = queue.filter(candidate => candidate.id !== item.id);
      await persistQueue();
      renderQueue();
      schedulePump();
      return;
    }

    const composer = findComposerInput();
    if (!composer || hasComposerContext(composer)) return;
    let draft = composerText(composer);
    let draftMentions = composerMentions(composer);
    let composerReplaced = false;
    let restoredContext = null;
    const focused = document.activeElement;
    window.dispatchEvent(new Event("ghrc:before-composer-send"));
    sendingItemId = item.id;
    renderQueue();

    try {
      if (steer && responseIsActive(composer)) {
        const stop = findActionButton(composer);
        if (!stop || stop.disabled || stop.getAttribute("aria-disabled") === "true") return;
        stop.click();
        const stopDeadline = Date.now() + SUBMIT_TIMEOUT_MS;
        while (responseIsActive(composer) && Date.now() < stopDeadline) {
          if (!context.active() || key !== activeKey || conversationKey() !== key || routeSyncRunning
            || composer !== findComposerInput() || !composer.isConnected) return;
          await new Promise(resolve => window.setTimeout(resolve, 80));
        }
        if (responseIsActive(composer)) return;
      }
      if (!context.active() || key !== activeKey || conversationKey() !== key || routeSyncRunning
        || composer !== findComposerInput() || !composer.isConnected
        || !queue.some(candidate => candidate.id === item.id)) return;
      draft = composerText(composer);
      draftMentions = composerMentions(composer);
      const beforeUserTurns = roleTurns("user").length;
      if (hasComposerContext(composer)) return;
      composerReplaced = true;
      if (!await restoreAttachments(item, composer)) return;
      restoredContext = composerContext(composer);
      if (!await replaceComposerText(composer, item.text, item.mentions || [])) return;
      restoredContext.mentions = item.mentions || [];

      const deadline = Date.now() + SUBMIT_TIMEOUT_MS;
      let sendButton = findSendButton(composer);
      while (
        Date.now() < deadline
        && (
          !sendButton
          || sendButton.disabled
          || sendButton.getAttribute("aria-disabled") === "true"
        )
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, 80));
        sendButton = findSendButton(composer);
      }

      if (
        !sendButton
        || sendButton.disabled
        || sendButton.getAttribute("aria-disabled") === "true"
      ) {
        return;
      }

      if (!context.active() || (queuePaused && !steer) || key !== activeKey || conversationKey() !== key
        || routeSyncRunning || responseIsActive()
        || !textMatchesComposer(composer, item.text)
        || !mentionsMatch(composer, item.mentions || [])
        || !contextMatches(restoredContext, composer)) return;
      sendButton.click();

      if (!await waitForSubmission(composer, item.text, beforeUserTurns)) return;

      // A first send can create a conversation while submission is pending.
      // Only acknowledge the same item if it migrated with that new chat.
      if (key !== activeKey && !(key.startsWith("new:")
        && activeKey.startsWith("conversation:")
        && queue.some((candidate) => candidate.id === item.id))) return;
      if (queue[0]?.id === item.id) queue.shift();
      else queue = queue.filter((candidate) => candidate.id !== item.id);
      completionCandidateSince = null;
      await persistQueue();
    } finally {
      const sameConversation = key === activeKey || (key.startsWith("new:")
        && activeKey.startsWith("conversation:") && conversationKey() === activeKey);
      if (composerReplaced && item.attachments?.length && sameConversation
        && composer === findComposerInput() && queue.some(candidate => candidate.id === item.id)) {
        for (const button of restoredContext?.files || []) {
          if (button.isConnected) button.click();
        }
      }
      if (composerReplaced && sameConversation && conversationKey() === activeKey
        && composer === findComposerInput()) {
        const current = composerText(composer);
        const restored = !current.trim() || textMatchesComposer(composer, item.text)
          ? draft : (draft ? `${draft}\n${current}` : current);
        await replaceComposerText(composer, restored, moveMentions(draftMentions, draft, restored));
        if (focused?.isConnected) focused.focus({ preventScroll: true });
      }
      if (sameConversation && queue.some((candidate) => candidate.id === item.id)) {
        // An unconfirmed send must require a deliberate retry, even if the
        // site cleared the composer. Preserve any draft typed in the meantime.
        queuePaused = true;
        await persistQueue();
      }
      sendingItemId = null;
      renderQueue();
      scheduleMount();
      schedulePump();
    }
  }

  function evaluatePump() {
    if (!context.active()) return;
    pumpScheduled = false;
    if (!stateLoaded || !queue.length || sendingItemId || queuePaused || routeSyncRunning || enqueueRunning || enterPending || interruptRunning) {
      completionCandidateSince = null;
      return;
    }

    const composer = findComposerInput();
    if (!composer || nativeSubmissionPending(composer)) {
      completionCandidateSince = null;
      return;
    }

    const snapshot = lifecycleSnapshot();
    const structurallyReady = queueCanAdvance(snapshot, COMPLETE_SETTLE_MS);
    if (!structurallyReady) {
      completionCandidateSince = null;
      return;
    }

    if (completionCandidateSince === null) {
      completionCandidateSince = Date.now();
      return;
    }

    const settledMs = Date.now() - completionCandidateSince;
    if (!queueCanAdvance(snapshot, settledMs)) return;
    void context.run(() => sendQueueHead());
  }

  function clearScheduledPump() {
    if (pumpScheduleHandle === null) return;
    if (pumpScheduleMode === "frame") cancelAnimationFrame(pumpScheduleHandle);
    else window.clearTimeout(pumpScheduleHandle);
    pumpScheduleHandle = null;
    pumpScheduleMode = null;
    pumpScheduled = false;
  }

  function runScheduledPump() {
    pumpScheduleHandle = null;
    pumpScheduleMode = null;
    evaluatePump();
  }

  function schedulePump() {
    if (!context.active()) return;
    if (pumpScheduled) return;
    pumpScheduled = true;
    pumpScheduleMode = pumpSchedulingMode(document.hidden);
    pumpScheduleHandle = pumpScheduleMode === "frame"
      ? requestAnimationFrame(runScheduledPump)
      : window.setTimeout(runScheduledPump, 0);
  }

  function reschedulePumpForVisibility() {
    if (!context.active()) return;
    clearScheduledPump();
    schedulePump();
  }

  async function queueComposerEnter(composer, text, key) {
    const contextRequest = captureComposerContext(composer);
    enterPending++;
    pendingEnterTexts.add(text);
    const request = enterChain.catch(() => {}).then(async () => {
      await queueStateRequest;
      const deadline = Date.now() + SUBMIT_TIMEOUT_MS;
      while (context.active() && routeSyncRunning && Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 20));
      }
      if (!context.active() || !stateLoaded || routeSyncRunning
        || conversationKey() !== key || composer !== findComposerInput()) return;
      if (activeKey !== key) await syncConversationKey();
      if (context.active() && activeKey === key && composer === findComposerInput()) {
        const snapshot = await contextRequest;
        if (!snapshot || !contextMatches(snapshot.state, composer)) return;
        const queuedText = textWithQuote(text, snapshot.quote);
        const queued = await enqueueText(queuedText, snapshot.attachments, snapshot.mentions.map(mention => ({
          ...mention, start: mention.start + queuedText.length - text.length, end: mention.end + queuedText.length - text.length,
        })));
        if (queued && !await clearComposerContext(snapshot, composer)) {
          queuePaused = true;
          await persistQueue();
        }
        if (queued && composer === findComposerInput() && textMatchesComposer(composer, text)) {
          await replaceComposerText(composer, "");
          composer.focus({ preventScroll: true });
        }
      }
    });
    enterChain = request;
    try {
      await request;
    } finally {
      enterPending--;
      pendingEnterTexts.delete(text);
      scheduleMount();
      schedulePump();
    }
  }

  function nativeSubmissionPending(composer) {
    if (!nativeSubmission) return false;
    if (nativeSubmission.composer !== composer || Date.now() >= nativeSubmission.deadline
      || roleTurns("user").length > nativeSubmission.userTurns || responseIsActive(composer)) {
      nativeSubmission = null;
      return false;
    }
    return true;
  }

  function composerAutocompleteIsOpen(composer) {
    // The composer owns Enter while its plugin/file suggestions are open.
    // Modern ChatGPT portals use plain buttons rather than ARIA menu items.
    const activeOption = document.getElementById(composer.getAttribute('aria-activedescendant') || '');
    if (isVisible(activeOption) && !activeOption.closest('[inert]')) return true;
    if (composer.getAttribute('aria-expanded') === 'true') {
      for (const id of (composer.getAttribute('aria-controls') || '').split(/\s+/)) {
        const popup = document.getElementById(id);
        if (isVisible(popup) && !popup.closest('[inert]')) return true;
      }
    }
    return [...document.querySelectorAll('[data-mention-list-scroll-area]')]
      .some(popup => isVisible(popup) && !popup.closest('[inert]')
        && getComputedStyle(popup).visibility !== 'hidden');
  }

  function handleComposerEnter(event) {
    if (!context.active()) return;
    const composer = event.target?.closest?.('#prompt-textarea, [data-composer-markdown][contenteditable="true"]');
    if (!composer || composer !== findComposerInput()) return;
    if (!shouldQueueComposerEnter(event)) return;
    if (composerAutocompleteIsOpen(composer)) return;
    const text = normalizedText(composerText(composer));
    if (event.repeat || sendingItemId || pendingEnterTexts.has(text) || enqueueRunning || interruptRunning) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const snapshot = lifecycleSnapshot();
    const overviewReady = location.pathname === "/" && !stateLoaded;
    const composerState = composerContext(composer);
    const hasMessage = Boolean(text.trim() || composerState.files.length || composerState.quote || composerState.selections.length);
    if (hasMessage && !nativeSubmissionPending(composer) && (stateLoaded || overviewReady)
      && activeKey === conversationKey() && !queue.length && !enterPending && !routeSyncRunning
      && queueCanAdvance(snapshot, COMPLETE_SETTLE_MS)) {
      // Mark the gap before ChatGPT paints Stop or the next user turn.
      nativeSubmission = { composer, userTurns: snapshot.userTurns, deadline: Date.now() + SUBMIT_TIMEOUT_MS };
      return;
    }

    window.dispatchEvent(new Event("ghrc:before-composer-send"));
    event.preventDefault();
    event.stopImmediatePropagation();
    if (hasMessage) void context.run(() => queueComposerEnter(composer, text, conversationKey()));
  }
  // Capture before React's document/composer handlers can turn Enter into Stop.
  window.addEventListener("keydown", handleComposerEnter, true);

  document.addEventListener("input", (event) => {
    if (event.target?.closest?.('#prompt-textarea, [data-composer-markdown][contenteditable="true"]')) scheduleMount();
  }, true);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[QUEUE_BUTTON_SETTING_KEY]) {
      showQueueButton = Boolean(changes[QUEUE_BUTTON_SETTING_KEY].newValue);
      scheduleMount();
    }
    if (changes[PAUSED_STORAGE_KEY]) {
      queuePaused = Boolean(changes[PAUSED_STORAGE_KEY].newValue?.[activeKey]);
      completionCandidateSince = null;
      renderQueue();
      schedulePump();
    }
    if (!changes[STORAGE_KEY]) return;
    const nextState = changes[STORAGE_KEY].newValue;
    if (!nextState || typeof nextState !== "object") return;
    const nextQueue = normalizeQueueItems(nextState[activeKey]);
    if (JSON.stringify(nextQueue) === JSON.stringify(storageCopy())) return;

    storageState = nextState;
    queue = nextQueue;
    completionCandidateSince = null;
    renderQueue();
    schedulePump();
  });

  const observer = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      void context.run(() => syncConversationKey());
    }
    scheduleMount();
    schedulePump();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-disabled", "data-testid", "data-message-status", "data-state", "data-ghrc-hide-dictation"],
  });

  const pumpInterval = window.setInterval(schedulePump, PUMP_INTERVAL_MS);
  document.addEventListener("visibilitychange", reschedulePumpForVisibility);
  context.onStop(() => {
    window.removeEventListener("keydown", handleComposerEnter, true);
    observer.disconnect();
    clearInterval(pumpInterval);
    clearScheduledPump();
    document.removeEventListener("visibilitychange", reschedulePumpForVisibility);
    if (saveTimer !== null) clearTimeout(saveTimer);
  });
  window.addEventListener("popstate", () => void context.run(syncConversationKey));
  window.addEventListener("ghrc:route-change", () => void context.run(syncConversationKey));
  window.addEventListener("pageshow", () => {
    void context.run(() => syncConversationKey());
    scheduleMount();
    schedulePump();
  });

  queueStateRequest = context.run(() => loadQueueState());
})();
