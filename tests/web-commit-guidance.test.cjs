const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "js", "web-commit-guidance.js"),
  "utf8",
);

function element() {
  const listeners = new Map();
  return {
    value: "",
    textContent: "",
    dataset: {},
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
  };
}

async function fixture(initial = {}) {
  const textarea = element();
  const status = element();
  const storage = { ...initial };
  const removed = [];
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(
            keys.filter((key) => Object.prototype.hasOwnProperty.call(storage, key))
              .map((key) => [key, storage[key]]),
          );
        },
        async set(values) {
          Object.assign(storage, values);
        },
        async remove(keys) {
          for (const key of keys) {
            removed.push(key);
            delete storage[key];
          }
        },
      },
    },
  };
  const document = {
    getElementById(id) {
      if (id === "web-commit-guidance") return textarea;
      if (id === "web-commit-guidance-status") return status;
      throw new Error(`Unexpected element: ${id}`);
    },
  };

  vm.runInNewContext(SOURCE, {
    chrome,
    clearTimeout,
    document,
    setTimeout,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  return { textarea, status, storage, removed };
}

test("stores direct edits as webCommitGuidance without clipboard access", async () => {
  assert.doesNotMatch(SOURCE, /clipboard/i);
  const state = await fixture({ webCommitGuidance: "Keep commits focused." });
  assert.equal(state.textarea.value, "Keep commits focused.");

  state.textarea.value = "Explain the intent of each commit.";
  state.textarea.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.storage.webCommitGuidance, "Explain the intent of each commit.");
});

test("migrates old guidance and folds in the co-author preference", async () => {
  const state = await fixture({
    codexCustomInstructions: "Use concise commit titles.",
    codexWebCoauthor: true,
  });

  assert.match(state.storage.webCommitGuidance, /Use concise commit titles\./);
  assert.match(
    state.storage.webCommitGuidance,
    /Co-authored-by: Codex Web <noreply@openai\.com>/,
  );
  assert.equal(state.storage.codexCustomInstructions, undefined);
  assert.equal(state.storage.codexWebCoauthor, undefined);
  assert.ok(state.removed.includes("codexCustomInstructions"));
  assert.ok(state.removed.includes("codexWebCoauthor"));
});
