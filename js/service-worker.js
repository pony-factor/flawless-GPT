importScripts("token-vault.js");

const DEFAULT_OWNER_ORDER = [];
const REPOSITORIES_PER_PAGE = 100;
const REPOSITORY_CACHE_KEY = "repositoryPayloadCacheV3";
const REPOSITORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const WOOTEN_LINK_TAB_ID_KEY = "wootenLinkSearchTabId";
const ownerProfileCache = new Map();
const repositoryRefreshRequests = new Map();
let repositoryLoadRequest = null;

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function fetchGitHub(url, token) {
  const response = await fetch(url, { headers: githubHeaders(token) });

  if (!response.ok) {
    let detail = "";

    try {
      const payload = await response.json();
      detail = payload.message ? `: ${payload.message}` : "";
    } catch {
      // GitHub occasionally returns an empty body for network-level errors.
    }

    if (response.status === 401) {
      throw new Error(`GitHub rejected the saved token${detail}`);
    }

    if (response.status === 403) {
      throw new Error(`GitHub API access is unavailable or rate-limited${detail}`);
    }

    throw new Error(`GitHub returned ${response.status}${detail}`);
  }

  return response.json();
}

function normalizeRepository(repository, ownerProfiles) {
  const ownerProfile = ownerProfiles.get(repository.owner.login.toLowerCase());

  return {
    id: repository.id,
    name: repository.name,
    fullName: repository.full_name,
    url: repository.html_url,
    description: repository.description || "",
    isPrivate: Boolean(repository.private),
    isFork: Boolean(repository.fork),
    isArchived: Boolean(repository.archived),
    pushedAt: repository.pushed_at || repository.updated_at,
    updatedAt: repository.updated_at,
    language: repository.language || "",
    stars: repository.stargazers_count || 0,
    owner: {
      login: repository.owner.login,
      displayName: ownerProfile?.displayName || repository.owner.login,
      avatarUrl: repository.owner.avatar_url,
      type: repository.owner.type,
    },
  };
}

function loadOwnerProfile(login, token) {
  const key = login.toLowerCase();
  if (ownerProfileCache.has(key)) return ownerProfileCache.get(key);

  const profileRequest = fetchGitHub(
    `https://api.github.com/users/${encodeURIComponent(login)}`,
    token,
  )
    .then((profile) => ({
      displayName: profile.name?.trim() || profile.login || login,
    }))
    .catch(() => ({ displayName: login }));

  ownerProfileCache.set(key, profileRequest);
  return profileRequest;
}

async function loadOwnerProfiles(repositories, token = "") {
  const owners = new Map();

  for (const repository of repositories) {
    const login = repository.owner.login;
    owners.set(login.toLowerCase(), login);
  }

  const profiles = await Promise.all(
    [...owners].map(async ([key, login]) => [key, await loadOwnerProfile(login, token)]),
  );
  return new Map(profiles);
}

async function loadAccessibleRepositories(token, { allPages = true } = {}) {
  const repositories = [];

  for (let page = 1; ; page += 1) {
    const url = new URL("https://api.github.com/user/repos");
    url.searchParams.set("affiliation", "owner,collaborator,organization_member");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(REPOSITORIES_PER_PAGE));
    url.searchParams.set("sort", "updated");

    const batch = await fetchGitHub(url.toString(), token);
    repositories.push(...batch);

    if (!allPages || batch.length < REPOSITORIES_PER_PAGE) {
      break;
    }
  }

  return repositories;
}

function repositoryNameFromApiUrl(repositoryUrl) {
  try {
    const url = new URL(repositoryUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      url.origin !== "https://api.github.com"
      || parts.length !== 3
      || parts[0] !== "repos"
    ) {
      return "";
    }
    return `${parts[1]}/${parts[2]}`;
  } catch {
    return "";
  }
}

