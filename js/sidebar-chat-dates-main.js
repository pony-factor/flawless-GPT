(() => {
  "use strict";

  const SOURCE = "flawless-gpt";
  const DATA_EVENT = "ghrc:conversation-dates";
  const REQUEST_EVENT = "ghrc:conversation-dates:request";
  const nativeFetch = window.fetch;
  const dates = new Map();

  function normalizeItems(payload) {
    if (!Array.isArray(payload?.items)) return [];
    return payload.items.flatMap(item => {
      const id = typeof item?.id === "string" ? item.id : "";
      const createTime = item?.create_time;
      if (!id || (typeof createTime !== "string" && typeof createTime !== "number")) return [];
      return [{ id, createTime }];
    });
  }

  function publish(items) {
    if (!items.length) return;
    for (const item of items) dates.set(item.id, item.createTime);
    window.postMessage({ source: SOURCE, type: DATA_EVENT, items }, location.origin);
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.source !== SOURCE || event.data?.type !== REQUEST_EVENT) return;
    publish([...dates].map(([id, createTime]) => ({ id, createTime })));
  });

  window.fetch = async function flawlessConversationDateFetch(...args) {
    const response = await Reflect.apply(nativeFetch, this, args);
    try {
      const input = args[0];
      const requestUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(requestUrl, location.href);
      if (url.origin === location.origin && url.pathname === "/backend-api/conversations") {
        void response.clone().json().then(payload => publish(normalizeItems(payload))).catch(() => {});
      }
    } catch {
      // Conversation dates are an optional display enhancement.
    }
    return response;
  };
})();
