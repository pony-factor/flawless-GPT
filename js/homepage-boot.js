(() => {
  const BOOT_ATTR = "data-ghrc-homepage-booting";
  const COMPACT_LAYOUT_READY_ATTR = "data-ghrc-compact-layout-ready";
  const WIDGET_ID = "github-repositories-for-chatgpt";
  const LOADING_TEXT = "Loading repositories…";
  const COMPACT_HEADER_SETTING_KEY = "compactNewChatHeader";
  const FAIL_OPEN_MILLISECONDS = 8000;

  if (location.pathname !== "/") return;

  const root = document.documentElement;
  if (!root) return;

  root.setAttribute(BOOT_ATTR, "true");

  let compactHeaderEnabled = null;
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

  function repositoriesReady() {
    const widget = document.getElementById(WIDGET_ID);
    if (!widget) return false;

    return ![...widget.querySelectorAll(".ghrc-state")]
      .some((element) => element.textContent.trim() === LOADING_TEXT);
  }

  function revealWhenReady() {
    if (location.pathname !== "/") {
      reveal();
      return;
    }

    if (compactHeaderEnabled === null) return;
    if (
      compactHeaderEnabled
      && !root.hasAttribute(COMPACT_LAYOUT_READY_ATTR)
    ) return;
    if (!repositoriesReady()) return;

    reveal();
  }

  observer = new MutationObserver(revealWhenReady);
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [COMPACT_LAYOUT_READY_ATTR],
  });

  failOpenTimer = window.setTimeout(reveal, FAIL_OPEN_MILLISECONDS);
  window.navigation?.addEventListener("navigate", (event) => {
    if (new URL(event.destination.url).pathname !== "/") reveal();
  });
  window.addEventListener("popstate", revealWhenReady);
  window.addEventListener("pageshow", revealWhenReady, { once: true });

  chrome.storage.local.get({ [COMPACT_HEADER_SETTING_KEY]: false })
    .then((settings) => {
      compactHeaderEnabled = Boolean(settings[COMPACT_HEADER_SETTING_KEY]);
      revealWhenReady();
    })
    .catch(() => {
      compactHeaderEnabled = false;
      revealWhenReady();
    });
})();
