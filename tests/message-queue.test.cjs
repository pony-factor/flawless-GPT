const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "../js/message-queue.js"),
  "utf8",
);

function api() {
  const testApi = {};
  const context = {
    __GHRC_TEST__: testApi,
    crypto: { randomUUID: () => "test-session" },
    Date,
    Math,
    location: { pathname: "/", href: "https://chatgpt.com/" },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return testApi;
}

test("extracts stable conversation ids from ChatGPT routes", () => {
  const helpers = api();
  assert.equal(helpers.conversationIdFromPath("/c/abc-123"), "abc-123");
  assert.equal(helpers.conversationIdFromPath("/"), "");
});

test("normalizes persisted queue items and drops empty entries", () => {
  const helpers = api();
  const items = helpers.normalizeQueueItems([
    { id: "one", text: "First", createdAt: 10 },
    { id: "empty", text: "   ", createdAt: 20 },
    null,
  ]);

  assert.equal(
    JSON.stringify(items.map(({ id, text, createdAt }) => ({ id, text, createdAt }))),
    JSON.stringify([{ id: "one", text: "First", createdAt: 10 }]),
  );
});

test("keeps image-only messages when loading a saved queue", () => {
  const attachment = { name: 'picture.png', type: 'image/png', dataUrl: 'data:image/png;base64,aW1hZ2U=' };
  const items = api().normalizeQueueItems([{ id: 'image', text: '', attachments: [attachment] }, { id: 'empty', text: '' }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, '');
  assert.equal(JSON.stringify(items[0].attachments), JSON.stringify([attachment]));
});

test("recognizes unmodified Enter as a send or queue gesture", () => {
  const helpers = api();
  const enter = {
    key: "Enter",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
  };

  assert.equal(helpers.shouldQueueComposerEnter(enter), true);
  assert.equal(helpers.shouldQueueComposerEnter({ ...enter, keyCode: 229 }), false);
  for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey", "isComposing"]) {
    assert.equal(helpers.shouldQueueComposerEnter({ ...enter, [modifier]: true }), false);
  }

});

test("uses a timer-backed pump while the ChatGPT tab is hidden", () => {
  const helpers = api();
  assert.equal(helpers.pumpSchedulingMode(false), "frame");
  assert.equal(helpers.pumpSchedulingMode(true), "timeout");
});

test("never advances while ChatGPT is still generating", () => {
  const helpers = api();
  assert.equal(
    helpers.queueCanAdvance({
      responseActive: true,
      composerReady: false,
      userTurns: 2,
      assistantTurns: 1,
      latestAssistantComplete: false,
      roleStateKnown: true,
    }, helpers.COMPLETE_SETTLE_MS * 2),
    false,
  );
});

test("does not treat the thinking-to-answer gap as response completion", () => {
  const helpers = api();
  assert.equal(
    helpers.queueCanAdvance({
      responseActive: false,
      composerReady: true,
      userTurns: 2,
      assistantTurns: 2,
      latestUserAnswered: true,
      latestAssistantComplete: false,
      roleStateKnown: true,
    }, helpers.COMPLETE_SETTLE_MS * 2),
    false,
  );
});

test("requires the response-complete state to remain settled", () => {
  const helpers = api();
  const complete = {
    responseActive: false,
    composerReady: true,
    userTurns: 2,
    assistantTurns: 2,
    latestUserAnswered: true,
    latestAssistantComplete: true,
    roleStateKnown: true,
  };

  assert.equal(
    helpers.queueCanAdvance(complete, helpers.COMPLETE_SETTLE_MS - 1),
    false,
  );
  assert.equal(
    helpers.queueCanAdvance(complete, helpers.COMPLETE_SETTLE_MS),
    true,
  );
});

test("can start a queued message in an otherwise empty new chat", () => {
  const helpers = api();
  assert.equal(
    helpers.queueCanAdvance({
      responseActive: false,
      composerReady: true,
      userTurns: 0,
      assistantTurns: 0,
      latestAssistantComplete: false,
      roleStateKnown: true,
    }, helpers.COMPLETE_SETTLE_MS),
    true,
  );
});

test("recognizes conversations inside custom GPT routes", () => {
  assert.equal(api().conversationIdFromPath("/g/g-example/c/abc-123"), "abc-123");
});
