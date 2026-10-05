const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", "js", file), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ get, set, bridgeError, delayedBridge = false } = {}) {
  const timers = new Map();
  const listeners = new Map();
  const storageListeners = new Set();
  const stored = { webCommitGuidance: "Remote", webCommitGuidanceLastSynced: "Remote" };
  const calls = [];
  const warnings = [];
  let timerId = 0;
  const window = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    postMessage(message) {
      calls.push(message.action);
      if (delayedBridge === true || delayedBridge === message.action) return;
      queueMicrotask(() => {
        for (const fn of listeners.get("message") || []) fn({ source: window, data: {
          ...message, direction: "response", ok: !bridgeError,
          error: bridgeError, guidance: "Remote", accountId: "account",
        } });
      });
    },
  };
  const chrome = {
    runtime: { id: "fixture" },
    storage: {
      local: {
        async get(defaults) { calls.push("get"); return get ? get(defaults) : { ...defaults, ...stored }; },
        async set(values) { calls.push("set"); if (set) await set(values); Object.assign(stored, values); },
      },
      onChanged: {
        addListener(fn) { storageListeners.add(fn); },
        removeListener(fn) { storageListeners.delete(fn); },
      },
    },
  };
  const sandbox = vm.createContext({
    chrome, window, document: { ...window, visibilityState: "visible" },
    location: { origin: "https://chatgpt.com" },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    console: { warn(...args) { warnings.push(args); } },
  });
  vm.runInContext(read("extension-context.js"), sandbox);
  vm.runInContext(read("web-commit-guidance-sync.js"), sandbox);
  return { sandbox, chrome, stored, calls, warnings, timers, listeners, storageListeners };
}

function assertStopped(state) {
  assert.equal(state.sandbox.__ghrcExtensionContext.active(), false);
  assert.equal(state.timers.size, 0);
  assert.equal(state.storageListeners.size, 0);
  for (const listeners of state.listeners.values()) assert.equal(listeners.size, 0);
  assert.deepEqual(state.warnings, []);
}

test("normal guidance sync still records success", async () => {
  const state = fixture();
  await flush();
  assert.equal(state.stored.webCommitGuidanceSyncStatus.state, "success");
  assert.equal(state.stored.webCommitGuidanceAccountId, "account");
});

test("a pending storage request rejected during reload stops sync without retrying status", async () => {
  let rejectGet;
  const state = fixture({ get: () => new Promise((resolve, reject) => { rejectGet = reject; }) });
  await flush();
  state.chrome.runtime = undefined;
  rejectGet(new Error("Extension context invalidated."));
  await flush();
  assertStopped(state);
  assert.equal(state.calls.filter((call) => call === "set").length, 0);
});

test("invalidation while saving an error status is caught", async () => {
  const state = fixture({
    bridgeError: "Personalization unavailable",
    set: async () => { throw new Error("Extension context invalidated."); },
  });
  await flush();
  assertStopped(state);
  assert.equal(state.calls.filter((call) => call === "set").length, 1);
});

test("reload cancels an outstanding bridge and prevents future polling", async () => {
  const state = fixture({ delayedBridge: true });
  state.chrome.runtime = undefined;
  state.sandbox.__ghrcExtensionContext.active();
  await flush();
  assertStopped(state);
  assert.deepEqual(state.calls, ["get"]);
});

test("reload cancels a pending push without writing guidance or status", async () => {
  const state = fixture({
    get: () => ({ webCommitGuidance: "Local", webCommitGuidanceLastSynced: "Remote" }),
    delayedBridge: "set",
  });
  await flush();
  assert.deepEqual(state.calls, ["get", "get", "set"]);
  state.chrome.runtime = undefined;
  state.sandbox.__ghrcExtensionContext.active();
  await flush();
  assertStopped(state);
  assert.equal(state.stored.webCommitGuidance, "Remote");
  assert.equal(state.stored.webCommitGuidanceSyncStatus, undefined);
});

test("a storage read resolving after reload does not start a write", async () => {
  let resolveGet;
  const state = fixture({ get: () => new Promise((resolve) => { resolveGet = resolve; }) });
  await flush();
  state.chrome.runtime = undefined;
  state.sandbox.__ghrcExtensionContext.active();
  resolveGet({ webCommitGuidance: null });
  await flush();
  assertStopped(state);
  assert.deepEqual(state.calls, ["get", "get"]);
});

test("ordinary bridge failures still record an error and allow polling", async () => {
  const state = fixture({ bridgeError: "Personalization unavailable" });
  await flush();
  assert.equal(state.stored.webCommitGuidanceSyncStatus.state, "error");
  assert.match(state.stored.webCommitGuidanceSyncStatus.message, /Personalization unavailable/);
  assert.equal(state.sandbox.__ghrcExtensionContext.active(), true);
  assert.equal(state.timers.size, 1);
});
