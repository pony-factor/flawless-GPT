(() => {
  'use strict';

  const TOAST_SELECTOR = [
    '[role="status"]',
    '[role="alert"]',
    '[data-sonner-toast]',
    '[data-radix-toast-root]',
    '[data-testid*="toast" i]',
    '[class*="toast" i]',
  ].join(',');

  const COMPLETION_TEXT = /\b(?:complete|completed|finished|ready|done)\b/i;
  const CROSS_CHAT_TEXT = /\b(?:another|other)\s+(?:chat|conversation)\b/i;

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
    if (!toast || !COMPLETION_TEXT.test(toast.textContent || '')) return false;

    if (CROSS_CHAT_TEXT.test(toast.textContent || '')) return true;

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
    if (!(node instanceof Element)) return [];

    const candidates = [];
    if (node.matches(TOAST_SELECTOR)) candidates.push(node);
    candidates.push(...node.querySelectorAll(TOAST_SELECTOR));
    return candidates;
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
        for (const node of record.addedNodes) scan(node);
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
