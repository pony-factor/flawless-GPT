(() => {
  const BOOT_ATTR = "data-ghrc-homepage-booting";
  const COMPACT_LAYOUT_READY_ATTR = "data-ghrc-compact-layout-ready";
  const REPOSITORIES_READY_ATTR = "data-ghrc-repositories-ready";
  const WIDGET_ID = "github-repositories-for-chatgpt";
  const FAIL_OPEN_MILLISECONDS = 8000;

  if (location.pathname !== "/") return;

  const context = globalThis.__ghrcExtensionContext;
  const root = document.documentElement;
  if (!root || !context?.active()) return;

  root.setAttribute(BOOT_ATTR, "true");

  let settings = null;
  let revealed = false;
  let observer = null;
  let failOpenTimer = null;

  function reveal() {
    if (revealed) return;
    revealed = true;
    observer?.disconnect();
    if (failOpenTimer !== null) clearTimeout(failOpenTimer);

    requestAnimationFrame(() => {
      root.removeAttribute(BOOT_ATTR);
    });
  }

  function revealWhenReady() {
    if (location.pathname !== "/") {
      reveal();
      return;
    }

    if (!settings) return;
    if (
      settings.compactNewChatHeader
      && !root.hasAttribute(COMPACT_LAYOUT_READY_ATTR)
    ) return;
    const widget = document.getElementById(WIDGET_ID);
    if (!widget || (!settings.hideRepositoryDashboard && !widget.hasAttribute(REPOSITORIES_READY_ATTR))) return;

    reveal();
  }

  observer = new MutationObserver(revealWhenReady);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [COMPACT_LAYOUT_READY_ATTR, REPOSITORIES_READY_ATTR],
  });

  // Leave the native page usable if ChatGPT never mounts a dashboard.
  failOpenTimer = window.setTimeout(() => {
    if (!context.active() || !document.getElementById(WIDGET_ID)) reveal();
  }, FAIL_OPEN_MILLISECONDS);
  context.onStop(reveal);
  window.navigation?.addEventListener("navigate", (event) => {
    if (new URL(event.destination.url).pathname !== "/") reveal();
  });
  window.addEventListener("popstate", revealWhenReady);
  window.addEventListener("pageshow", revealWhenReady, { once: true });

  chrome.storage.local.get({ compactNewChatHeader: true, hideRepositoryDashboard: false })
    .then((preferences) => {
      settings = preferences;
      revealWhenReady();
    })
    .catch(() => {
      settings = {};
      revealWhenReady();
    });
})();
