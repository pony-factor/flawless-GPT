(() => {
  "use strict";

  const SETTLE_MS = 8_000;
  const STORAGE_PREFIX = "ghrc-missing-response-recovery:";
  const TURN_SELECTOR = "[data-turn-key]";
  const COMPOSER_SELECTOR = '#prompt-textarea, [data-composer-markdown][contenteditable="true"]';

  function missingAnswer(entry) {
    const turn = entry?.turn;
    if (turn?.status !== "complete" || entry.errorMessage || !Array.isArray(turn.items)) return false;
    // Unknown item kinds may be answers (images, tools, future renderers).
    // Only the observed, completed prefix-only state is a recovery candidate.
    return turn.items.some(item => item.type === "user-message")
      && turn.items.some(item => item.type === "chatgpt-reasoning-group" && item.completed)
      && turn.items.every(item => item.type === "user-message"
        || item.type === "chatgpt-reasoning-group" && item.completed && item.items?.length === 0);
  }

  function answerForTurn(payload, userId) {
    const mapping = payload?.mapping;
    if (!mapping || !payload.current_node) return null;
    // Walk the selected branch backwards. A regenerated answer on a sibling
    // branch, or the answer to a later prompt, cannot repair this turn.
    const visited = new Set();
    let node = mapping[payload.current_node];
    let answer = null;
    while (node && !visited.has(node.id)) {
      visited.add(node.id);
      const message = node.message;
      if (message?.author?.role === "user") {
        if (node.id === userId) return answer;
        answer = null;
      }
      if (message?.author?.role === "assistant" && message.channel === "final"
          && message.status === "finished_successfully"
          && message.content?.content_type === "text"
          && !answer && message.content.parts?.some(part => typeof part === "string" && part.trim())) {
        answer = message.id || node.id;
      }
      node = mapping[node.parent];
    }
    return null;
  }

  function entryFor(element) {
    const key = Object.keys(element).find(name => name.startsWith("__reactFiber$"));
    let fiber = key && element[key];
    let root = fiber;
    while (root?.return) root = root.return;
    // React keeps alternating trees; host nodes can retain the older fiber.
    if (root?.stateNode?.current && root.stateNode.current !== root) fiber = fiber.alternate;
    for (let depth = 0; fiber && depth < 8; depth++, fiber = fiber.return) {
      const entry = fiber.memoizedProps?.entry;
      if (entry?.turn && Array.isArray(entry.turn.items)) return entry;
    }
    return null;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { missingAnswer, answerForTurn, entryFor };
    return;
  }

  if (window.__ghrcMissingResponseRecovery) return;
  window.__ghrcMissingResponseRecovery = true;
  let pending = false;
  let lastInput = Date.now();
  let candidate = "";
  let candidateSince = 0;
  let retryAfter = 0;
  let composing = false;
  const attempts = new Map();

  const conversationId = () => location.pathname.match(/^\/c\/([a-zA-Z0-9-]+)$/)?.[1] || "";
  const scroller = () => document.querySelector("[data-app-action-timeline-scroll]");

  function idle() {
    if (composing || document.visibilityState !== "visible" || Date.now() - lastInput < SETTLE_MS) return false;
    const composer = [...document.querySelectorAll(COMPOSER_SELECTOR)]
      .find(element => element.getClientRects().length);
    if (!composer || (composer.value ?? composer.textContent ?? "").trim()) return false;
    if (document.getElementById("ghrc-message-queue")) return false;
    const form = composer.closest('form, [data-type="unified-composer"]');
    if (!form || [...document.querySelectorAll('input[type="file"]')].some(input => input.files?.length)) return false;
    if (form.querySelector('[data-composer-attachments]:not(:empty), [data-composer-quote], [data-testid="composer-reply-preview"], button[aria-label*="Remove" i], [aria-busy="true"]')) return false;
    if (document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop" i], button[aria-label*="Stop generating" i], button[aria-label*="Stop response" i]')) return false;
    const turns = [...document.querySelectorAll(TURN_SELECTOR)];
    return turns.length > 0 && turns.every(element => entryFor(element)?.turn.status === "complete");
  }

  async function loadSavedConversation(id) {
    // Keep authentication inside the page, as with personalization reads.
    // Never persist or bridge credentials or conversation contents.
    const sessionResponse = await fetch("/api/auth/session", {
      credentials: "include", cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    if (!sessionResponse.ok) return null;
    const session = await sessionResponse.json();
    if (!session.accessToken) return null;
    const response = await fetch(`/backend-api/conversation/${id}`, {
      credentials: "include", cache: "no-store",
      headers: { authorization: `Bearer ${session.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? response.json() : null;
  }

  function viewport() {
    const scroll = scroller();
    if (!scroll) return null;
    const top = scroll.getBoundingClientRect().top;
    const anchor = [...scroll.querySelectorAll(TURN_SELECTOR)]
      .find(element => element.getBoundingClientRect().bottom > top);
    return {
      top: scroll.scrollTop,
      turn: anchor?.getAttribute("data-turn-key"),
      offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
    };
  }

  async function check() {
    const id = conversationId();
    if (!id || pending || Date.now() < retryAfter || !idle()) return;
    try {
      // One refresh per conversation per tab session, including failed repairs.
      if (sessionStorage.getItem(STORAGE_PREFIX + id)) return;
      const element = [...document.querySelectorAll(TURN_SELECTOR)]
        .find(element => missingAnswer(entryFor(element)));
      const userId = element?.getAttribute("data-turn-key") || "";
      if (!userId) { candidate = ""; return; }
      const signature = `${id}:${userId}`;
      if ((attempts.get(signature) || 0) >= 3) return;
      if (candidate !== signature) {
        candidate = signature;
        candidateSince = Date.now();
        return;
      }
      if (Date.now() - candidateSince < SETTLE_MS) return;
      pending = true;
      attempts.set(signature, (attempts.get(signature) || 0) + 1);
      retryAfter = Date.now() + 60_000;
      const saved = await loadSavedConversation(id);
      const answerId = answerForTurn(saved, userId);
      // Recheck after both network reads: a route change, draft, new response,
      // or late native answer must cancel recovery rather than interrupt it.
      if (!answerId || conversationId() !== id || !idle() || !element.isConnected
          || !missingAnswer(entryFor(element))) return;
      sessionStorage.setItem(STORAGE_PREFIX + id, JSON.stringify({ viewport: viewport(), restore: true }));
      location.reload();
    } catch { /* Storage, authentication and network failures leave the chat alone. */ }
    finally { pending = false; }
  }

  function restoreViewport() {
    const id = conversationId();
    if (!id) return;
    try {
      const key = STORAGE_PREFIX + id;
      const record = JSON.parse(sessionStorage.getItem(key) || "null");
      if (!record?.restore || !record.viewport) return;
      record.restore = false;
      sessionStorage.setItem(key, JSON.stringify(record));
      let attempts = 0;
      const timer = setInterval(() => {
        if (++attempts > 25 || conversationId() !== id) { clearInterval(timer); return; }
        const scroll = scroller();
        const anchor = [...document.querySelectorAll(TURN_SELECTOR)]
          .find(element => element.getAttribute("data-turn-key") === record.viewport.turn);
        if (!scroll || !anchor) return;
        scroll.scrollTop += anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - record.viewport.offset;
        clearInterval(timer);
      }, 200);
    } catch { /* A lost viewport must never prevent loading the conversation. */ }
  }

  // A small idle poll also notices React state changes with no DOM mutation.
  document.addEventListener("input", () => { lastInput = Date.now(); }, true);
  document.addEventListener("keydown", () => { lastInput = Date.now(); }, true);
  document.addEventListener("pointerdown", () => { lastInput = Date.now(); }, true);
  document.addEventListener("wheel", () => { lastInput = Date.now(); }, { capture: true, passive: true });
  document.addEventListener("compositionstart", () => { composing = true; }, true);
  document.addEventListener("compositionend", () => { composing = false; lastInput = Date.now(); }, true);
  window.addEventListener("ghrc:route-change", () => { candidate = ""; });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", restoreViewport, { once: true });
  else restoreViewport();
  setInterval(() => { void check(); }, 2_000);
})();
