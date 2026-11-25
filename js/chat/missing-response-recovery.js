(() => {
  "use strict";

  const POLL_MS = 2_000;
  const REFRESH_MS = 15_000;
  const ACTIVE_MS = 15 * 60_000;
  const MAX_AUTO_READS = 3;
  const TURN_SELECTOR = "[data-turn-key]";
  const COMPOSER_SELECTOR = '#prompt-textarea, [data-composer-markdown][contenteditable="true"]';

  function shouldCoolDown(lastPromptAt, now = Date.now()) {
    return now - lastPromptAt >= ACTIVE_MS;
  }

  function retryDelay(value, now = Date.now()) {
    const seconds = value === null ? NaN : Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    return Number.isFinite(delay) ? Math.max(60_000, delay) : 60_000;
  }

  function missingAnswer(entry) {
    const turn = entry?.turn;
    if (turn?.status !== "complete" || entry.errorMessage || !Array.isArray(turn.items)) return false;
    // Completed reasoning groups also contain commentary and tool calls. Saved
    // MCP calls can retain completed:false even after their group and turn finish.
    // Only recognize these observed children; top-level answers still disqualify
    // the turn, and recovery still requires saved final text on its selected branch.
    return turn.items.some(item => item.type === "user-message")
      && turn.items.some(item => item.type === "chatgpt-reasoning-group" && item.completed)
      && turn.items.every(item => item.type === "user-message"
        || item.type === "chatgpt-reasoning-group" && item.completed
          && Array.isArray(item.items)
          && item.items.every(step => (step.type === "reasoning" || step.type === "assistant-message")
            && step.completed === true || step.type === "mcp-tool-call"));
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

  function savedAnswers(payload, userIds) {
    const answers = new Map();
    const messages = new Map(Object.values(payload.mapping || {})
      .filter(node => node.message).map(node => [node.message.id || node.id, node.message]));
    for (const userId of userIds) {
      const id = answerForTurn(payload, userId);
      const message = messages.get(id);
      if (message) answers.set(userId, {
        id, content: { parts: message.content.parts.filter(part => typeof part === "string") },
      });
    }
    // Do not retain the mapping, tool results, attachments or other branches.
    return answers;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { missingAnswer, answerForTurn, entryFor, shouldCoolDown, savedAnswers, retryDelay };
    return;
  }

  if (window.__ghrcMissingResponseRecoveryV2) return;
  window.__ghrcMissingResponseRecoveryV2 = true;
  let pending = false;
  let retryAfter = 0;
  let savedConversation = null;
  let savedId = "";
  let pollingTimer = null;
  let lastPromptAt = Date.now();
  let previousPath = location.pathname;
  let submittedFromNewChat = false;
  let generation = 0;
  let activeRequest = null;
  let attemptedTurns = "";
  let networkAttempts = 0;
  let serverRetryAfter = 0;

  const conversationId = () => location.pathname.match(/^\/c\/([a-zA-Z0-9-]+)$/)?.[1] || "";
  const scroller = () => document.querySelector("[data-app-action-timeline-scroll]");

  async function loadSavedConversation(id, signal) {
    // Keep authentication inside the page, as with personalization reads.
    // Never persist or bridge credentials or conversation contents.
    const sessionResponse = await fetch("/api/auth/session", {
      credentials: "include", cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!sessionResponse.ok) {
      if (sessionResponse.status === 429) serverRetryAfter = Date.now() + retryDelay(sessionResponse.headers.get("Retry-After"));
      return null;
    }
    const session = await sessionResponse.json();
    if (!session.accessToken) return null;
    const response = await fetch(`/backend-api/conversation/${id}`, {
      credentials: "include", cache: "no-store",
      headers: { authorization: `Bearer ${session.accessToken}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (response.status === 429) serverRetryAfter = Date.now() + retryDelay(response.headers.get("Retry-After"));
    return response.ok ? response.json() : null;
  }

  // Recovered content is stored Markdown, not already-rendered chat HTML.
  // Parse it with the bundled converter and sanitize it before insertion.
  const markdownConverter = typeof showdown !== "undefined"
    ? new showdown.Converter({
      tables: true, strikethrough: true, tasklists: true, ghCodeBlocks: true,
      openLinksInNewWindow: false,
    }) : null;
  function renderMarkdown(answer, text) {
    if (!markdownConverter || typeof DOMPurify === "undefined" || typeof DOMPurify.sanitize !== "function") {
      // Remain safe and readable if one of the bundled libraries fails to load.
      answer.textContent = text;
      answer.style.whiteSpace = "pre-wrap";
      return;
    }
    const fragment = DOMPurify.sanitize(markdownConverter.makeHtml(text), {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: [
        "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr",
        "strong", "b", "em", "i", "del", "s", "sup", "sub", "span",
        "ul", "ol", "li", "blockquote", "pre", "code",
        "table", "thead", "tbody", "tr", "th", "td",
        "a", "img", "input",
      ],
      ALLOWED_ATTR: ["href", "title", "src", "alt", "class", "type", "checked", "disabled", "start", "align"],
    });
    for (const input of fragment.querySelectorAll("input")) {
      // GFM task list markers must remain inert, not interactive form fields.
      if (input.getAttribute("type") !== "checkbox") { input.remove(); continue; }
      input.disabled = true;
      input.tabIndex = -1;
      input.setAttribute("aria-hidden", "true");
    }
    for (const link of fragment.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href") || "";
      // Only safe web links, email links and local document anchors.
      if (!/^(?:https?:\/\/|mailto:|#|\/(?!\/))/i.test(href)) link.removeAttribute("href");
      else link.rel = "noopener noreferrer";
    }
    for (const image of fragment.querySelectorAll("img")) {
      // Disallow data/blob/relative image URLs and avoid leaking referrers.
      if (!/^https?:\/\//i.test(image.getAttribute("src") || "")) { image.remove(); continue; }
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
    }
    answer.replaceChildren(fragment);
    answer.style.whiteSpace = "";
  }

  function renderAnswer(element, message) {
    const text = message.content.parts.filter(part => typeof part === "string").join("\n\n");
    let answer = element.querySelector("[data-ghrc-recovered-answer]");
    if (answer?.dataset.messageId === message.id && answer.__ghrcSourceMarkdown === text) return;
    const scroll = scroller();
    const previousTop = scroll?.scrollTop;
    if (!answer) {
      answer = document.createElement("div");
      answer.dataset.ghrcRecoveredAnswer = "";
      answer.className = "markdown prose dark:prose-invert w-full break-words";
      answer.setAttribute("data-message-author-role", "assistant");
      answer.setAttribute("aria-label", "Recovered ChatGPT response");
      element.append(answer);
    }
    answer.dataset.messageId = message.id;
    renderMarkdown(answer, text);
    // textContent no longer equals the Markdown source after formatting.
    answer.__ghrcSourceMarkdown = text;
    if (scroll) scroll.scrollTop = previousTop;
  }

  function repair(elements, saved) {
    for (const element of elements) {
      if (!element.isConnected || !missingAnswer(entryFor(element))) continue;
      const message = saved.get(element.getAttribute("data-turn-key"));
      if (message) renderAnswer(element, message);
    }
  }

  async function check() {
    if (document.hidden || globalThis.navigator?.onLine === false) return;
    const requestGeneration = generation;
    const id = conversationId();
    if (!id) return;
    const turns = [...document.querySelectorAll(TURN_SELECTOR)];
    // Once the native renderer catches up, its answer takes over.
    for (const element of turns) {
      if (!missingAnswer(entryFor(element))) element.querySelector("[data-ghrc-recovered-answer]")?.remove();
    }
    const elements = turns.filter(element => missingAnswer(entryFor(element)));
    if (!elements.length) {
      savedConversation = null;
      attemptedTurns = "";
      networkAttempts = 0;
      return;
    }
    const turnKey = elements.map(element => element.getAttribute("data-turn-key")).sort().join("|");
    if (turnKey !== attemptedTurns) {
      attemptedTurns = turnKey;
      networkAttempts = 0;
    }
    if (savedConversation) {
      const missingIds = new Set(elements.map(element => element.getAttribute("data-turn-key")));
      for (const key of savedConversation.keys()) if (!missingIds.has(key)) savedConversation.delete(key);
    }
    if (savedId !== id) {
      savedId = id;
      savedConversation = null;
      retryAfter = 0;
    }
    if (savedConversation) {
      repair(elements, savedConversation);
      // A successfully saved final message can still be a partial snapshot.
      // Allow a bounded follow-up window for later saved text, rather than
      // fetching the whole conversation for as long as native rendering is broken.
    }
    if (pending || networkAttempts >= MAX_AUTO_READS
        || Date.now() < Math.max(retryAfter, serverRetryAfter)) return;
    pending = true;
    networkAttempts++;
    retryAfter = Date.now() + REFRESH_MS;
    const requestController = new AbortController();
    activeRequest = requestController;
    try {
      const saved = await loadSavedConversation(id, requestController.signal);
      if (generation !== requestGeneration || conversationId() !== id) return;
      if (!saved?.mapping) { retryAfter = Date.now() + 60_000 * 2 ** Math.max(0, networkAttempts - 1); return; }
      const currentElements = [...document.querySelectorAll(TURN_SELECTOR)]
        .filter(element => missingAnswer(entryFor(element)));
      savedConversation = savedAnswers(saved, currentElements.map(element => element.getAttribute("data-turn-key")));
      // Repair only the completed missing turns. Drafts, the queue, and the
      // currently streaming turn are never changed or interrupted.
      repair(currentElements, savedConversation);
    } catch {
      // Cancelled reads must not rate-limit a new prompt after navigation.
      if (generation === requestGeneration) retryAfter = Date.now() + 60_000 * 2 ** Math.max(0, networkAttempts - 1);
    } finally {
      if (activeRequest === requestController) activeRequest = null;
      // An old request must not clear the pending flag of a newer session.
      if (generation === requestGeneration) pending = false;
    }
  }

  function stopPolling() {
    if (pollingTimer !== null) clearInterval(pollingTimer);
    pollingTimer = null;
    // A settled tab must not retain fetched content or an in-flight read.
    generation++;
    activeRequest?.abort();
    activeRequest = null;
    pending = false;
    savedId = "";
    savedConversation = null;
    retryAfter = 0;
    attemptedTurns = "";
    networkAttempts = 0;
  }

  function poll() {
    if (shouldCoolDown(lastPromptAt)) {
      stopPolling();
      return;
    }
    void check();
  }

  function startPolling() {
    if (pollingTimer !== null) return;
    pollingTimer = setInterval(poll, POLL_MS);
  }

  function promptActivity() {
    lastPromptAt = Date.now();
    startPolling();
  }

  function inComposer(target) {
    return target instanceof Element && Boolean(target.closest(COMPOSER_SELECTOR));
  }

  // A real user editing their prompt wakes a stable conversation, without
  // waking the scanner for clicks and DOM updates elsewhere on the page.
  function onComposerInput(event) {
    if (event.isTrusted && inComposer(event.target)) promptActivity();
  }

  function onPromptSend(event) {
    if (!event.isTrusted) return;
    let submitted = false;
    if (event.type === "keydown") {
      submitted = event.key === "Enter" && !event.shiftKey && !event.isComposing
        && !event.ctrlKey && !event.metaKey && !event.altKey && inComposer(event.target);
    } else if (event.type === "click") {
      const button = event.target.closest?.(
        'button[data-testid="send-button"], button[data-testid="composer-submit-button"], '
        + 'button#composer-submit-button, button[aria-label^="Send" i], button[type="submit"]',
      );
      submitted = Boolean(button && button.closest('form, [data-type="unified-composer"]'));
    } else if (event.type === "submit") {
      submitted = Boolean(event.target.querySelector?.(COMPOSER_SELECTOR));
    }
    if (!submitted) return;
    promptActivity();
    if (location.pathname === "/") submittedFromNewChat = true;
  }

  function onRouteChange() {
    const currentPath = location.pathname;
    if (currentPath === previousPath) return;
    const continueNewChat = previousPath === "/" && Boolean(conversationId())
      && submittedFromNewChat && !shouldCoolDown(lastPromptAt);
    previousPath = currentPath;
    submittedFromNewChat = false;
    // Navigating to another chat immediately ends the old conversation's
    // polling and abandons any in-flight saved-answer read.
    stopPolling();
    // A just-submitted prompt may transform / into /c/<id>. It must keep
    // monitoring that new response, rather than treating it as navigation away.
    if (continueNewChat) promptActivity();
  }

  document.addEventListener("input", onComposerInput, true);
  document.addEventListener("keydown", onPromptSend, true);
  document.addEventListener("click", onPromptSend, true);
  document.addEventListener("submit", onPromptSend, true);
  window.addEventListener("ghrc:route-change", onRouteChange);
  window.addEventListener("pagehide", stopPolling);
  window.addEventListener("ghrc:refresh-view", () => {
    // Respect pending reads and server cooldowns even on repeated manual clicks.
    networkAttempts = 0;
    promptActivity();
    void check();
  });
  // Existing conversations retain immediate recovery after a reload. A
  // brand-new homepage has nothing to recover and needs no idle timer.
  // After cooldown or navigation, only the next prompt wakes the scanner.
  if (conversationId()) startPolling();
})();
