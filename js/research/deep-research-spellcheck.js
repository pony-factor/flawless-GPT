(() => {
  "use strict";
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;

  const DEEP_RESEARCH = "app://connector_openai_deep_research";
  const BANNER_ID = "ghrc-research-spellcheck-review";
  const SETTING_KEY = "deepResearchSpellcheckEnabled";
  // Never intercept Send before the saved preference is known.
  let spellcheckEnabled = false;
  let settingsRevision = 0;
  let running = false;
  let activeId = null;
  let activePath = null;
  let approvedText = null;
  let approvedPath = null;

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = node => Boolean(node?.isConnected && node.getClientRects?.().length);
  const editor = () => document.querySelector('[data-composer-markdown][contenteditable="true"], #prompt-textarea');
  const form = input => input?.closest("form") || input?.closest('[data-type="unified-composer"]');
  // Root is a new chat; /c/… and /g/…/c/… are existing conversations.
  const chatIsSupported = () => location.pathname === "/"
    || /^\/(?:g\/[^/]+\/)?c\/[a-z0-9-]+\/?$/i.test(location.pathname);

  function mention(input) {
    const scope = form(input) || input;
    return scope?.querySelector('[app-mention-path="' + DEEP_RESEARCH + '"]');
  }

  function readText(input) {
    if (!input) return "";
    if ("value" in input) return input.value;
    const read = node => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
      if (node.nodeName === "BR")
        return node.classList.contains("ProseMirror-trailingBreak") ? "" : "\n";
      return [...node.childNodes].map(read).join("");
    };
    const children = [...input.children];
    if (children.length && children.every(node => node.tagName === "P"))
      return children.map(node => read(node)).join("\n");
    return input.innerText || input.textContent || "";
  }

  function draft(input) {
    if (!input || !mention(input)) return null;
    const raw = readText(input).replace(/\r\n/g, "\n");
    // An inline app mention contributes its display name to the editor text.
    const inline = Boolean(input.contains(mention(input)));
    return inline ? raw.replace(/^Deep research(?:[ \t]*\n|[ \t]+|$)/i, "") : raw;
  }

  function sendButton(input) {
    return [...(form(input)?.querySelectorAll('button[data-testid="composer-submit-button"], button[data-testid="send-button"], button[aria-label^="Send" i]') || [])]
      .find(button => visible(button) && !/stop|voice/i.test(button.getAttribute("aria-label") || "")
        && !button.disabled && button.getAttribute("aria-disabled") !== "true");
  }

  function status(text, canGo = false) {
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement("div");
      banner.id = BANNER_ID;
      banner.setAttribute("role", "status");
      banner.style.cssText = "display:flex;align-items:center;gap:10px;padding:7px 10px;margin:6px 0;border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:9px;font:12px/1.4 system-ui;";
      (form(editor())?.parentElement || document.body)?.append(banner);
    }
    banner.replaceChildren();
    const label = document.createElement("span");
    label.textContent = text;
    banner.append(label);
    if (canGo) {
      const go = document.createElement("button");
      go.type = "button";
      go.textContent = "Go";
      go.setAttribute("aria-label", "Send reviewed Deep Research prompt");
      go.style.cssText = "padding:5px 12px;border-radius:7px;border:1px solid currentColor;cursor:pointer;";
      go.addEventListener("click", () => {
        const input = editor();
        if (!chatIsSupported() || location.pathname !== approvedPath
          || !input || draft(input) !== approvedText) return;
        const send = sendButton(input);
        if (send) send.click();
      });
      banner.append(go);
    }
  }

  async function ask(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "Spellcheck is unavailable.");
    return response;
  }

  async function start() {
    if (!spellcheckEnabled || running || !chatIsSupported()) return;
    const input = editor();
    const prompt = draft(input);
    if (prompt === null || !prompt.trim()) return;
    if (form(input)?.querySelectorAll('[app-mention-path]').length !== 1) {
      status("Spellcheck supports one Deep Research app mention at a time.");
      return;
    }
    if (form(input)?.querySelector('[data-composer-attachments] > *, [data-testid="composer-attachments"] > *, button[aria-label^="Remove file" i]')) {
      status("Spellcheck requires a text-only research draft. Remove attachments first.");
      return;
    }
    running = true;
    activePath = location.pathname;
    approvedText = null;
    approvedPath = null;
    status("Spellchecking your Deep Research prompt in split view…");
    try {
      const response = await ask({ type: "ghrc-research-spellcheck-begin", prompt, sourcePath: activePath });
      activeId = response.id;
    } catch (error) {
      running = false;
      status(error.message + " Your draft was not sent.");
    }
  }

  function intercept(event) {
    if (!spellcheckEnabled || !event.isTrusted || !chatIsSupported()) return;
    const input = editor();
    const prompt = draft(input);
    if (prompt === null || !prompt.trim()) return;
    const click = event.type === "click";
    const submit = event.type === "submit" && event.target === form(input);
    const key = event.type === "keydown" && event.key === "Enter" && !event.shiftKey
      && !event.altKey && !event.isComposing
      && (event.target === input || input?.contains(event.target));
    const button = click && event.target.closest?.("button");
    const clickedSend = button && form(input)?.contains(button)
      && (button.matches('[data-testid="composer-submit-button"], [data-testid="send-button"], button[aria-label^="Send" i], button[type="submit"]'))
      && !/stop|voice/i.test(button.getAttribute("aria-label") || "");
    if (!submit && !key && !clickedSend) return;
    const queue = globalThis.__ghrcMessageQueue;
    // Give ChatGPT's plugin picker priority while autocomplete is visible.
    if (key && queue?.composerAutocompleteIsOpen?.(input)) return;
    // Busy replies and pending messages take precedence over spellcheck.
    if (queue?.shouldQueueResearchPrompt?.(input)) {
      if (key) return; // The queue's capture listener handles Enter.
      event.preventDefault();
      event.stopImmediatePropagation();
      void queue.enqueueComposerMessage();
      return;
    }
    // Exactly the reviewed version gets one ordinary, user-initiated submission.
    if (!running && prompt === approvedText && location.pathname === approvedPath) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!running) void context.run(start);
  }

  async function replaceDraft(original, corrected) {
    const input = editor();
    if (!spellcheckEnabled || !chatIsSupported() || location.pathname !== activePath
      || !input || draft(input) !== original)
      throw new Error("The research prompt changed while spellchecking; its current draft was preserved.");
    const token = mention(input);
    if (!token) throw new Error("The Deep Research app mention disappeared.");
    input.focus({ preventScroll: true });
    if ("value" in input) {
      // Textareas are not a supported representation of an inline app mention.
      throw new Error("The editor no longer supports the Deep Research app mention.");
    }
    const selection = window.getSelection();
    const range = document.createRange();
    if (input.contains(token)) {
      range.setStartAfter(token);
      range.setEnd(input, input.childNodes.length);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, "\n" + corrected);
    } else {
      range.selectNodeContents(input);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, corrected);
    }
    await pause(100);
    if (location.pathname !== activePath || draft(editor()) !== corrected || !mention(editor()))
      throw new Error("The correction could not be verified in this conversation. Review the draft manually.");
    approvedText = corrected;
    approvedPath = activePath;
    running = false;
    activeId = null;
    activePath = null;
    status("Spellcheck complete. Review the corrected prompt and press Go.", true);
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type === "ghrc-research-spellcheck-apply") {
      if (!running || !activeId || message.id !== activeId) {
        reply({ ok: false, error: "No matching spellcheck is pending in this chat." });
        return false;
      }
      void context.run(async () => {
        try {
          await replaceDraft(message.original, message.corrected);
          reply({ ok: true });
        } catch (error) {
          running = false;
          activeId = null;
          activePath = null;
          status(error.message + " Nothing was sent.");
          reply({ ok: false, error: error.message });
        }
      });
      return true;
    }
    if (message?.type === "ghrc-research-spellcheck-failed" && message.id === activeId) {
      running = false;
      activeId = null;
      activePath = null;
      status(message.error + " Your research draft was not sent.");
    }
    return false;
  });

  // Capturing prevents native submission before ChatGPT's delegated handlers run.
  for (const type of ["keydown", "click", "submit"])
    window.addEventListener(type, intercept, true);

  async function collectCorrection() {
    const started = Date.now();
    let last = "";
    let stableSince = 0;
    while (context.active() && Date.now() - started < 180000) {
      const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
      const lastTurn = turns[turns.length - 1];
      const body = lastTurn?.querySelector(".markdown, [data-message-content]") || lastTurn;
      const text = body?.innerText?.trim() || "";
      const stop = [...document.querySelectorAll('[data-testid="stop-button"], button[aria-label*="Stop generating" i]')].some(visible);
      if (document.querySelector('[data-message-author-role="user"]') && text && !stop) {
        if (text !== last) { last = text; stableSince = Date.now(); }
        else if (Date.now() - stableSince >= 2000) {
          const fence = /^```(?:[^\n]*)\n([\s\S]*?)\n```$/;
          return text.match(fence)?.[1] || text;
        }
      } else { last = ""; stableSince = 0; }
      await pause(250);
    }
    throw new Error("No stable Spellcheck Only response was detected.");
  }

  async function runTemporaryPane() {
    if (location.pathname !== "/") return;
    const { job } = await ask({ type: "ghrc-research-spellcheck-claim" });
    if (!job) return;
    try {
      let ready = false;
      for (let i = 0; i < 120 && context.active(); i++) {
        if (editor()?.isConnected && globalThis.__ghrcSpellcheckAutomation?.runText) {
          ready = true;
          break;
        }
        await pause(100);
      }
      if (!ready) throw new Error("Spellcheck Only did not load.");
      const activated = await globalThis.__ghrcSpellcheckAutomation.runText(job.prompt);
      if (!activated) throw new Error("Spellcheck Only could not be activated.");
      const corrected = await collectCorrection();
      await ask({ type: "ghrc-research-spellcheck-finish", id: job.id, corrected });
    } catch (error) {
      await ask({ type: "ghrc-research-spellcheck-fail", id: job.id, error: error.message }).catch(() => {});
      status(error.message + " The original draft was not sent; copy any correction manually.");
    }
  }

  function setSpellcheckEnabled(value) {
    spellcheckEnabled = value !== false;
    if (spellcheckEnabled) return;
    // Invalidates in-flight corrections and removes stale Go controls.
    running = false;
    activeId = null;
    activePath = null;
    approvedText = null;
    approvedPath = null;
    document.getElementById(BANNER_ID)?.remove();
  }

  function settingsChanged(changes, area) {
    if (area !== "local" || !changes[SETTING_KEY]) return;
    settingsRevision++;
    setSpellcheckEnabled(changes[SETTING_KEY].newValue);
  }

  if (globalThis.chrome?.storage?.local?.get) {
    chrome.storage.onChanged?.addListener(settingsChanged);
    const loadRevision = settingsRevision;
    void chrome.storage.local.get({ [SETTING_KEY]: true })
      .then(settings => {
        if (loadRevision === settingsRevision) setSpellcheckEnabled(settings[SETTING_KEY]);
      })
      .catch(error => context.handleError?.(error));
  }

  context.onStop(() => {
    globalThis.chrome?.storage?.onChanged?.removeListener(settingsChanged);
    for (const type of ["keydown", "click", "submit"])
      window.removeEventListener(type, intercept, true);
    document.getElementById(BANNER_ID)?.remove();
  });
  void context.run(runTemporaryPane);
})();