async function loadInteractedRepositories(
  token,
  knownRepositories = [],
  { allPages = true } = {},
) {
  const viewer = await fetchGitHub("https://api.github.com/user", token);
  if (!viewer?.login) return [];

  const knownNames = new Set(
    knownRepositories
      .map((repository) => repository.full_name?.toLowerCase())
      .filter(Boolean),
  );
  const repositoryUrls = new Map();
  const pageLimit = allPages ? 10 : 1;

  // GitHub App user tokens require an explicit issue type. Search both types
  // independently so issue comments and pull request activity are included.
  for (const type of ["issue", "pull-request"]) {
    for (let page = 1; page <= pageLimit; page += 1) {
      const url = new URL("https://api.github.com/search/issues");
      url.searchParams.set("q", `involves:${viewer.login} is:${type}`);
      url.searchParams.set("sort", "updated");
      url.searchParams.set("order", "desc");
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", String(REPOSITORIES_PER_PAGE));

      const payload = await fetchGitHub(url.toString(), token);
      const items = Array.isArray(payload.items) ? payload.items : [];

      for (const item of items) {
        const fullName = repositoryNameFromApiUrl(item.repository_url);
        const key = fullName.toLowerCase();
        if (!fullName || knownNames.has(key) || repositoryUrls.has(key)) continue;
        repositoryUrls.set(key, item.repository_url);
      }

      const searchableTotal = Math.min(Number(payload.total_count) || 0, 1000);
      if (
        !allPages
        || items.length < REPOSITORIES_PER_PAGE
        || page * REPOSITORIES_PER_PAGE >= searchableTotal
      ) {
        break;
      }
    }
  }

  const results = await Promise.allSettled(
    [...repositoryUrls.values()].map((url) => fetchGitHub(url, token)),
  );
  return results
    .filter((result) => result.status === "fulfilled" && result.value?.full_name)
    .map((result) => result.value);
}

async function loadPublicOwnerRepositories(owner, token, { allPages = true } = {}) {
  const repositories = [];

  for (let page = 1; ; page += 1) {
    const url = new URL(`https://api.github.com/users/${encodeURIComponent(owner)}/repos`);
    url.searchParams.set("direction", "desc");
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(REPOSITORIES_PER_PAGE));
    url.searchParams.set("sort", "updated");

    const batch = await fetchGitHub(url.toString(), token);
    repositories.push(...batch);

    if (!allPages || batch.length < REPOSITORIES_PER_PAGE) {
      break;
    }
  }

  return repositories;
}

async function loadPublicRepositories(ownerOrder, token = "", { allPages = true } = {}) {
  const ownerRepositories = await Promise.all(
    ownerOrder.map((owner) => loadPublicOwnerRepositories(owner, token, { allPages })),
  );
  return ownerRepositories.flat();
}

function uniqueRepositories(repositories) {
  const seenRepositories = new Set();
  return repositories.filter((repository) => {
    const key = repository.full_name.toLowerCase();
    if (seenRepositories.has(key)) return false;
    seenRepositories.add(key);
    return true;
  });
}

function normalizedOwnerOrder(owners) {
  const resolved = [];
  const seenOwners = new Set();

  for (const owner of Array.isArray(owners) ? owners : []) {
    if (typeof owner !== "string" || !owner.trim()) continue;
    const login = owner.trim();
    const key = login.toLowerCase();
    if (seenOwners.has(key)) continue;
    seenOwners.add(key);
    resolved.push(login);
  }

  return resolved;
}

function resolvedOwnerOrder(repositories, configuredOrder) {
  const resolved = normalizedOwnerOrder(configuredOrder);
  const seenOwners = new Set(resolved.map((owner) => owner.toLowerCase()));
  const activeRepositories = [...repositories].sort((first, second) => {
    const firstUpdated = new Date(first.pushed_at || first.updated_at || 0).getTime();
    const secondUpdated = new Date(second.pushed_at || second.updated_at || 0).getTime();
    return secondUpdated - firstUpdated;
  });

  for (const repository of activeRepositories) {
    const login = repository.owner.login;
    const key = login.toLowerCase();
    if (seenOwners.has(key)) continue;
    seenOwners.add(key);
    resolved.push(login);
  }

  return resolved;
}

function sameOwnerOrder(first, second) {
  if (first.length !== second.length) return false;
  return first.every((owner, index) => (
    owner.toLowerCase() === second[index].toLowerCase()
  ));
}

async function persistResolvedOwnerOrder(configuredOrder, resolvedOrder) {
  if (sameOwnerOrder(configuredOrder, resolvedOrder)) {
    return { ownerOrder: resolvedOrder, stateChanged: false };
  }

  const currentSettings = await chrome.storage.local.get({
    ownerOrder: DEFAULT_OWNER_ORDER,
  });
  const currentOrder = normalizedOwnerOrder(currentSettings.ownerOrder);

  // Do not overwrite an owner-order edit made while repository discovery was running.
  if (!sameOwnerOrder(currentOrder, configuredOrder)) {
    return { ownerOrder: currentOrder, stateChanged: true };
  }

  await chrome.storage.local.set({ ownerOrder: resolvedOrder });
  return { ownerOrder: resolvedOrder, stateChanged: false };
}

