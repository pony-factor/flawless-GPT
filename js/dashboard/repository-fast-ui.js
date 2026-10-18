(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const WIDGET_ID = "github-repositories-for-chatgpt";
  const PINNED_STORAGE_KEY = "pinnedRepositories";
  const LOADING_TEXT = "Loading repositories…";
  let searchCategorizationScheduled = false;

  function preloadRepositories() {
    try {
      chrome.runtime.sendMessage({ type: "preload-repositories" }, () => {
        // Consume lastError so an extension reload does not surface a console error.
        void chrome.runtime.lastError;
      });
    } catch {
      // A document_start script from before an extension reload can lose its worker.
    }
  }

  preloadRepositories();

  function normalizedPins(pinnedRepositories) {
    const seen = new Set();
    return (Array.isArray(pinnedRepositories) ? pinnedRepositories : [])
      .filter((fullName) => typeof fullName === "string" && fullName.includes("/"))
      .map((fullName) => fullName.trim())
      .filter((fullName) => {
        const key = fullName.toLowerCase();
        if (!fullName || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function repositoryIcon() {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "ghrc-repository-icon");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-8.5a1.25 1.25 0 0 0 0 2h8.5a.75.75 0 0 1 0 1.5h-8.5A2.75 2.75 0 0 1 2 14.75Zm2.5-1A1 1 0 0 0 3.5 2.5v9.87c.38-.24.81-.37 1.25-.37h7.75V1.5Z",
    );
    icon.append(path);
    return icon;
  }

  async function unpinRepository(fullName) {
    if (!context.active()) return;
    const stored = await chrome.storage.local.get({ [PINNED_STORAGE_KEY]: [] });
    if (!context.active()) return;
    const pins = normalizedPins(stored[PINNED_STORAGE_KEY]);
    const key = fullName.toLowerCase();
    await chrome.storage.local.set({
      [PINNED_STORAGE_KEY]: pins.filter((pin) => pin.toLowerCase() !== key),
    });
  }

  function createWarmPinnedRepository(fullName) {
    const item = document.createElement("div");
    item.className = "ghrc-repository";
    item.dataset.pinned = "true";

    const link = document.createElement("a");
    link.className = "ghrc-repository-link";
    link.href = `https://github.com/${fullName.split("/").map(encodeURIComponent).join("/")}`;

    const title = document.createElement("span");
    title.className = "ghrc-repository-title";
    title.append(repositoryIcon());

    const name = document.createElement("span");
    name.className = "ghrc-repository-name";
    name.textContent = fullName;
    title.append(name);
    link.append(title);

    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "ghrc-pin";
    pin.textContent = "Pinned";
    pin.title = "Unpin repository";
    pin.setAttribute("aria-label", `Unpin ${fullName}`);
    pin.addEventListener("click", async () => {
      pin.disabled = true;
      try {
        await unpinRepository(fullName);
        item.remove();
      } catch (error) {
        context.handleError(error);
      } finally {
        pin.disabled = false;
      }
    });

    item.append(link, pin);
    return item;
  }

  async function showWarmPins(widget) {
    if (!widget?.isConnected || widget.dataset.ghrcWarmPins) return;
    const loading = [...widget.querySelectorAll(".ghrc-state")]
      .find((element) => element.textContent.trim() === LOADING_TEXT);
    if (!loading) return;

    widget.dataset.ghrcWarmPins = "loading";
    if (!context.active()) return;
    const stored = await chrome.storage.local.get({ [PINNED_STORAGE_KEY]: [] });
    if (!context.active()) return;
    const pins = normalizedPins(stored[PINNED_STORAGE_KEY]);
    if (!pins.length || !widget.isConnected || !loading.isConnected) return;

    widget.dataset.ghrcWarmPins = "true";
    const warm = document.createElement("section");
    warm.className = "ghrc-warm-pins";
    warm.setAttribute("aria-label", "Pinned repositories loading from cache");

    const header = document.createElement("div");
    header.className = "ghrc-warm-pins-header";
    const title = document.createElement("strong");
    title.textContent = "Pinned repositories";
    const status = document.createElement("span");
    status.textContent = "Refreshing repository data…";
    header.append(title, status);

    const list = document.createElement("div");
    list.className = "ghrc-warm-pins-list";
    list.append(...pins.map(createWarmPinnedRepository));
    warm.append(header, list);
    loading.replaceWith(warm);
  }

  function ownerForSearchRow(row) {
    const fullName = row.querySelector(".ghrc-repository-name")?.textContent?.trim() || "";
    const separator = fullName.indexOf("/");
    return separator > 0 ? fullName.slice(0, separator) : "Other";
  }

  function buildSearchCategory(owner, rows) {
    const category = document.createElement("section");
    category.className = "ghrc-search-category";
    category.setAttribute("aria-label", `${owner} search results`);

    const heading = document.createElement("div");
    heading.className = "ghrc-search-category-heading";
    const repositoriesUrl = rows[0]?.dataset.ownerRepositoriesUrl;
    if (repositoriesUrl) {
      const link = document.createElement("a");
      link.className = "ghrc-owner-profile-link";
      link.href = repositoriesUrl;
      link.textContent = owner;
      link.setAttribute("aria-label", `Open ${owner} repositories on GitHub`);
      heading.append(link);
    } else {
      heading.textContent = owner;
    }

    const list = document.createElement("div");
    list.className = "ghrc-search-category-list";
    list.append(...rows);
    category.append(heading, list);
    return category;
  }

  function categorizeSearchResults(container) {
    if (!container?.isConnected || container.hidden) return;
    const rows = [...container.children]
      .filter((child) => child.classList.contains("ghrc-repository"));
    if (!rows.length) return;

    const groupedRows = new Map();
    for (const row of rows) {
      const owner = ownerForSearchRow(row);
      if (!groupedRows.has(owner)) groupedRows.set(owner, []);
      groupedRows.get(owner).push(row);
    }

    const categories = [...groupedRows]
      .map(([owner, ownerRows]) => buildSearchCategory(owner, ownerRows));
    container.replaceChildren(...categories);
  }

  function scheduleSearchCategorization() {
    if (searchCategorizationScheduled) return;
    searchCategorizationScheduled = true;
    queueMicrotask(() => {
      searchCategorizationScheduled = false;
      document.querySelectorAll(`#${WIDGET_ID} .ghrc-search-results`)
        .forEach(categorizeSearchResults);
    });
  }

  function updateFastUi() {
    if (!context.active()) return;
    const widget = document.getElementById(WIDGET_ID);
    if (widget) void context.run(() => showWarmPins(widget));
    scheduleSearchCategorization();
  }

  const observer = new MutationObserver(updateFastUi);
  context.onStop(() => observer.disconnect());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  updateFastUi();
})();
