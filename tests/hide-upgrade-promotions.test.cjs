const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../js/hide-upgrade-promotions.js"), "utf8");

function api() {
  const testApi = {};
  vm.runInNewContext(source, { __GHRC_TEST__: testApi });
  return testApi;
}

function element(text, options = {}) {
  return {
    textContent: text,
    parentElement: options.parent || null,
    matches: () => Boolean(options.protectedTag),
    closest: () => (options.protectedAncestor ? {} : null),
    querySelector: () => (options.protectedDescendant ? {} : null),
    querySelectorAll: () => Array.from({ length: options.buttons ?? 2 }, () => ({})),
    getAttribute: () => null,
  };
}

test("matches the Astra upgrade card and chooses its outer card wrapper", () => {
  const matcher = api();
  const copy = "GPT-6 Astra is built for work like this Upgrade to Pro for more of Astra's stronger judgment, deeper context, and more polished results.";
  const wrapper = element(copy + " Upgrade to Pro", { buttons: 2 });
  const inner = element(copy + " Upgrade to Pro", { parent: wrapper });
  const action = element("Upgrade to Pro", { parent: inner });
  assert.equal(matcher.findPromotionPanel(action), wrapper);
});

test("does not hide navigation upgrade buttons or ordinary chat content", () => {
  const matcher = api();
  const navigation = element("Upgrade to Pro", { buttons: 1 });
  assert.equal(matcher.findPromotionPanel(element("Upgrade to Pro", { parent: navigation })), null);
  const answer = element("GPT-6 Astra is built for work like this Upgrade to Pro", { protectedAncestor: true });
  assert.equal(matcher.findPromotionPanel(element("Upgrade to Pro", { parent: answer, protectedAncestor: true })), null);
  assert.equal(matcher.isPromotionPanel(element("Built for work like this Upgrade to Pro", { protectedDescendant: true })), false);
  assert.equal(matcher.isPromotionPanel(element("Built for work like this Upgrade to Pro", { protectedTag: true })), false);
});

test("requires both a recognizable upgrade action and promotional copy", () => {
  const matcher = api();
  const banner = element("GPT-6 Astra is built for work like this Upgrade to Pro", { buttons: 2 });
  assert.equal(matcher.findPromotionPanel(element("Read more", { parent: banner })), null);
  assert.equal(matcher.findPromotionPanel(element("Upgrade to Pro", { parent: element("Upgrade to Pro", { buttons: 1 }) })), null);
  assert.equal(matcher.findPromotionPanel(element("Upgrade to Pro", { parent: element("Upgrade to Pro for more", { buttons: 9 }) })), null);
});