async function tokenSignature(tokens) {
  const serialized = JSON.stringify(
    tokens.map(({ label, token, cacheKey }) => [label || "", cacheKey || token]),
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function loadRepositoryState({ refreshTokens = true } = {}) {
  const [settings, tokens] = await Promise.all([
    chrome.storage.local.get({ ownerOrder: DEFAULT_OWNER_ORDER }),
    TokenVault.loadTokens({ refresh: refreshTokens }),
  ]);

  return {
    ownerOrder: normalizedOwnerOrder(settings.ownerOrder),
    tokens,
    tokenSignature: await tokenSignature(tokens),
  };
}

function cacheMatchesState(cache, state) {
  if (!cache?.payload || !Number.isFinite(cache.fetchedAt)) return false;
  if (cache.tokenSignature !== state.tokenSignature) return false;
  return sameOwnerOrder(normalizedOwnerOrder(cache.ownerOrder), state.ownerOrder);
}

function repositoryStateKey(state) {
  return JSON.stringify([
    state.tokenSignature,
    state.ownerOrder.map((owner) => owner.toLowerCase()),
  ]);
}

async function loadRepositoryCache(state) {
  const stored = await chrome.storage.local.get({ [REPOSITORY_CACHE_KEY]: null });
  const cache = stored[REPOSITORY_CACHE_KEY];
  return cacheMatchesState(cache, state) ? cache : null;
}

async function saveRepositoryCache(payload, state, { complete = true } = {}) {
  await chrome.storage.local.set({
    [REPOSITORY_CACHE_KEY]: {
      fetchedAt: Date.now(),
      tokenSignature: state.tokenSignature,
      ownerOrder: normalizedOwnerOrder(payload.ownerOrder),
      complete,
      payload,
    },
  });
}

async function repositoryPayload(state = null, { complete = true } = {}) {
  const resolvedState = state || await loadRepositoryState();
  const { ownerOrder, tokens } = resolvedState;
  let repositories;
  let searchRepositories;

  if (tokens.length) {
    const authenticatedRepositories = await Promise.all(
      tokens.map(async ({ label, token }, index) => {
        try {
          return await loadAccessibleRepositories(token, { allPages: complete });
        } catch (error) {
          throw new Error(`${label || `Token ${index + 1}`}: ${error.message}`);
        }
      }),
    );
    repositories = uniqueRepositories(authenticatedRepositories.flat());

    // A cold first paint only needs the first authenticated page. Additional
    // configured owners and interaction history are folded in by the complete
    // background refresh.
    if (complete) {
      const accessibleOwners = new Set(
        repositories.map((repository) => repository.owner.login.toLowerCase()),
      );
      const missingPriorityOwners = ownerOrder.filter(
        (owner) => !accessibleOwners.has(owner.toLowerCase()),
      );
      const priorityRepositories = await loadPublicRepositories(missingPriorityOwners);
      repositories.push(...priorityRepositories);
      repositories = uniqueRepositories(repositories);
    }

    searchRepositories = repositories;
    if (complete) {
      const interactedRepositories = await Promise.all(
        tokens.map(async ({ label, token }, index) => {
          try {
            return await loadInteractedRepositories(token, repositories);
          } catch (error) {
            console.warn(
              `${label || `Token ${index + 1}`}: could not load interacted repositories:`,
              error,
            );
            return [];
          }
        }),
      );
      searchRepositories = uniqueRepositories([
        ...repositories,
        ...interactedRepositories.flat(),
      ]);
    }
  } else {
    repositories = await loadPublicRepositories(ownerOrder, "", { allPages: complete });
    searchRepositories = repositories;
  }

  const ownerProfiles = complete
    ? await loadOwnerProfiles(repositories, tokens[0]?.token)
    : new Map();
  const resolvedOrder = resolvedOwnerOrder(repositories, ownerOrder);
  const resolvedOwnerState = complete
    ? await persistResolvedOwnerOrder(ownerOrder, resolvedOrder)
    : { ownerOrder, stateChanged: false };
  const normalizedRepositories = repositories.map((repository) => (
    normalizeRepository(repository, ownerProfiles)
  ));
  const normalizedSearchRepositories = searchRepositories === repositories
    ? normalizedRepositories
    : searchRepositories.map((repository) => (
      normalizeRepository(repository, ownerProfiles)
    ));

  return {
    payload: {
      mode: tokens.length ? "authenticated" : "public",
      ownerOrder: resolvedOwnerState.ownerOrder,
      repositories: normalizedRepositories,
      searchRepositories: normalizedSearchRepositories,
    },
    stateChanged: resolvedOwnerState.stateChanged,
  };
}

async function notifyRepositoryCacheUpdated() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(
      tabs
        .filter((tab) => Number.isInteger(tab.id))
        .map((tab) => chrome.tabs.sendMessage(tab.id, { type: "repository-cache-updated" })),
    );
  } catch (error) {
    console.warn("Could not notify tabs about refreshed repository data:", error);
  }
}

