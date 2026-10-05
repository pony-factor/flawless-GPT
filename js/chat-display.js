(() => {
  "use strict";
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const MODEL_MARKER = "data-ghrc-model-control";
  const FEEDBACK_MARKER = "data-ghrc-conversation-feedback-prompt";
  const TIMESTAMP_MARKER = "data-ghrc-chat-timestamp";
  const TAIL_MARKER = "data-ghrc-conversation-tail-space";
  const TURN_QUERY = '[data-testid^="conversation-turn-"], [data-message-author-role]';
  const FEEDBACK_TEXT = "Is this conversation helpful so far?";
  const CONTROL_QUERY = 'button[aria-haspopup], [role="combobox"], [data-codex-intelligence-trigger]';
  let scheduled = false;

  function markConversationFeedbackPrompt() {
    for (const label of document.querySelectorAll("p, span, div")) {
      if (label.textContent?.replace(/\s+/g, " ").trim() !== FEEDBACK_TEXT) continue;

      let fallback = null;
      let candidate = label;
      for (let depth = 0; candidate && depth < 6; depth += 1, candidate = candidate.parentElement) {
        const buttonCount = candidate.querySelectorAll("button").length;
        if (buttonCount >= 2 && buttonCount <= 6 && !fallback) fallback = candidate;
        if (buttonCount >= 3 && buttonCount <= 6) {
          candidate.setAttribute(FEEDBACK_MARKER, "");
          return;
        }
      }
      fallback?.setAttribute(FEEDBACK_MARKER, "");
    }
  }

  function markChatTimestamps() {
    const exactTime = /^(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?[AP]M)?$/i;
    const dateLabel = /^(?:\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}|[A-Z][a-z]+\s+\d{1,2},\s+\d{4})$/;
    for (const turn of document.querySelectorAll(TURN_QUERY)) {
      for (const element of turn.querySelectorAll(
        'time, [datetime], [data-testid*="timestamp" i], [data-testid*="message-time" i], [aria-label*="sent at" i]',
      )) {
        element.setAttribute(TIMESTAMP_MARKER, "");
      }

      for (const element of turn.querySelectorAll("span, div")) {
        if (element.children.length) continue;
        const text = element.textContent?.trim() || "";
        if (!exactTime.test(text) && !dateLabel.test(text)) continue;
        const classes = typeof element.className === "string" ? element.className : "";
        if (!/(?:text-xs|text-sm|tertiary|secondary|timestamp|time)/i.test(classes)) continue;
        element.setAttribute(TIMESTAMP_MARKER, "");
      }
    }
  }

  function markConversationTail() {
    const turns = [...document.querySelectorAll(TURN_QUERY)];
    const lastTurn = turns.at(-1) ?? null;
    for (const marked of document.querySelectorAll(`[${TAIL_MARKER}]`)) {
      if (marked !== lastTurn) marked.removeAttribute(TAIL_MARKER);
    }
    if (lastTurn) lastTurn.setAttribute(TAIL_MARKER, "");
  }

  function scan() {
    if (!context.active()) return;
    scheduled = false;
    markConversationFeedbackPrompt();
    markChatTimestamps();
    markConversationTail();
    for (const control of document.querySelectorAll(CONTROL_QUERY)) {
      const label = [control.getAttribute("aria-label"), control.getAttribute("title"), control.textContent]
        .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      const modelControl = control.hasAttribute("data-codex-intelligence-trigger")
        || /^Select ChatGPT model\b/i.test(label)
        || (Boolean(control.closest('form, [data-type="unified-composer"]'))
          && /\b(thinking (?:effort|time)|reasoning (?:effort|strength))\b/i.test(label));
      if (control.hasAttribute(MODEL_MARKER) !== modelControl) control.toggleAttribute(MODEL_MARKER, modelControl);
    }
  }

  function scheduleScan() {
    if (!context.active()) return;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(scan);
  }

  function apply(settings) {
    document.documentElement?.toggleAttribute("data-ghrc-show-home-suggestions", !settings.hideHomeSuggestions);
    document.documentElement?.toggleAttribute("data-ghrc-show-model-controls", !settings.hideModelControls);
    document.documentElement?.toggleAttribute("data-ghrc-hide-conversation-feedback-prompt", settings.hideConversationFeedbackPrompt);
    document.documentElement?.toggleAttribute("data-ghrc-hide-chat-timestamps", settings.hideChatTimestamps);
    scheduleScan();
  }

  let settings = { hideHomeSuggestions: true, hideModelControls: true, hideConversationFeedbackPrompt: true, hideChatTimestamps: false };
  document.documentElement?.setAttribute("data-ghrc-hide-conversation-feedback-prompt", "");
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of Object.keys(settings)) {
      if (changes[key]) settings[key] = changes[key].newValue !== false;
    }
    apply(settings);
  });
  const observer = new MutationObserver(scheduleScan);
  context.onStop(() => observer.disconnect());
  observer.observe(document, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["aria-label", "title", "data-codex-intelligence-trigger"],
  });
  void context.run(async () => {
    const stored = await chrome.storage.local.get(settings);
    if (!context.active()) return;
    settings = {
      hideHomeSuggestions: stored.hideHomeSuggestions !== false,
      hideModelControls: stored.hideModelControls !== false,
      hideConversationFeedbackPrompt: stored.hideConversationFeedbackPrompt !== false,
      hideChatTimestamps: Boolean(stored.hideChatTimestamps),
    };
    apply(settings);
  });
  scheduleScan();
})();
