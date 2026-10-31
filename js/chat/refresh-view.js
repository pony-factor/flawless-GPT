(() => {
  "use strict";
  if (window.__ghrcRefreshView) return;
  window.__ghrcRefreshView = true;

  const conversation = () => /^\/c\/[a-zA-Z0-9-]+$/.test(location.pathname);
  let control;
  let button;
  let status;
  let pending = false;
  let nextRefresh = 0;

  function findRouter() {
    // Use the page's existing data router; never remount React or navigate away.
    for (const element of [document.querySelector('main, [role="main"]'), document.body]) {
      if (!element) continue;
      const key = Object.keys(element).find(name => name.startsWith("__reactFiber$"));
      let fiber = key && element[key];
      let root = fiber;
      while (root?.return) root = root.return;
      if (root?.stateNode?.current && root.stateNode.current !== root) fiber = fiber?.alternate;
      for (let depth = 0; fiber && depth < 200; depth++, fiber = fiber.return) {
        const router = fiber.memoizedProps?.value?.router || fiber.memoizedProps?.router;
        if (typeof router?.revalidate === "function" && typeof router?.subscribe === "function") return router;
      }
    }
    return null;
  }

  async function revalidate(router) {
    let unsubscribe;
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 15_000);
        unsubscribe = router.subscribe(state => {
          if (state.revalidation === "idle") resolve();
        });
        const result = router.revalidate();
        if (result?.then) result.then(resolve, reject);
        else if (router.state?.revalidation === "idle") resolve();
      });
    } finally {
      clearTimeout(timer);
      unsubscribe?.();
    }
  }

  async function refresh() {
    if (pending || !conversation()) return;
    if (Date.now() < nextRefresh) {
      status.textContent = "Please wait a moment before refreshing again.";
      return;
    }
    if (document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop"], button[aria-label="Stop generating"]')) {
      status.textContent = "Wait for the current response to finish.";
      return;
    }
    pending = true;
    button.disabled = true;
    button.textContent = "Refreshing…";
    status.textContent = "";
    const path = location.pathname;
    nextRefresh = Date.now() + 30_000;
    try {
      window.dispatchEvent(new Event("ghrc:refresh-view"));
      const router = findRouter();
      if (router) {
        await revalidate(router);
        if (location.pathname === path) status.textContent = "Refresh finished. Any loading error is shown in the conversation.";
      } else {
        // Error screens already expose a native retry that keeps this document.
        const main = document.querySelector('main, [role="main"]');
        const retry = main && /Could not load this ChatGPT conversation/.test(main.textContent)
          && [...main.querySelectorAll("button")].find(node => node.textContent.trim() === "Try again");
        if (retry && !retry.disabled) {
          retry.click();
          status.textContent = "Retry requested without reloading.";
        } else {
          status.textContent = "This page does not expose an in-place refresh. Missing-answer recovery was requested.";
        }
      }
    } catch {
      if (location.pathname === path) status.textContent = "Refresh did not finish. Please wait before trying again.";
    } finally {
      pending = false;
      button.disabled = false;
      button.textContent = "↻ Refresh view";
    }
  }

  function mount() {
    if (!document.body) return;
    if (!control) {
      control = document.createElement("div");
      control.id = "ghrc-refresh-view";
      button = document.createElement("button");
      button.type = "button";
      button.textContent = "↻ Refresh view";
      button.title = "Refresh this conversation without reloading the page";
      button.addEventListener("click", refresh);
      status = document.createElement("div");
      status.setAttribute("role", "status");
      control.append(button, status);
    }
    if (!control.isConnected) document.body.append(control);
    control.hidden = !conversation();
  }
  window.addEventListener("ghrc:route-change", () => {
    if (status) status.textContent = "";
    mount();
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