async function refreshRepositoryCache(state) {
  const key = repositoryStateKey(state);
  if (repositoryRefreshRequests.has(key)) return repositoryRefreshRequests.get(key);

  const request = (async () => {
    const refreshedState = await loadRepositoryState({ refreshTokens: true });
    const { payload, stateChanged } = await repositoryPayload(
      refreshedState,
      { complete: true },
    );
    const currentState = await loadRepositoryState({ refreshTokens: false });
    const stillCurrent = !stateChanged
      && currentState.tokenSignature === refreshedState.tokenSignature
      && sameOwnerOrder(currentState.ownerOrder, payload.ownerOrder);
    if (stillCurrent) {
      await saveRepositoryCache(payload, refreshedState, { complete: true });
      await notifyRepositoryCacheUpdated();
    }
    return payload;
  })().finally(() => {
    repositoryRefreshRequests.delete(key);
  });

  repositoryRefreshRequests.set(key, request);
  return request;
}

async function loadInitialRepositoryPayload(state) {
  try {
    const { payload } = await repositoryPayload(state, { complete: false });
    return { payload, state };
  } catch (error) {
    if (!state.tokens.some(({ refreshable }) => refreshable)) throw error;
    const refreshedState = await loadRepositoryState({ refreshTokens: true });
    const { payload } = await repositoryPayload(refreshedState, { complete: false });
    return { payload, state: refreshedState };
  }
}

async function loadRepositoriesWithCache() {
  // Cache validation deliberately uses the currently stored credential without
  // refreshing it. GitHub App refresh can happen after cached data is visible.
  const state = await loadRepositoryState({ refreshTokens: false });
  const cache = await loadRepositoryCache(state);

  if (cache) {
    const age = Math.max(0, Date.now() - cache.fetchedAt);
    const incomplete = cache.complete === false;
    const refreshing = incomplete || age > REPOSITORY_CACHE_TTL_MS;
    if (refreshing) {
      void refreshRepositoryCache(state).catch((error) => {
        console.warn("Repository cache refresh failed:", error);
      });
    }

    return {
      ok: true,
      ...cache.payload,
      cached: true,
      cacheAgeMs: age,
      refreshing,
      partial: incomplete,
    };
  }

  const initial = await loadInitialRepositoryPayload(state);
  await saveRepositoryCache(initial.payload, initial.state, { complete: false });
  void refreshRepositoryCache(initial.state).catch((error) => {
    console.warn("Repository cache refresh failed:", error);
  });

  return {
    ok: true,
    ...initial.payload,
    cached: false,
    cacheAgeMs: 0,
    refreshing: true,
    partial: true,
  };
}

function requestRepositoryPayload() {
  repositoryLoadRequest ||= loadRepositoriesWithCache()
    .finally(() => {
      repositoryLoadRequest = null;
    });
  return repositoryLoadRequest;
}

async function openWootenLink(urlValue) {
  const url = new URL(urlValue);
  if (url.origin !== "https://wooten.link") {
    throw new Error("Only wooten.link URLs can be opened in the reference tab");
  }

  const stored = await chrome.storage.session.get({ [WOOTEN_LINK_TAB_ID_KEY]: null });
  const existingTabId = stored[WOOTEN_LINK_TAB_ID_KEY];
  if (Number.isInteger(existingTabId)) {
    try {
      await chrome.tabs.update(existingTabId, { active: true, url: url.toString() });
      return;
    } catch {
      await chrome.storage.session.remove(WOOTEN_LINK_TAB_ID_KEY);
    }
  }

  const tab = await chrome.tabs.create({ active: true, url: url.toString() });
  if (Number.isInteger(tab.id)) {
    await chrome.storage.session.set({ [WOOTEN_LINK_TAB_ID_KEY]: tab.id });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "load-repositories") {
    requestRepositoryPayload()
      .then((payload) => sendResponse(payload))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "preload-repositories") {
    requestRepositoryPayload()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "open-options") {
    (async () => {
      if (message.connectGithub) {
        await chrome.storage.local.set({ githubAppConnectRequested: true });
        await chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
      } else {
        await chrome.runtime.openOptionsPage();
      }
    })()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, error: "Could not open GitHub settings." }));
    return true;
  }

  if (message?.type === "open-wooten-link") {
    openWootenLink(message.url)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.runtime.openOptionsPage();
  }

  // Updating from a plaintext-storage version migrates saved tokens immediately.
  if (reason === "update") {
    void TokenVault.loadTokens().catch((error) => {
      console.warn("GitHub token migration failed:", error);
    });
  }
});

// Also migrate on worker startup so an interrupted update migration is retried.
void TokenVault.loadTokens().catch((error) => {
  console.warn("GitHub token vault initialization failed:", error);
});
