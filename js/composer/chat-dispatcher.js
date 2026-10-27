(() => {
  if (globalThis.__ghrcChatDispatcherAdapter?.isAlive?.()) return;
  const context = globalThis.__ghrcExtensionContext;
  const SETTLE_MS = 1500;
  let signature = '';
  let stableSince = Date.now();
  let reservation = null;
  let submissionPending = false;
  let pendingNonce = null;
  let wakeTimer;
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length
    && getComputedStyle(node).visibility !== 'hidden');
  const all = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const composer = () => globalThis.__ghrcMessageQueue?.findComposerInput?.() || all(document, '#prompt-textarea, [data-composer-markdown][contenteditable="true"]').at(-1);
  const form = input => input?.closest('form, [data-type="unified-composer"]');
  const read = input => typeof input?.value === 'string' ? input.value : input?.innerText || '';
  const root = () => document.querySelector('[aria-label="Conversation"]') || document;
  const role = name => [...root().querySelectorAll(`[data-message-author-role="${name}"], [data-content-search-unit-key$=":${name}"]`)].at(-1);
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
  const hasContext = input => {
    const container = form(input);
    return Boolean(container && ([...container.querySelectorAll('input[type="file"]')].some(node => node.files?.length)
      || all(container, '[data-testid*="attachment" i], [data-testid*="file-preview" i], button[aria-label*="Remove file" i], button[aria-label*="Remove attachment" i], blockquote').length));
  };
  const stopSelector = 'button[data-testid*="stop" i], button[aria-label="Stop" i], button[aria-label*="Stop generating" i], button[aria-label*="Stop response" i]';

  function nativeSend(input) {
    const sharedSend = globalThis.__ghrcMessageQueue?.findNativeSend?.(input);
    return (sharedSend ? [sharedSend] : all(form(input) || document, 'button[data-testid="send-button"], button[data-testid="composer-submit-button"], button#composer-submit-button, button[aria-label^="Send" i], button[type="submit"]'))
      .find(button => visible(button) && !button.id.startsWith('ghrc-') && !String(button.className).includes('ghrc-')
        && !/stop|interrupt|steer|voice|dictat|speech|search/i.test(`${button.getAttribute('aria-label')} ${button.getAttribute('data-testid')}`)
        && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
  }

  function snapshot() {
    const input = composer();
    const shared = globalThis.__ghrcMessageQueue?.getDispatcherLifecycle?.();
    const assistant = role('assistant');
    const user = role('user');
    const turn = assistant?.closest('[data-testid^="conversation-turn-"], article, .group') || assistant;
    const reply = assistant?.innerText || '';
    const currentSignature = `${location.href}\n${user?.getAttribute('data-message-id') || user?.textContent || ''}\n${reply}`;
    const active = Boolean(shared?.responseActive || all(form(input) || document, stopSelector).length || (turn && (
      all(turn, '[data-message-status="in_progress"], [data-message-status="streaming"], [data-state="streaming"], [data-state="generating"], [data-testid*="streaming" i], [data-testid*="generating" i], [aria-label*="thinking" i], [aria-busy="true"], [role="progressbar"]').length
      || all(turn, 'button, [role="status"], [aria-live]').some(node => /^(?:thinking|working|generating|skip|\.{2,4}|…|[·•]{2,4})$/i.test(normalize(node.textContent)))
    )));
    if (currentSignature !== signature || active) {
      signature = currentSignature;
      stableSince = Date.now();
    }
    const workOnly = !user && Boolean(assistant?.getAttribute('data-content-search-unit-key')?.startsWith('fallback-turn-'));
    const fresh = location.href === 'https://chatgpt.com/' && !user && !assistant;
    const latestUserAnswered = Boolean(user && assistant && (user.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING));
    // Completion controls must belong to the assistant, never to the user's toolbar.
    const assistantComplete = Boolean(assistant && (assistant.matches('[data-message-status="finished"], [data-state="complete"]')
      || all(assistant, 'button[data-testid="copy-turn-action-button"], button[aria-label="Copy"], button[aria-label*="Good response" i], button[aria-label*="Bad response" i], button[aria-label*="Regenerate" i]').length
      || (turn && all(turn, 'button[data-testid="copy-turn-action-button"], .turn-action-controls button[aria-label="Copy"], .turn-action-controls button[aria-label*="Regenerate" i]').length)));
    const queueLength = Math.max(shared?.queueLength || 0, all(document, '.ghrc-message-queue-item, [aria-label^="Queued message "]').length);
    const draft = read(input);
    const inferredTask = [...(user?.textContent || '').matchAll(/\b(?:Task:\s*|task\s+)([A-Za-z0-9_-]+-\d+)\b/g)].at(-1)?.[1] || null;
    return {
      url: location.href, fresh, workOnly, known: fresh || Boolean((user || workOnly) && assistant) && (!shared || shared.stateReady && shared.roleStateKnown), active,
      assistantComplete: assistantComplete && (!shared || shared.latestAssistantComplete),
      latestUserAnswered: workOnly || latestUserAnswered && (!shared || shared.latestUserAnswered),
      composerReady: Boolean(input && !input.disabled && input.getAttribute('aria-disabled') !== 'true'),
      queueLength, submissionPending: submissionPending || Boolean(shared?.submissionPending), signature, stableSince, observedAt: Date.now(), reply,
      draftPresent: Boolean(draft.trim()) || hasContext(input) || Boolean(shared?.hasContext), hasContext: hasContext(input) || Boolean(shared?.hasContext), taskId: inferredTask,
      confirmationText: all(root(), '[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"]').map(node => node.innerText || '').join('\n'),
    };
  }

  function idle(s) {
    return s.known && !s.active && s.composerReady && !s.queueLength && !s.submissionPending
      && (s.fresh || s.latestUserAnswered && s.assistantComplete) && Date.now() - s.stableSince >= SETTLE_MS;
  }

  function write(input, text) {
    input.focus({ preventScroll: true });
    if (input instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } else {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, text);
    }
    return normalize(read(input)) === normalize(text);
  }

  async function prepare(message) {
    const before = snapshot();
    if (!idle(before) || before.draftPresent || before.signature !== message.signature) return { ok: false, reason: 'Chat changed, is busy, or contains a draft.' };
    if (typeof message.prompt !== 'string' || !message.prompt.trim() || message.prompt.length > 120000) return { ok: false, reason: 'Invalid prompt.' };
    const input = composer();
    const original = read(input);
    if (!write(input, message.prompt)) return { ok: false, reason: 'Composer did not accept text; draft retained for review.' };
    reservation = { nonce: message.nonce, input, original, prompt: message.prompt, signature: before.signature, url: before.url, fresh: before.fresh, expires: Date.now() + 15000 };
    await new Promise(resolve => setTimeout(resolve, 100));
    const after = snapshot();
    if (!idle(after) || after.hasContext || after.signature !== before.signature || composer() !== input || after.url !== before.url) {
      reservation = null;
      return { ok: false, reason: 'Activity resumed after filling; prompt remains unsent.' };
    }
    return { ok: true, nonce: message.nonce };
  }

  async function commit(message) {
    const held = reservation;
    const now = snapshot();
    if (!held || held.nonce !== message.nonce || Date.now() > held.expires || !idle(now) || now.hasContext
      || now.signature !== held.signature || now.url !== held.url || composer() !== held.input
      || normalize(read(held.input)) !== normalize(held.prompt)) {
      return { ok: false, reason: 'Final activity/identity check failed; nothing sent.' };
    }
    const send = nativeSend(held.input);
    if (!send) return { ok: false, reason: 'No genuine native Send control; refusing interrupt/steer controls.' };
    // No await between the final lifecycle check and clicking this exact Send node.
    const final = snapshot();
    if (!idle(final) || final.signature !== held.signature || !send.isConnected
      || send !== nativeSend(held.input) || send.disabled || /stop|interrupt|steer/i.test(`${send.getAttribute('aria-label')} ${send.getAttribute('data-testid')}`)) {
      return { ok: false, reason: 'Send changed into an unsafe action; nothing sent.' };
    }
    reservation = null;
    submissionPending = true;
    pendingNonce = held.nonce;
    const previousUser = role('user');
    send.click();
    if (held.fresh || now.workOnly) return { ok: true, pendingIdentity: true };
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const newConversation = held.fresh && /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+\/?(?:[?#].*)?$/.test(location.href);
      if (location.href !== held.url && !newConversation && !(held.fresh && new URL(location.href).origin === 'https://chatgpt.com' && new URL(location.href).pathname === '/')) return { ok: false, uncertain: true, reason: 'Route changed during submission; review this slot before retrying.' };
      const latest = role('user');
      if (latest && latest !== previousUser && (!held.fresh || newConversation) && latest.textContent.includes(`Dispatch reference: ${held.nonce}`)) {
        submissionPending = false;
        pendingNonce = null;
        return { ok: true, url: location.href };
      }
    }
    return { ok: false, uncertain: true, reason: 'Submission was not confirmed. Automatic retry is blocked.' };
  }

  function review(message) {
    const s = snapshot();
    if (message.decision === 'not-sent') {
      if (s.active) return { ok: false, reason: 'Chat is active; review after it finishes.' };
      if (role('user')?.textContent.includes(`Dispatch reference: ${message.nonce}`)) return { ok: false, reason: 'This prompt appears in the conversation. Mark it as sent instead.' };
      if (pendingNonce && pendingNonce !== message.nonce) return { ok: false, reason: 'The submission reference changed.' };
      if (reservation && reservation.nonce !== message.nonce) return { ok: false, reason: 'A different draft is reserved.' };
      submissionPending = false;
      pendingNonce = null;
      reservation = null;
      return { ok: true };
    }
    if (message.decision === 'sent') {
      if (!role('user')?.textContent.includes(`Dispatch reference: ${message.nonce}`) && !snapshot().confirmationText.includes(`DISPATCH_RECEIVED ${message.nonce}`)) return { ok: false, reason: 'Waiting for the task receipt or a verified merge confirmation.' };
      submissionPending = false;
      pendingNonce = null;
      reservation = null;
      return { ok: true, url: location.href };
    }
    return { ok: false, reason: 'Unknown review decision.' };
  }

  const adapter = { snapshot, idle, nativeSend, prepare, commit, review, isAlive: () => { try { return Boolean(chrome.runtime.getManifest()); } catch { return false; } } };
  globalThis.__ghrcChatDispatcherAdapter = adapter;
  const onMessage = (message, sender, respond) => {
    if (context && !context.active()) return;
    if (sender.id !== chrome.runtime.id) return;
    const operation = message?.type === 'ghrc-chat-dispatcher:snapshot' ? Promise.resolve(snapshot())
      : message?.type === 'ghrc-chat-dispatcher:prepare' ? prepare(message)
      : message?.type === 'ghrc-chat-dispatcher:commit' ? commit(message)
      : message?.type === 'ghrc-chat-dispatcher:review' ? Promise.resolve(review(message)) : null;
    if (!operation) return;
    operation.then(respond, error => respond({ ok: false, reason: error.message }));
    return true;
  };
  chrome.runtime.onMessage.addListener(onMessage);
  const observer = new MutationObserver(() => {
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => { snapshot(); chrome.runtime.sendMessage({ type: 'ghrc-chat-dispatcher:wake' }).catch(() => {}); }, 1700);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'data-state', 'data-message-status', 'aria-busy'] });
  context?.onStop(() => { observer.disconnect(); clearTimeout(wakeTimer); chrome.runtime.onMessage.removeListener(onMessage); });
  snapshot();
})();
