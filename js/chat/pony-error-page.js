(() => {
  "use strict";
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const MARKER = "data-ghrc-pony-error";
  const EXCLUDE = '[data-turn-key], [data-testid^="conversation-turn-"], [data-message-author-role], article, form, [contenteditable], #ghrc-message-queue, [data-queued-message]';
  const SURFACE = 'main, [role="main"], [role="alert"], [role="dialog"], [role="alertdialog"], [aria-label="Conversation"], #modal-conversation-history-rate-limit';
  const LABELS = 'h1, h2, h3, p, span, div';
  const marked = new Map();
  const pending = new Set();
  let frame = null;

  function errorKind(label) {
    const text = label.textContent?.replace(/\s+/g, " ").trim() || "";
    if (text === "Could not load this ChatGPT conversation") return "conversation";
    if (/^(?:Too many requests[.!]?|Rate limit(?:ed| reached| exceeded)[.!]?|You've reached (?:our|the) limit of messages per hour\. Please try again later\.?)$/i.test(text)) return "rate-limit";
    return "";
  }

  function inspect(root) {
    if (!(root instanceof Element) || !root.isConnected || root.closest(EXCLUDE)) return;
    const labels = [...(root.matches(LABELS) ? [root] : []), ...root.querySelectorAll(LABELS)];
    for (const label of labels) {
      if (label.closest(EXCLUDE) || !label.closest(SURFACE) || label.childElementCount > 2
          || label.querySelector('button, input, textarea, [contenteditable]')) continue;
      const kind = errorKind(label);
      if (!kind) continue;
      let card = label;
      for (let depth = 0; depth < 4 && card.parentElement; depth++) {
        const parent = card.parentElement;
        if (parent.matches('body, main, [role="main"]') || parent.querySelector(EXCLUDE)) break;
        card = parent;
        if (card.querySelector('button, a[href]') || card.matches('[role="alert"], [role="dialog"], [role="alertdialog"]')) break;
      }
      card.setAttribute(MARKER, kind);
      marked.set(card, label);
    }
  }

  function flush() {
    frame = null;
    if (!context.active()) return;
    for (const [card, label] of marked) {
      if (!card.isConnected || !card.contains(label) || !errorKind(label) || label.closest(EXCLUDE)) {
        card.removeAttribute(MARKER);
        marked.delete(card);
      }
    }
    const roots = [...pending];
    pending.clear();
    for (const root of roots) inspect(root);
  }
  function queue(node) {
    const root = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!(root instanceof Element) || root.closest(EXCLUDE)) return;
    for (const existing of pending) {
      if (existing.contains(root)) return;
      if (root.contains(existing)) pending.delete(existing);
    }
    pending.add(root);
    if (frame === null) frame = requestAnimationFrame(flush);
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "characterData") queue(record.target);
      else {
        for (const node of record.addedNodes) queue(node);
        if (record.removedNodes.length && marked.size) queue(record.target);
      }
    }
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true });
  if (document.documentElement) queue(document.documentElement);
  context.onStop(() => {
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    pending.clear();
    for (const card of marked.keys()) card.removeAttribute(MARKER);
    marked.clear();
  });
})();
