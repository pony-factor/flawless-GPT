const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "../js/preserve-scroll-on-send.js"),
  "utf8"
);

function api() {
  const testApi = {};
  const context = {
    __GHRC_TEST__: testApi,
    Set,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return testApi;
}

function target({ send = false, composer = false, inForm = true } = {}) {
  const composerNode = {
    id: composer ? "prompt-textarea" : "",
    closest(selector) {
      return selector === "form" && inForm ? {} : null;
    },
  };

  return {
    closest(selector) {
      if (send && selector.includes("send-button")) return this;
      if (composer && selector.includes("#prompt-textarea")) return composerNode;
      return null;
    },
  };
}

test("recognizes ChatGPT send buttons", () => {
  assert.equal(api().isSendButtonTarget(target({ send: true })), true);
  assert.equal(api().isSendButtonTarget(target()), false);
});

test("recognizes Enter in the composer as a send gesture", () => {
  const helpers = api();
  assert.equal(
    helpers.shouldBeginForKeydown({
      key: "Enter",
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      target: target({ composer: true }),
    }),
    true,
  );
});

test("does not treat Shift+Enter or composition Enter as send", () => {
  const helpers = api();
  const base = {
    key: "Enter",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    target: target({ composer: true }),
  };

  assert.equal(helpers.shouldBeginForKeydown({ ...base, shiftKey: true }), false);
  assert.equal(helpers.shouldBeginForKeydown({ ...base, isComposing: true }), false);
});

test("recognizes keys that mean the user wants to move the viewport", () => {
  const helpers = api();
  assert.equal(helpers.isUserScrollKey({ key: "PageDown" }), true);
  assert.equal(helpers.isUserScrollKey({ key: "ArrowUp" }), true);
  assert.equal(helpers.isUserScrollKey({ key: "Enter" }), false);
});
