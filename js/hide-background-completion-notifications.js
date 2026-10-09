(() => {
  'use strict';

  const TOAST_SELECTOR = [
    '[role="status"]',
    '[role="alert"]',
    '[role="alertdialog"]',
    '[data-sonner-toast]',
    '[data-radix-toast-root]',
    '[data-testid*="toast" i]',
    '[data-testid*="notification" i]',
    '[class*="toast" i]',
  ].join(',');

  const COMPLETION_TEXT = /\b(?:complete|completed|finished|ready|done)\b/i;
  const CROSS_CHAT_TEXT = /\b(?:another|other)\s+(?:chat|conversation)\b/i;
  // Some ChatGPT completion toasts identify the task rather than linking to a chat.
  const CHAT_COMPLETION_TEXT = /\b(?:your\s+)?(?:(?:other|another|background|thinking|reasoning|deep\s+research|research|agent)\s+){0,2}(?:session|task|chat|conversation|response|research|thinking|reasoning)\s+(?:(?:has|is|was)\s+)?(?:finished|completed|complete|ready|done)\b/i;

  function conversationIdFromPath(pathname) {
    const match = String(pathname || '').match(/^\/c\/([^/?#]+)/i);
    return match ? match[1] : '';
  }

  function isDifferentConversationHref(href, currentPathname = location.pathname) {
    if (!href) return false;

    try {
      const target = new URL(href, location.origin);
      if (target.origin !== location.origin) return false;

      const targetId = conversationIdFromPath(target.pathname);
      const currentId = conversationIdFromPath(currentPathname);
      return Boolean(targetId && (!currentId || targetId !== currentId));
    } catch {
      return false;
    }
  }

  function isBackgroundCompletionNotice(toast) {
    if (!toast) return false;
    const text = toast.textContent || '';
    if (!COMPLETION_TEXT.test(text)) return false;

    // Completion notifications do not always mention another conversation or
    // include a conversation link (e.g. "Your thinking session has finished").
    if (CHAT_COMPLETION_TEXT.test(text) || CROSS_CHAT_TEXT.test(text)) return true;

    const links = toast.querySelectorAll ? toast.querySelectorAll('a[href]') : [];
    return Array.from(links).some((link) =>
      isDifferentConversationHref(link.getAttribute('href'))
    );
  }

  function hideNotice(toast) {
    if (!toast || toast.hasAttribute('data-ghrc-hidden-background-completion')) return;
    toast.setAttribute('data-ghrc-hidden-background-completion', '');
    toast.setAttribute('aria-hidden', 'true');
  }

  function candidateToasts(node) {
    // ChatGPT can add text inside an existing toast, including by modifying a
    // text node. In that case the mutation target is not the toast itself.
    const element = node instanceof Element ? node : node?.parentElement;
    if (!element) return [];

    const candidates = new Set();
    const ancestor = element.closest(TOAST_SELECTOR);
    if (ancestor) candidates.add(ancestor);
    if (element.matches(TOAST_SELECTOR)) candidates.add(element);
    for (const descendant of element.querySelectorAll(TOAST_SELECTOR)) {
      candidates.add(descendant);
    }
    return Array.from(candidates);
  }

  function scan(node) {
    for (const toast of candidateToasts(node)) {
      if (isBackgroundCompletionNotice(toast)) hideNotice(toast);
    }
  }

  const api = {
    conversationIdFromPath,
    isDifferentConversationHref,
    isBackgroundCompletionNotice,
    candidateToasts,
  };

  if (globalThis.__GHRC_TEST__) {
    Object.assign(globalThis.__GHRC_TEST__, api);
    return;
  }

  const style = document.createElement('style');
  style.id = 'ghrc-hide-background-completion-notifications';
  style.textContent =
    '[data-ghrc-hidden-background-completion] { display: none !important; }';

  function start() {
    if (!document.documentElement) return;
    if (!document.getElementById(style.id)) document.documentElement.append(style);
    scan(document.documentElement);

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList') {
          for (const node of record.addedNodes) scan(node);
        } else {
          scan(record.target);
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href', 'role', 'data-testid', 'data-sonner-toast', 'data-radix-toast-root'],
    });
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
