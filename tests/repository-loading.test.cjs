const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash, webcrypto } = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");

function tokenSignature(tokens) {
  return createHash("sha256")
    .update(JSON.stringify(tokens.map(({ label, token, cacheKey }) => [
      label || "",
      cacheKey || token,
    ])))
    .digest("hex");
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function makeRepository(index) {
  return {
    id: index + 1,
    name: `repo-${index + 1}`,
    full_name: `octo/repo-${index + 1}`,
    html_url: `https://github.com/octo/repo-${index + 1}`,
    description: "",
    private: false,
    fork: false,
    archived: false,
    pushed_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    language: "JavaScript",
    stargazers_count: 0,
    owner: {
      login: "octo",
      avatar_url: "https://avatars.githubusercontent.com/u/1",
      type: "User",
    },
  };
}

function createWorker({ storage = {}, loadTokens, fetchImpl }) {
  const source = fs.readFileSync(require.resolve("../js/service-worker.js"), "utf8");
  const local = { ...storage };
  const tokenCalls = [];
  let messageListener = null;
  const chrome = {
    storage: {
      local: {
        get: async (defaults = {}) => {
          const values = { ...defaults };
          for (const key of Object.keys(defaults)) {
            if (Object.prototype.hasOwnProperty.call(local, key)) values[key] = local[key];
          }
          return values;
        },
        set: async (values) => Object.assign(local, values),
      },
      session: {
        get: async (defaults = {}) => ({ ...defaults }),
        set: async () => {},
        remove: async () => {},
      },
    },
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } },
      onInstalled: { addListener() {} },
      openOptionsPage: async () => {},
      getURL: (path) => `chrome-extension://test/${path}`,
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => {},
      create: async () => ({ id: 1 }),
      update: async () => ({}),
    },
  };
  const context = {
    chrome,
    console,
    crypto: webcrypto,
    fetch: fetchImpl,
    importScripts() {},
    TextEncoder,
    URL,
    TokenVault: {
      async loadTokens(options = {}) {
        tokenCalls.push(options);
        return loadTokens(options);
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  // Ignore the service worker's intentional startup token-migration read.
  tokenCalls.length = 0;

  async function send(message) {
    return new Promise((resolve, reject) => {
      if (!messageListener) {
        reject(new Error("service worker message listener was not registered"));
        return;
      }
      const handled = messageListener(message, {}, resolve);
      if (!handled) resolve(undefined);
    });
  }

  return { local, send, tokenCalls };
}

test("repository cache hits do not refresh GitHub App credentials or depend on the access token", async () => {
  const cacheKey = "github-app:stable-session";
  const oldToken = {
    label: "GitHub App",
    token: "old-access-token",
    cacheKey,
    refreshable: true,
  };
  let networkCalls = 0;
  const worker = createWorker({
    storage: {
      ownerOrder: [],
      repositoryPayloadCacheV1: {
        fetchedAt: Date.now(),
        tokenSignature: tokenSignature([oldToken]),
        ownerOrder: [],
        complete: true,
        payload: {
          mode: "authenticated",
          ownerOrder: [],
          repositories: [{
            id: 1,
            name: "cached",
            fullName: "octo/cached",
            url: "https://github.com/octo/cached",
            description: "",
            isPrivate: false,
            isFork: false,
            isArchived: false,
            pushedAt: "2026-10-01T00:00:00Z",
            updatedAt: "2026-10-01T00:00:00Z",
            language: "JavaScript",
            stars: 0,
            owner: {
              login: "octo",
              displayName: "Octo",
              avatarUrl: "",
              type: "User",
            },
          }],
        },
      },
    },
    loadTokens: ({ refresh }) => [{
      ...oldToken,
      token: refresh === false ? "rotated-access-token" : "refreshed-access-token",
    }],
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error("cache hit should not fetch GitHub");
    },
  });

  const payload = await worker.send({ type: "load-repositories" });
  assert.equal(payload.ok, true);
  assert.equal(payload.cached, true);
  assert.equal(payload.repositories[0].fullName, "octo/cached");
  assert.deepEqual(worker.tokenCalls.map(({ refresh }) => refresh), [false]);
  assert.equal(networkCalls, 0);
});

test("cold repository loads return a first-page payload while the complete refresh is still paging", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => makeRepository(index));
  let releaseSecondPage;
  const secondPageGate = new Promise((resolve) => {
    releaseSecondPage = resolve;
  });
  let repoPageCalls = 0;

  const worker = createWorker({
    storage: { ownerOrder: [] },
    loadTokens: async () => [{
      label: "GitHub App",
      token: "access-token",
      cacheKey: "github-app:stable-session",
      refreshable: true,
    }],
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/user/repos") {
        repoPageCalls += 1;
        const page = Number(parsed.searchParams.get("page"));
        if (repoPageCalls === 1) return jsonResponse(firstPage);
        if (page === 1) return jsonResponse(firstPage);
        await secondPageGate;
        return jsonResponse([]);
      }
      if (parsed.pathname === "/users/octo") {
        return jsonResponse({ login: "octo", name: "Octo" });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    },
  });

  const payload = await worker.send({ type: "load-repositories" });
  assert.equal(payload.ok, true);
  assert.equal(payload.cached, false);
  assert.equal(payload.partial, true);
  assert.equal(payload.refreshing, true);
  assert.equal(payload.repositories.length, 100);
  assert.equal(payload.repositories[0].owner.displayName, "octo");
  assert.equal(payload.ownerOrder.length, 0);

  const cachedPartial = await worker.send({ type: "load-repositories" });
  assert.equal(cachedPartial.cached, true);
  assert.equal(cachedPartial.partial, true);

  releaseSecondPage();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(worker.local.repositoryPayloadCacheV1.complete, true);
  assert.equal(worker.local.repositoryPayloadCacheV1.payload.repositories[0].owner.displayName, "Octo");
});
