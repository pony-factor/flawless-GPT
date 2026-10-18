(() => {
  "use strict";

  const POLL_MS = 2_000;
  const REFRESH_MS = 15_000;
  const TURN_SELECTOR = "[data-turn-key]";

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
      // A successfully saved final message can still be a partial snapshot.
      // Refresh while native rendering remains broken, even when every turn
      // already has a cached answer, so later saved text replaces that snapshot.
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
