const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../js/chat/hide-scheduled-recommendations.js"), "utf8");
const api = {};
vm.runInNewContext(source, { __GHRC_TEST__: api });

function element(text, { parent = null, protectedAncestor = false, actionCount = 0, unsafe = false, protectedRoot = false } = {}) {
  return {
    textContent: text,
    parentElement: parent,
    closest: () => protectedAncestor ? {} : null,
    matches: () => protectedRoot,
    querySelector: () => unsafe ? {} : null,
    querySelectorAll: () => Array.from({ length: actionCount }, () => ({ contains: () => false })),
    contains: () => false,
  };
}

test("only the Scheduled and legacy tasks routes are eligible", () => {
  assert.equal(api.scheduledPath("/scheduled"), true);
  assert.equal(api.scheduledPath("/scheduled/task/123"), true);
  assert.equal(api.scheduledPath("/tasks"), true);
  assert.equal(api.scheduledPath("/c/123"), false);
  assert.equal(api.scheduledPath("/scheduled-messages"), false);
});

test("chooses the closest complete recommendation group", () => {
  const outer = element("Recommended A long description for one task another for a second", { actionCount: 9 });
  const group = element("Recommended A long description for one task another for a second", { parent: outer, actionCount: 3 });
  const header = element("Recommended", { parent: group, actionCount: 1 });
  assert.equal(api.findRecommendationGroup(header), group);
});

test("does not treat a solitary Recommended menu as a recommendation group", () => {
  const menu = element("Recommended", { actionCount: 1 });
  assert.equal(api.findRecommendationGroup(element("Recommended", { parent: menu })), null);
});

test("does not hide page roots, dialogs, task forms, or oversized lists", () => {
  const root = element("Recommended Some long suggestion with a plus action", { protectedRoot: true, actionCount: 3 });
  assert.equal(api.findRecommendationGroup(element("Recommended", { parent: root })), null);
  const dialog = element("Recommended", { protectedAncestor: true });
  assert.equal(api.findRecommendationGroup(dialog), null);
  const form = element("Recommended This could be a recommendation with a description", { actionCount: 3, unsafe: true });
  assert.equal(api.findRecommendationGroup(element("Recommended", { parent: form })), null);
  const long = element("Recommended " + "A".repeat(2500), { actionCount: 5 });
  assert.equal(api.findRecommendationGroup(element("Recommended", { parent: long })), null);
});

test("requires exact Recommended label, not arbitrary user task titles", () => {
  const group = element("Recommended task for later: Review quarterly results", { actionCount: 3 });
  assert.equal(api.findRecommendationGroup(element("Recommended task", { parent: group })), null);
});
