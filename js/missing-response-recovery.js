(() => {
  "use strict";

  const POLL_MS = 2_000;
  const REFRESH_MS = 15_000;
  const TURN_SELECTOR = "[data-turn-key]";

  function missingAnswer(entry) {
    const turn = entry?.turn;
    if (turn?.status !== "complete" || entry.errorMessage || !Array.isArray(turn.items)) return false;
    // Unknown item kinds may be answers (images, tools, future renderers).
    // Completed reasoning can contain steps even when the final answer is absent.
    // Keep unknown or unfinished children out of this conservative recovery path.
    return turn.items.some(item => item.type === "user-message")
      && turn.items.some(item => item.type === "chatgpt-reasoning-group" && item.completed)
      && turn.items.every(item => item.type === "user-message"
        || item.type === "chatgpt-reasoning-group" && item.completed
          && Array.isArray(item.items)
          && item.items.every(step => step.type === "reasoning" && step.completed === true));
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

  if (window.__ghrcMissingResponseRecoveryV2) return;
  window.__ghrcMissingResponseRecoveryV2 = true;
  let pending = false;
  let retryAfter = 0;
  let savedConversation = null;
  let savedId = "";

  const conversationId = () => location.pathname.match(/^\/c\/([a-zA-Z0-9-]+)$/)?.[1] || "";
  const scroller = () => document.querySelector("[data-app-action-timeline-scroll]");

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

  function renderAnswer(element, message) {
    const text = message.content.parts.filter(part => typeof part === "string").join("\n\n");
    let answer = element.querySelector("[data-ghrc-recovered-answer]");
    if (answer?.dataset.messageId === message.id && answer.textContent === text) return;
    const scroll = scroller();
    const previousTop = scroll?.scrollTop;
    if (!answer) {
      answer = document.createElement("div");
      answer.dataset.ghrcRecoveredAnswer = "";
      answer.setAttribute("data-message-author-role", "assistant");
      answer.setAttribute("aria-label", "Recovered ChatGPT response");
      // Render saved text as text, never HTML: answers may contain arbitrary
      // code or markup. Keep paragraphs and code indentation readable.
      answer.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;margin-block:1rem;user-select:text";
      element.append(answer);
    }
    answer.dataset.messageId = message.id;
    answer.textContent = text;
    if (scroll) scroll.scrollTop = previousTop;
  }

  function repair(elements, saved) {
    for (const element of elements) {
      if (!element.isConnected || !missingAnswer(entryFor(element))) continue;
      const answerId = answerForTurn(saved, element.getAttribute("data-turn-key"));
      const message = answerId && Object.values(saved.mapping)
        .find(node => (node.message?.id || node.id) === answerId)?.message;
      if (message) renderAnswer(element, { ...message, id: answerId });
    }
  }

  async function check() {
    const id = conversationId();
    if (!id) return;
    const turns = [...document.querySelectorAll(TURN_SELECTOR)];
    // Once the native renderer catches up, its answer takes over.
    for (const element of turns) {
      if (!missingAnswer(entryFor(element))) element.querySelector("[data-ghrc-recovered-answer]")?.remove();
    }
    const elements = turns.filter(element => missingAnswer(entryFor(element)));
    if (!elements.length) return;
    if (savedId !== id) {
      savedId = id;
      savedConversation = null;
      retryAfter = 0;
    }
    if (savedConversation) {
      repair(elements, savedConversation);
      if (elements.every(element => answerForTurn(savedConversation, element.getAttribute("data-turn-key")))) return;
    }
    if (pending || Date.now() < retryAfter) return;
    pending = true;
    retryAfter = Date.now() + REFRESH_MS;
    try {
      const saved = await loadSavedConversation(id);
      if (conversationId() !== id) return;
      if (!saved?.mapping) { retryAfter = Date.now() + 60_000; return; }
      savedConversation = saved;
      // Repair only the completed missing turns. Drafts, the queue, and the
      // currently streaming turn are never changed or interrupted.
      repair(elements, saved);
    } catch {
      retryAfter = Date.now() + 60_000;
    } finally { pending = false; }
  }

  window.addEventListener("ghrc:route-change", () => {
    savedId = "";
    savedConversation = null;
    retryAfter = 0;
  });
  // No navigation or reload is needed; recover while other work continues.
  setInterval(() => { void check(); }, POLL_MS);
})();
