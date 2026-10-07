(() => {
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const WIDGET_ID = "github-repositories-for-chatgpt";
  const NEW_CHAT_ATTR = "data-ghrc-new-chat";
  const HIDE_DICTATION_ATTR = "data-ghrc-hide-dictation";
  const COMPACT_HEADER_ATTR = "data-ghrc-compact-header";
  const COMPOSER_READY_ATTR = "data-ghrc-composer-ready";
  const HIDDEN_WELCOME_CLASS = "ghrc-hidden-welcome";
  const USAGE_STORAGE_KEY = "repositoryUsage";
  const PINNED_STORAGE_KEY = "pinnedRepositories";
  const HIDDEN_OWNERS_KEY = "hiddenOwners";
  const OWNER_GROUPS_PER_PAGE_KEY = "ownerGroupsPerPage";
  const SHOW_REPOSITORY_SEARCH_KEY = "showRepositorySearch";
  const SHOW_REPOSITORY_TOTAL_KEY = "showRepositoryTotal";
  const SHOW_WOOTEN_LINK_SEARCH_KEY = "showWootenLinkSearch";
  const DEFAULT_OWNER_GROUPS_PER_PAGE = 6;
  const REPOSITORIES_PER_COLUMN = 7;
  const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
  let mountScheduled = false;
  let repositoryRequest = null;
  let wootenLinkEntriesRequest = null;
  let layoutObserver = null;
  let observedLayoutContainer = null;

  function githubIcon(className = "ghrc-github-icon") {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", className);
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.28-5.27-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.19c.98 0 1.95.13 2.87.39 2.19-1.49 3.15-1.18 3.15-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.71 5.38-5.29 5.67.42.36.79 1.07.79 2.16v3.18c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z",
    );
    icon.append(path);
    return icon;
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

  function isDashboardPage() {
    return location.pathname === "/";
  }

  function isNewChatPage() {
    return isDashboardPage()
      && Boolean(document.querySelector(
        '#prompt-textarea, [data-composer-markdown][contenteditable="true"]',
      ));
  }

  function findComposer() {
    const prompt = document.querySelector('#prompt-textarea, [data-composer-markdown][contenteditable="true"]');
    if (!prompt) return null;

    return prompt.closest("form") || prompt.closest('[data-type="unified-composer"]');
  }

  function clearPageAdjustments() {
    document.documentElement.removeAttribute(NEW_CHAT_ATTR);
    document.querySelectorAll(`.${HIDDEN_WELCOME_CLASS}`).forEach((element) => {
      element.classList.remove(HIDDEN_WELCOME_CLASS);
    });
  }

  function updateWelcomeHeading(composer) {
    if (
      !document.documentElement.hasAttribute(COMPACT_HEADER_ATTR)
    ) {
      document.querySelectorAll(`.${HIDDEN_WELCOME_CLASS}`).forEach((element) => {
        element.classList.remove(HIDDEN_WELCOME_CLASS);
      });
      return;
    }

    const hiddenHeading = document.querySelector(`.${HIDDEN_WELCOME_CLASS}`);
    if (hiddenHeading?.isConnected && !hiddenHeading.contains(composer)) return;

    const main = composer.closest("main") || document.querySelector("main");
    if (!main) return;

    const composerBounds = composer.getBoundingClientRect();
    const candidates = [...main.querySelectorAll('h1, h2, [role="heading"]')]
      .filter((heading) => {
        if (!heading.textContent.trim() || heading.closest(`#${WIDGET_ID}`)) return false;

        const bounds = heading.getBoundingClientRect();
        const headingCenter = bounds.left + (bounds.width / 2);
        const composerCenter = composerBounds.left + (composerBounds.width / 2);
        const isAboveComposer = bounds.bottom <= composerBounds.top + 8
          && composerBounds.top - bounds.bottom < 320;
        const isHorizontallyAligned = Math.abs(headingCenter - composerCenter)
          < Math.max(160, composerBounds.width / 2);
        return isAboveComposer && isHorizontallyAligned;
      })
      .sort((first, second) => (
        second.getBoundingClientRect().bottom - first.getBoundingClientRect().bottom
      ));

    if (candidates[0]) {
      candidates[0].classList.add(HIDDEN_WELCOME_CLASS);
      return;
    }

    const thread = composer.closest("#thread");
    if (!thread) return;

    let composerRegion = composer;
    while (composerRegion.parentElement && composerRegion.parentElement !== thread) {
      composerRegion = composerRegion.parentElement;
    }

    if (composerRegion.parentElement === thread) {
      composerRegion.previousElementSibling?.classList.add(HIDDEN_WELCOME_CLASS);
    }
  }

  function applyPageAdjustments(composer) {
    if (!document.documentElement.hasAttribute(NEW_CHAT_ATTR)) {
      document.documentElement.setAttribute(NEW_CHAT_ATTR, "true");
    }
    updateWelcomeHeading(composer);
  }

  function updateWidgetLayout(widget, composer) {
    const content = composer.closest("main");
    let parent = widget.parentElement;
    // display: contents wrappers have no box; offsets use the nearest layout box.
    while (parent && getComputedStyle(parent).display === "contents") {
      parent = parent.parentElement;
    }
    if (!content || !parent) return;

    const contentBounds = content.getBoundingClientRect();
    const parentBounds = parent.getBoundingClientRect();
    const contentCenter = contentBounds.left + (contentBounds.width / 2);
    const parentCenter = parentBounds.left + (parentBounds.width / 2);
    const availableWidth = Math.max(0, Math.floor(contentBounds.width - 40));

    widget.style.setProperty("--ghrc-available-width", `${availableWidth}px`);
    widget.toggleAttribute("data-ghrc-stacked", availableWidth <= 840);
    widget.style.setProperty(
      "--ghrc-center-offset",
      `${Math.round(contentCenter - parentCenter)}px`,
    );

    if (observedLayoutContainer === content) return;
    layoutObserver ??= new ResizeObserver(scheduleMount);
    layoutObserver.disconnect();
    layoutObserver.observe(content);
    observedLayoutContainer = content;
  }

  async function loadDisplayPreferences() {
    const preferences = await chrome.storage.local.get({
      hideDictationButton: false,
      compactNewChatHeader: false,
    });
    if (!context.active()) return;
    document.documentElement.toggleAttribute(
      HIDE_DICTATION_ATTR,
      Boolean(preferences.hideDictationButton),
    );
    document.documentElement.toggleAttribute(
      COMPACT_HEADER_ATTR,
      Boolean(preferences.compactNewChatHeader),
    );
    scheduleMount();
  }

  function daysSince(timestamp) {
    if (!timestamp) return 3650;
    return Math.max(0, (Date.now() - new Date(timestamp).getTime()) / DAY_IN_MILLISECONDS);
  }

  function repositoryScore(repository, usage) {
    const repositoryUsage = usage[repository.fullName.toLowerCase()] || {};
    const freshness = Math.exp(-daysSince(repository.pushedAt) / 120);
    const frequency = Math.min(1, Math.log2((repositoryUsage.opens || 0) + 1) / 4);
    const recentlyOpened = repositoryUsage.lastOpened
      ? Math.exp(-daysSince(repositoryUsage.lastOpened) / 30)
      : 0;

    return (freshness * 0.6) + (frequency * 0.27) + (recentlyOpened * 0.13);
  }

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

  function normalizedHiddenOwners(owners) {
    const seen = new Set();
    return (Array.isArray(owners) ? owners : [])
      .map((owner) => typeof owner === "string" ? owner.trim() : "")
      .filter((owner) => {
        const key = owner.toLowerCase();
        if (!owner || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function normalizedOwnerGroupsPerPage(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_OWNER_GROUPS_PER_PAGE;
    return Math.min(24, Math.max(1, parsed));
  }

  function rankRepositories(repositories, usage, pinnedRepositories = []) {
    const pinOrder = new Map(
      normalizedPins(pinnedRepositories).map((fullName, index) => [fullName.toLowerCase(), index]),
    );

    return [...repositories].sort((first, second) => {
      const firstPin = pinOrder.get(first.fullName.toLowerCase());
      const secondPin = pinOrder.get(second.fullName.toLowerCase());

      if (firstPin !== undefined || secondPin !== undefined) {
        return (firstPin ?? Number.MAX_SAFE_INTEGER) - (secondPin ?? Number.MAX_SAFE_INTEGER);
      }

      const scoreDifference = repositoryScore(second, usage) - repositoryScore(first, usage);
      if (Math.abs(scoreDifference) > 0.0001) return scoreDifference;

      return new Date(second.pushedAt).getTime() - new Date(first.pushedAt).getTime();
    });
  }

  function groupRepositories(
    repositories,
    ownerOrder,
    usage,
    pinnedRepositories,
    hiddenOwners = [],
  ) {
    const groups = new Map();
    const seenRepositories = new Set();
    const hiddenOwnerKeys = new Set(
      normalizedHiddenOwners(hiddenOwners).map((owner) => owner.toLowerCase()),
    );

    for (const repository of repositories) {
      const ownerKey = repository.owner.login.toLowerCase();
      if (hiddenOwnerKeys.has(ownerKey)) continue;

      const repositoryKey = repository.fullName.toLowerCase();
      if (seenRepositories.has(repositoryKey)) continue;
      seenRepositories.add(repositoryKey);

      if (!groups.has(ownerKey)) {
        groups.set(ownerKey, {
          owner: repository.owner,
          repositories: [],
        });
      }
      groups.get(ownerKey).repositories.push(repository);
    }

    const priority = new Map(ownerOrder.map((owner, index) => [owner.toLowerCase(), index]));
    return [...groups.values()]
      .map((group) => ({
        ...group,
        repositories: rankRepositories(group.repositories, usage, pinnedRepositories),
      }))
      .sort((first, second) => {
        const firstPriority = priority.get(first.owner.login.toLowerCase());
        const secondPriority = priority.get(second.owner.login.toLowerCase());

        if (firstPriority !== undefined || secondPriority !== undefined) {
          return (firstPriority ?? Number.MAX_SAFE_INTEGER)
            - (secondPriority ?? Number.MAX_SAFE_INTEGER);
        }

        return first.owner.login.localeCompare(second.owner.login);
      });
  }

  async function recordRepositoryUse(fullName) {
    const stored = await chrome.storage.local.get({ [USAGE_STORAGE_KEY]: {} });
    const usage = stored[USAGE_STORAGE_KEY];
    const key = fullName.toLowerCase();
    const current = usage[key] || { opens: 0, lastOpened: null };

    usage[key] = {
      opens: current.opens + 1,
      lastOpened: new Date().toISOString(),
    };
    await chrome.storage.local.set({ [USAGE_STORAGE_KEY]: usage });
  }

  async function toggleRepositoryPin(fullName) {
    const stored = await chrome.storage.local.get({ [PINNED_STORAGE_KEY]: [] });
    const pinnedRepositories = normalizedPins(stored[PINNED_STORAGE_KEY]);
    const key = fullName.toLowerCase();
    const existingIndex = pinnedRepositories.findIndex((pin) => pin.toLowerCase() === key);

    if (existingIndex === -1) {
      pinnedRepositories.push(fullName);
    } else {
      pinnedRepositories.splice(existingIndex, 1);
    }

    await chrome.storage.local.set({ [PINNED_STORAGE_KEY]: pinnedRepositories });
  }

  function repositoriesForColumn(repositories, pinnedRepositories) {
    const pinnedKeys = new Set(
      normalizedPins(pinnedRepositories).map((fullName) => fullName.toLowerCase()),
    );
    const pinnedCount = repositories.filter(
      (repository) => pinnedKeys.has(repository.fullName.toLowerCase()),
    ).length;
    return repositories.slice(0, Math.max(REPOSITORIES_PER_COLUMN, pinnedCount));
  }

  function ownerRepositoriesUrl(owner) {
    const login = encodeURIComponent(owner.login);
    return owner.type === "Organization"
      ? `https://github.com/orgs/${login}/repositories`
      : `https://github.com/${login}?tab=repositories`;
  }

  function createRepositoryItem(repository, includeOwner, pinnedRepositories) {
    const item = document.createElement("div");
    item.className = "ghrc-repository";
    item.dataset.ownerRepositoriesUrl = ownerRepositoriesUrl(repository.owner);
    const isPinned = normalizedPins(pinnedRepositories)
      .some((fullName) => fullName.toLowerCase() === repository.fullName.toLowerCase());
    item.dataset.pinned = String(isPinned);

    const link = document.createElement("a");
    link.className = "ghrc-repository-link";
    link.href = repository.url;
    link.addEventListener("click", () => {
      void context.run(() => recordRepositoryUse(repository.fullName));
    });

    const titleRow = document.createElement("span");
    titleRow.className = "ghrc-repository-title";
    titleRow.append(repositoryIcon());

    const name = document.createElement("span");
    name.className = "ghrc-repository-name";
    name.textContent = includeOwner ? repository.fullName : repository.name;
    titleRow.append(name);

    if (repository.isPrivate) {
      const visibility = document.createElement("span");
      visibility.className = "ghrc-visibility";
      visibility.textContent = "Private";
      titleRow.append(visibility);
    }

    link.append(titleRow);

    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "ghrc-pin";
    pin.textContent = isPinned ? "Pinned" : "Pin";
    pin.setAttribute(
      "aria-label",
      `${isPinned ? "Unpin" : "Pin"} ${repository.fullName}`,
    );
    pin.title = isPinned ? "Unpin repository" : "Pin repository";
    pin.addEventListener("click", async () => {
      pin.disabled = true;
      try {
        await toggleRepositoryPin(repository.fullName);
      } catch (error) {
        context.handleError(error);
      } finally {
        pin.disabled = false;
      }
    });

    item.append(link, pin);
    return item;
  }

  function createOwnerColumn(group, pinnedRepositories) {
    const column = document.createElement("section");
    column.className = "ghrc-owner-column";
    const displayName = group.owner.displayName || group.owner.login;
    column.setAttribute("aria-label", `${displayName} repositories`);

    const header = document.createElement("header");
    header.className = "ghrc-owner-header";
    header.dataset.ownerRepositoriesUrl = ownerRepositoriesUrl(group.owner);

    const avatar = document.createElement("img");
    avatar.className = "ghrc-owner-avatar";
    avatar.src = group.owner.avatarUrl;
    avatar.alt = "";

    const heading = document.createElement("div");
    const name = document.createElement("h3");
    name.textContent = displayName;
    if (displayName !== group.owner.login) name.title = group.owner.login;
    const type = document.createElement("span");
    type.textContent = group.owner.type === "Organization" ? "Organization" : "Personal";
    heading.append(name, type);
    header.append(avatar, heading);

    const list = document.createElement("div");
    list.className = "ghrc-repository-list";
    for (const repository of repositoriesForColumn(group.repositories, pinnedRepositories)) {
      list.append(createRepositoryItem(repository, false, pinnedRepositories));
    }

    column.append(header, list);
    return column;
  }

  function normalizeRepositorySearchText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[-_.\\/]+/g, " ")
      .replace(/\\s+/g, " ")
      .trim();
  }

  function repositoryMatchesSearch(repository, query) {
    const terms = normalizeRepositorySearchText(query).split(" ").filter(Boolean);
    if (!terms.length) return false;
    const searchable = normalizeRepositorySearchText([
      repository.fullName,
      repository.name,
      repository.owner?.login,
      repository.owner?.displayName,
      repository.description,
      repository.language,
    ].join(" "));
    return terms.every((term) => searchable.includes(term));
  }

  function renderSearchResults(container, repositories, query, pinnedRepositories) {
    container.replaceChildren();
    if (!normalizeRepositorySearchText(query)) {
      container.hidden = true;
      return;
    }

    const matches = repositories.filter((repository) => (
      repositoryMatchesSearch(repository, query)
    ));

    if (!matches.length) {
      const empty = document.createElement("p");
      empty.className = "ghrc-search-empty";
      empty.textContent = "No repositories you have interacted with match this search.";
      container.append(empty);
    } else {
      for (const repository of matches) {
        container.append(createRepositoryItem(repository, true, pinnedRepositories));
      }
    }

    container.hidden = false;
  }

  function requestOptionsPage(connectGithub = false) {
    try {
      chrome.runtime.sendMessage({ type: "open-options", connectGithub }, () => {
        // Consume lastError so a stale/missing worker does not surface as an unchecked error.
        void chrome.runtime.lastError;
      });
    } catch {
      // A content script from before an extension reload cannot reach the new worker.
    }
  }

  function createToolbar(
    widget,
    repositories,
    searchRepositories,
    mode,
    pinnedRepositories,
    showRepositorySearch,
    showRepositoryTotal,
  ) {
    if (!showRepositorySearch && !showRepositoryTotal) return;

    const toolbar = document.createElement("header");
    toolbar.className = showRepositorySearch
      ? "ghrc-toolbar ghrc-toolbar-with-search"
      : "ghrc-toolbar";

    if (showRepositoryTotal) {
      const identity = document.createElement("div");
      identity.className = "ghrc-identity";
      identity.append(githubIcon());

      const heading = document.createElement("div");
      const title = document.createElement("h2");
      title.textContent = "Repositories";
      const summary = document.createElement("span");
      summary.textContent = `${repositories.length} ${mode === "authenticated" ? "accessible" : "public"}`;
      heading.append(title, summary);
      identity.append(heading);
      toolbar.append(identity);
    }

    if (mode === "public" && showRepositoryTotal) {
      const actions = document.createElement("div");
      actions.className = "ghrc-actions";
      const notice = document.createElement("span");
      notice.className = "ghrc-public-notice";
      notice.textContent = "Public repositories only";
      actions.append(notice);
      toolbar.append(actions);
    }
    widget.append(toolbar);

    if (showRepositorySearch) {
      const searchArea = document.createElement("div");
      searchArea.className = "ghrc-search-area";

      const searchLabel = document.createElement("label");
      searchLabel.className = "ghrc-search";
      searchLabel.append(githubIcon("ghrc-search-github-icon"));

      const search = document.createElement("input");
      search.type = "search";
      search.placeholder = "Find a repository…";
      search.setAttribute("aria-label", "Find a GitHub repository you have interacted with");
      search.autocomplete = "off";
      search.spellcheck = false;
      searchLabel.append(search);

      const shortcut = document.createElement("kbd");
      shortcut.textContent = "Alt R";
      searchLabel.append(shortcut);

      const results = document.createElement("div");
      results.className = "ghrc-search-results";
      results.hidden = true;
      search.addEventListener("input", () => {
        renderSearchResults(results, searchRepositories, search.value, pinnedRepositories);
      });
      search.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          search.value = "";
          renderSearchResults(results, searchRepositories, "", pinnedRepositories);
          search.blur();
        }
      });
      searchArea.append(searchLabel, results);
      widget.append(searchArea);
    }
  }

  function normalizeWootenLinkText(value) {
    return String(value || "")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[#?&_=/%:+.-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function wootenLinkTopic(href) {
    try {
      const url = new URL(href);
      return normalizeWootenLinkText(
        decodeURIComponent(`${url.hostname} ${url.pathname} ${url.search} ${url.hash}`),
      );
    } catch {
      return normalizeWootenLinkText(href);
    }
  }

  function createWootenLinkEntry(key, href, comment = "") {
    const topic = normalizeWootenLinkText(`${comment} ${wootenLinkTopic(href)}`);
    return {
      key,
      href,
      topic,
      searchText: normalizeWootenLinkText(`${key} ${href} ${topic}`).toLowerCase(),
    };
  }

  function parseWootenLinkEntries(html) {
    const entries = [];
    const redirects = html.match(/<script id="all-redirects">([\s\S]*?)<\/script>/)?.[1] || "";
    const constants = new Map();
    const constantPattern = /const\s+([A-Z0-9_]+)\s*=\s*("(?:\\.|[^"\\])*");/g;
    let constantMatch;
    while ((constantMatch = constantPattern.exec(redirects))) {
      try {
        constants.set(constantMatch[1], JSON.parse(constantMatch[2]));
      } catch {
        // Ignore malformed constants and fall back to their short links.
      }
    }

    const entryPattern = /^\s*("(?:\\.|[^"\\])+")\s*:\s*("(?:\\.|[^"\\])*"|[A-Z0-9_]+)\s*,?\s*(?:\/\/\s*(.*))?$/gm;
    let entryMatch;
    while ((entryMatch = entryPattern.exec(redirects))) {
      try {
        const key = JSON.parse(entryMatch[1]);
        const rawHref = entryMatch[2];
        const href = constants.get(rawHref)
          || (/^"/.test(rawHref) ? JSON.parse(rawHref) : "")
          || `https://wooten.link/${encodeURIComponent(key)}`;
        entries.push(createWootenLinkEntry(key, href, entryMatch[3] || ""));
      } catch {
        // Ignore malformed entries from the public index.
      }
    }

    const lawRedirects = html.match(
      /<script type="text\/plain" id="law-redirects">([\s\S]*?)<\/script>/,
    )?.[1] || "";
    let delimiter = null;
    for (const line of lawRedirects.split(/\r?\n/)) {
      const section = line.match(/^\s*\[redirects\.("(?:\\.|[^"\\])*")\]/);
      if (section) {
        try {
          delimiter = JSON.parse(section[1]);
        } catch {
          delimiter = null;
        }
        continue;
      }
      if (/^\s*\[/.test(line)) {
        delimiter = null;
        continue;
      }
      if (delimiter === null) continue;

      const entry = line.match(/^\s*("(?:\\.|[^"\\])*")\s*=/);
      if (!entry) continue;
      try {
        const hrefMatch = line.match(
          /^\s*("(?:\\.|[^"\\])*")\s*=\s*("(?:\\.|[^"\\])*")/,
        );
        if (!hrefMatch) continue;
        const key = `${delimiter}${JSON.parse(hrefMatch[1])}`.toLowerCase();
        entries.push(createWootenLinkEntry(key, JSON.parse(hrefMatch[2])));
      } catch {
        // Ignore malformed entries from the public law-link index.
      }
    }
    return entries.sort((first, second) => first.key.localeCompare(second.key));
  }

  async function loadWootenLinkEntries() {
    wootenLinkEntriesRequest ||= fetch("https://wooten.link/404.html", {
      cache: "no-store",
    }).then((response) => {
      if (!response.ok) throw new Error("wooten.link index could not be loaded");
      return response.text();
    }).then(parseWootenLinkEntries);

    try {
      return await wootenLinkEntriesRequest;
    } catch {
      wootenLinkEntriesRequest = null;
      return null;
    }
  }

  function matchingWootenLinkEntries(entries, query) {
    const term = query.trim().toLowerCase();
    const normalizedTerm = normalizeWootenLinkText(term).toLowerCase();
    if (!term) return [];

    return entries.filter((entry) => (
      entry.searchText.includes(normalizedTerm)
      || entry.key.toLowerCase().includes(term)
      || entry.href.toLowerCase().includes(term)
    )).sort((first, second) => {
      const firstKey = first.key.toLowerCase();
      const secondKey = second.key.toLowerCase();
      if (firstKey === term && secondKey !== term) return -1;
      if (secondKey === term && firstKey !== term) return 1;
      if (firstKey.startsWith(term) && !secondKey.startsWith(term)) return -1;
      if (secondKey.startsWith(term) && !firstKey.startsWith(term)) return 1;
      return first.key.localeCompare(second.key);
    });
  }

  async function openWootenLink(url) {
    const response = await chrome.runtime.sendMessage({ type: "open-wooten-link", url });
    if (!response?.ok) {
      throw new Error(response?.error || "wooten.link could not be opened");
    }
  }

  function createWootenLinkSearch() {
    const form = document.createElement("form");
    form.className = "ghrc-wooten-link-search";

    const label = document.createElement("label");
    const mark = document.createElement("img");
    mark.className = "ghrc-wooten-link-mark";
    mark.src = chrome.runtime.getURL("artwork/calligraphy-initials.png");
    mark.alt = "wooten.link";
    label.append(mark);

    const input = document.createElement("input");
    input.type = "search";
    input.name = "q";
    input.placeholder = "hrefs";
    input.setAttribute("aria-label", "Search wooten.link references");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", "ghrc-wooten-link-results");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("role", "combobox");
    input.autocomplete = "off";
    label.append(input);

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "ghrc-wooten-link-submit";
    submit.textContent = "Search";

    const results = document.createElement("div");
    results.id = "ghrc-wooten-link-results";
    results.className = "ghrc-wooten-link-results";
    results.setAttribute("role", "listbox");
    results.hidden = true;

    let visibleEntries = [];
    let activeIndex = -1;
    const setActiveEntry = (index) => {
      activeIndex = index;
      [...results.querySelectorAll('[role="option"]')].forEach((option, optionIndex) => {
        const active = optionIndex === activeIndex;
        option.classList.toggle("ghrc-active", active);
        option.setAttribute("aria-selected", String(active));
        if (active) {
          input.setAttribute("aria-activedescendant", option.id);
          option.scrollIntoView({ block: "nearest" });
        }
      });
      if (activeIndex < 0) input.removeAttribute("aria-activedescendant");
    };
    const hideResults = () => {
      results.hidden = true;
      input.setAttribute("aria-expanded", "false");
      setActiveEntry(-1);
    };
    const openEntry = async (entry) => {
      hideResults();
      await openWootenLink(`https://wooten.link/${encodeURIComponent(entry.key)}`);
    };
    const renderResults = async () => {
      const query = input.value;
      if (!query.trim()) {
        hideResults();
        return;
      }

      const entries = await loadWootenLinkEntries();
      if (input.value !== query || !entries) return;
      visibleEntries = matchingWootenLinkEntries(entries, query).slice(0, 8);
      results.replaceChildren();
      setActiveEntry(-1);

      if (!visibleEntries.length) {
        const empty = document.createElement("p");
        empty.className = "ghrc-wooten-link-empty";
        empty.textContent = "No matching references";
        results.append(empty);
      } else {
        visibleEntries.forEach((entry, index) => {
          const option = document.createElement("button");
          option.type = "button";
          option.id = `ghrc-wooten-link-option-${index}`;
          option.setAttribute("role", "option");
          option.setAttribute("aria-selected", "false");

          const key = document.createElement("strong");
          key.textContent = entry.key;
          const href = document.createElement("span");
          href.textContent = entry.href;
          option.append(key, href);
          option.addEventListener("pointermove", () => setActiveEntry(index));
          option.addEventListener("click", () => {
            void context.run(() => openEntry(entry));
          });
          results.append(option);
        });
      }
      results.hidden = false;
      input.setAttribute("aria-expanded", "true");
    };

    input.addEventListener("input", () => {
      void renderResults();
    });
    input.addEventListener("focus", () => {
      if (input.value.trim()) void renderResults();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideResults();
        return;
      }
      if (!visibleEntries.length || results.hidden) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = activeIndex < 0
          ? (direction > 0 ? 0 : visibleEntries.length - 1)
          : (activeIndex + direction + visibleEntries.length) % visibleEntries.length;
        setActiveEntry(nextIndex);
      } else if (event.key === "Enter" && activeIndex >= 0) {
        event.preventDefault();
        void context.run(() => openEntry(visibleEntries[activeIndex]));
      }
    });
    form.addEventListener("focusout", () => {
      requestAnimationFrame(() => {
        if (!form.contains(document.activeElement)) hideResults();
      });
    });

    form.append(label, submit, results);
    void loadWootenLinkEntries();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const query = input.value.trim();
      if (!query) {
        input.focus();
        return;
      }

      const searchUrl = new URL("https://wooten.link/search");
      searchUrl.searchParams.set("q", query);
      const entries = await loadWootenLinkEntries();
      const exactEntry = entries?.find(
        (entry) => entry.key.toLowerCase() === query.toLowerCase(),
      );
      const url = exactEntry
        ? `https://wooten.link/${encodeURIComponent(exactEntry.key)}`
        : searchUrl.toString();
      hideResults();
      await openWootenLink(url);
    });
    return form;
  }

  function createDashboardFooter(pagination = null, showWootenLinkSearch = false) {
    const footer = document.createElement("footer");
    footer.className = "ghrc-dashboard-footer";
    if (showWootenLinkSearch) footer.append(createWootenLinkSearch());
    if (pagination) footer.append(pagination);
    return footer;
  }

  function createPagination(pageCount, onPageChange) {
    const pagination = document.createElement("nav");
    pagination.className = "ghrc-pagination";
    pagination.setAttribute("aria-label", "GitHub account pages");

    const previous = document.createElement("button");
    previous.type = "button";
    previous.setAttribute("aria-label", "Previous page");
    previous.textContent = "←";

    const next = document.createElement("button");
    next.type = "button";
    next.setAttribute("aria-label", "Next page");
    next.textContent = "→";

    let pageIndex = 0;
    const update = () => {
      previous.disabled = pageIndex === 0;
      next.disabled = pageIndex === pageCount - 1;
      pagination.setAttribute(
        "aria-label",
        `GitHub account pages, page ${pageIndex + 1} of ${pageCount}`,
      );
      onPageChange(pageIndex);
    };

    previous.addEventListener("click", () => {
      if (pageIndex === 0) return;
      pageIndex -= 1;
      update();
    });

    next.addEventListener("click", () => {
      if (pageIndex === pageCount - 1) return;
      pageIndex += 1;
      update();
    });

    pagination.append(previous, next);
    update();
    return pagination;
  }

  function renderRepositories(
    widget,
    payload,
    usage,
    pinnedRepositories,
    hiddenOwners,
    ownerGroupsPerPage,
    showRepositorySearch,
    showRepositoryTotal,
    showWootenLinkSearch,
  ) {
    widget.replaceChildren();
    const rankedRepositories = rankRepositories(
      payload.repositories,
      usage,
      pinnedRepositories,
    );
    const rankedSearchRepositories = rankRepositories(
      payload.searchRepositories || payload.repositories,
      usage,
      pinnedRepositories,
    );
    createToolbar(
      widget,
      rankedRepositories,
      rankedSearchRepositories,
      payload.mode,
      pinnedRepositories,
      showRepositorySearch,
      showRepositoryTotal,
    );

    const groups = groupRepositories(
      payload.repositories,
      payload.ownerOrder,
      usage,
      pinnedRepositories,
      hiddenOwners,
    );
    const columns = document.createElement("div");
    columns.className = "ghrc-columns";

    if (!groups.length) {
      const empty = document.createElement("div");
      empty.className = "ghrc-state ghrc-empty";
      const message = document.createElement("span");
      message.textContent = "Add a GitHub token or account to show repositories here.";
      empty.append(message);
      columns.append(empty);
      widget.append(
        columns,
        createDashboardFooter(null, showWootenLinkSearch),
      );
      return;
    }

    const groupsPerPage = normalizedOwnerGroupsPerPage(ownerGroupsPerPage);
    const pageCount = Math.ceil(groups.length / groupsPerPage);
    const renderPage = (pageIndex) => {
      const firstGroup = pageIndex * groupsPerPage;
      const pageGroups = groups.slice(firstGroup, firstGroup + groupsPerPage);
      columns.replaceChildren(
        ...pageGroups.map((group) => createOwnerColumn(group, pinnedRepositories)),
      );
    };

    widget.append(columns);

    let pagination = null;
    if (pageCount > 1) {
      pagination = createPagination(pageCount, renderPage);
    } else {
      renderPage(0);
    }
    widget.append(createDashboardFooter(pagination, showWootenLinkSearch));
  }

  function renderError(widget, message) {
    widget.replaceChildren();
    const state = document.createElement("div");
    state.className = "ghrc-state ghrc-error";

    const title = document.createElement("strong");
    title.textContent = "Repositories could not be loaded";
    const detail = document.createElement("span");
    detail.textContent = message;
    const settings = document.createElement("button");
    settings.type = "button";
    settings.textContent = "Open settings";
    settings.addEventListener("click", () => {
      requestOptionsPage();
    });
    state.append(title, detail, settings);
    widget.append(state);
  }

  function requestRepositories() {
    repositoryRequest ||= chrome.runtime.sendMessage({ type: "load-repositories" });
    return repositoryRequest;
  }

  async function loadRepositories(widget) {
    try {
      const [payload, stored] = await Promise.all([
        requestRepositories(),
        chrome.storage.local.get({
          [USAGE_STORAGE_KEY]: {},
          [PINNED_STORAGE_KEY]: [],
          [HIDDEN_OWNERS_KEY]: [],
          [OWNER_GROUPS_PER_PAGE_KEY]: DEFAULT_OWNER_GROUPS_PER_PAGE,
          [SHOW_REPOSITORY_SEARCH_KEY]: true,
          [SHOW_REPOSITORY_TOTAL_KEY]: true,
          [SHOW_WOOTEN_LINK_SEARCH_KEY]: false,
        }),
      ]);

      if (!context.active()) return;
      if (!payload.ok) {
        throw new Error(payload.error);
      }

      if (widget.isConnected) {
        renderRepositories(
          widget,
          payload,
          stored[USAGE_STORAGE_KEY],
          stored[PINNED_STORAGE_KEY],
          stored[HIDDEN_OWNERS_KEY],
          stored[OWNER_GROUPS_PER_PAGE_KEY],
          Boolean(stored[SHOW_REPOSITORY_SEARCH_KEY]),
          Boolean(stored[SHOW_REPOSITORY_TOTAL_KEY]),
          Boolean(stored[SHOW_WOOTEN_LINK_SEARCH_KEY]),
        );
      }
    } catch (error) {
      if (/extension context invalidated/i.test(error?.message || "") || !context.active()) {
        context.handleError(error);
        return;
      }
      repositoryRequest = null;
      if (widget.isConnected) {
        renderError(widget, error.message);
      }
    }
  }

  function createWidget() {
    const widget = document.createElement("section");
    widget.id = WIDGET_ID;
    widget.setAttribute("aria-label", "GitHub repositories");

    const loading = document.createElement("p");
    loading.className = "ghrc-state";
    loading.textContent = "Loading repositories…";
    widget.append(loading);
    void loadRepositories(widget);
    return widget;
  }

  function mountWidget() {
    if (!context.active()) return;
    const existingWidget = document.getElementById(WIDGET_ID);

    if (!isNewChatPage()) {
      existingWidget?.remove();
      layoutObserver?.disconnect();
      observedLayoutContainer = null;
      // Keep the early homepage layout while React is still adding the composer.
      if (!isDashboardPage()) clearPageAdjustments();
      return;
    }

    const composer = findComposer();
    if (!composer) return;
    applyPageAdjustments(composer);

    if (!isDashboardPage()) {
      existingWidget?.remove();
      layoutObserver?.disconnect();
      observedLayoutContainer = null;
      return;
    }

    if (existingWidget) {
      if (existingWidget.previousElementSibling !== composer) {
        composer.insertAdjacentElement("afterend", existingWidget);
      }
      updateWidgetLayout(existingWidget, composer);
      return;
    }

    const widget = createWidget();
    composer.insertAdjacentElement("afterend", widget);
    updateWidgetLayout(widget, composer);
  }

  function scheduleMount() {
    if (!context.active()) return;
    if (mountScheduled) return;
    mountScheduled = true;

    requestAnimationFrame(() => {
      mountScheduled = false;
      mountWidget();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.altKey && event.key.toLowerCase() === "r") {
      const search = document.querySelector(`#${WIDGET_ID} input[type="search"]`);
      if (search) {
        event.preventDefault();
        search.focus();
      }
    }
  });

  window.addEventListener("resize", scheduleMount);
  window.addEventListener("ghrc:route-change", scheduleMount);
  window.addEventListener("popstate", scheduleMount);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "repository-cache-updated") return false;
    repositoryRequest = null;
    const widget = document.getElementById(WIDGET_ID);
    if (widget?.isConnected) void loadRepositories(widget);
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if (changes.hideDictationButton || changes.compactNewChatHeader) {
      void context.run(loadDisplayPreferences);
    }

    if (
      changes.githubToken
      || changes.githubTokens
      || changes.ownerOrder
      || changes.hiddenOwners
      || changes.ownerGroupsPerPage
      || changes.showRepositorySearch
      || changes.showRepositoryTotal
      || changes.showWootenLinkSearch
    ) {
      repositoryRequest = null;
      document.getElementById(WIDGET_ID)?.remove();
      scheduleMount();
    }

    if (changes.pinnedRepositories) {
      document.getElementById(WIDGET_ID)?.remove();
      scheduleMount();
    }
  });

  // Warm repository data as soon as the content script starts. On a cache hit this
  // resolves while ChatGPT is still building the page, so the dashboard can paint
  // with data on its first mount instead of visibly arriving afterward.
  void requestRepositories().catch(error => {
    repositoryRequest = null;
    if (/extension context invalidated/i.test(error?.message || "") || !context.active()) context.handleError(error);
  });

  void context.run(loadDisplayPreferences);
  scheduleMount();
  const observer = new MutationObserver(scheduleMount);
  context.onStop(() => {
    observer.disconnect();
    layoutObserver?.disconnect();
    window.removeEventListener("resize", scheduleMount);
    window.removeEventListener("ghrc:route-change", scheduleMount);
    window.removeEventListener("popstate", scheduleMount);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [COMPOSER_READY_ATTR],
  });
})();
