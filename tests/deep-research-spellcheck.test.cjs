const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const worker = fs.readFileSync(path.join(__dirname, "../js/research/deep-research-spellcheck-background.js"), "utf8");
const content = fs.readFileSync(path.join(__dirname, "../js/research/deep-research-spellcheck.js"), "utf8");

function fixture({ supported = true, existingSplit = false, applyResult = { ok: true } } = {}) {
  const store = {};
  const calls = [];
  let listener;
  let removed;
  let nextTabId = 20;
  const tabs = {
    10: { id: 10, index: 1, windowId: 1, pinned: false, splitViewId: existingSplit ? 7 : -1, url: "https://chatgpt.com/" },
  };
  const chrome = {
    runtime: { id: "fixture", onMessage: { addListener(fn) { listener = fn; } } },
    storage: { session: {
      get: async key => ({ [key]: store[key] }),
      set: async values => { Object.assign(store, values); },
      remove: async keys => { for (const key of [keys].flat()) delete store[key]; },
    } },
    tabs: {
      get: async id => {
        if (!tabs[id]) throw new Error("Tab closed");
        return tabs[id];
      },
      create: async details => {
        calls.push(["create", details]);
        const tab = { ...details, id: nextTabId++, splitViewId: -1 };
        tabs[tab.id] = tab;
        return tab;
      },
      createSplit: supported ? async ids => {
        calls.push(["split", [...ids]]);
        for (const id of ids) tabs[id].splitViewId = 5;
      } : undefined,
      update: async (id, details) => {
        calls.push(["update", id, details]);
        Object.assign(tabs[id], details);
      },
      remove: async id => { calls.push(["remove", id]); delete tabs[id]; },
      sendMessage: async (id, message) => {
        calls.push(["sendMessage", id, message]);
        return applyResult;
      },
      onRemoved: { addListener(fn) { removed = fn; } },
    },
  };
  vm.runInNewContext(worker, { chrome, TextEncoder, URL, crypto: { randomUUID: () => "job-one" } });
  function message(type, data = {}, id = 10, url = "https://chatgpt.com/") {
    return new Promise(resolve => listener(
      { type, ...data }, { id: "fixture", frameId: 0, tab: { id }, url }, resolve));
  }
  return { store, calls, tabs, message, removeTab: removed };
}

test("intercepts a new research prompt and opens exactly one temporary split", async () => {
  const f = fixture();
  const begun = await f.message("ghrc-research-spellcheck-begin", { prompt: "Reserch thsi" });
  assert.equal(begun.ok, true);
  assert.deepEqual(f.calls.find(call => call[0] === "split")[1], [10, 20]);
  assert.deepEqual(f.calls.find(call => call[0] === "update")[2],
    { url: "https://chatgpt.com/", active: true });
  const second = await f.message("ghrc-research-spellcheck-begin", { prompt: "Other" });
  assert.equal(second.ok, false);
  const claimed = await f.message("ghrc-research-spellcheck-claim", {}, 20);
  assert.equal(claimed.job.prompt, "Reserch thsi");
  const repeated = await f.message("ghrc-research-spellcheck-claim", {}, 20);
  assert.equal(repeated.job, null);
  const result = await f.message("ghrc-research-spellcheck-finish",
    { id: "job-one", corrected: "Research this" }, 20);
  assert.equal(result.ok, true);
  const delivery = f.calls.find(call => call[0] === "sendMessage");
  assert.equal(delivery[1], 10);
  assert.equal(delivery[2].corrected, "Research this");
  assert.equal(delivery[2].original, "Reserch thsi");
  assert.ok(f.calls.some(call => call[0] === "remove" && call[1] === 20));
  assert.equal(Object.keys(f.store).length, 0);
});

test("rejects unavailable split view and preserves the original draft", async () => {
  for (const options of [{ supported: false }, { existingSplit: true }]) {
    const f = fixture(options);
    const response = await f.message("ghrc-research-spellcheck-begin", { prompt: "Keep me" });
    assert.equal(response.ok, false);
    assert.equal(f.calls.some(call => call[0] === "create"), false);
  }
});

test("rejects foreign pages and invalid prompts without launching a tab", async () => {
  const f = fixture();
  const foreign = await f.message("ghrc-research-spellcheck-begin", { prompt: "Research" }, 10, "https://example.com/");
  assert.equal(foreign.ok, false);
  const empty = await f.message("ghrc-research-spellcheck-begin", { prompt: " " });
  assert.equal(empty.ok, false);
  assert.equal(f.calls.length, 0);
});

test("failed source validation leaves the child pane available for manual recovery", async () => {
  const f = fixture({ applyResult: { ok: false, error: "Changed draft" } });
  await f.message("ghrc-research-spellcheck-begin", { prompt: "Original" });
  await f.message("ghrc-research-spellcheck-claim", {}, 20);
  const result = await f.message("ghrc-research-spellcheck-finish",
    { id: "job-one", corrected: "Edited" }, 20);
  assert.equal(result.ok, false);
  assert.equal(f.tabs[20].url, "https://chatgpt.com/");
  assert.equal(f.calls.some(call => call[0] === "remove"), false);
});

test("unusable corrections never reach the original composer", async () => {
  const f = fixture();
  await f.message("ghrc-research-spellcheck-begin", { prompt: "Original" });
  await f.message("ghrc-research-spellcheck-claim", {}, 20);
  const result = await f.message("ghrc-research-spellcheck-finish",
    { id: "job-one", corrected: " " }, 20);
  assert.equal(result.ok, false);
  assert.equal(f.calls.some(call => call[0] === "sendMessage"), false);
});

test("closing the temporary pane never submits the research prompt", async () => {
  const f = fixture();
  await f.message("ghrc-research-spellcheck-begin", { prompt: "Keep this draft" });
  f.removeTab(20);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.find(call => call[0] === "sendMessage")[2].type,
    "ghrc-research-spellcheck-failed");
  assert.equal(Object.keys(f.store).length, 0);
});

test("composer interception is gated on a real Deep Research mention and approved Go", () => {
  assert.match(content, /app:\/\/connector_openai_deep_research/);
  assert.match(content, /event\.preventDefault\(\)/);
  assert.match(content, /event\.stopImmediatePropagation\(\)/);
  assert.match(content, /prompt === approvedText/);
  assert.match(content, /Review the corrected prompt and press Go/);
  assert.match(content, /The research prompt changed while spellchecking/);
});
test("the Research setting defaults on, persists, and gates composer interception", () => {
  const html = fs.readFileSync(path.join(__dirname, "../options.html"), "utf8");
  const settings = fs.readFileSync(path.join(__dirname, "../js/settings/options.js"), "utf8");
  assert.match(html, /id="deep-research-spellcheck-enabled" type="checkbox" checked/);
  assert.match(settings, /deepResearchSpellcheckEnabled: true/);
  assert.match(settings, /deepResearchSpellcheckEnabled: deepResearchSpellcheckEnabledInput.checked/);
  assert.match(content, /if \(!spellcheckEnabled \|\| !event.isTrusted \|\| !chatIsNew\(\)\) return/);
  assert.match(content, /chrome.storage.onChanged\?\.addListener\(settingsChanged\)/);
  assert.match(content, /if \(!spellcheckEnabled \|\| !chatIsNew\(\) \|\| !input \|\| draft\(input\) !== original\)/);
});
