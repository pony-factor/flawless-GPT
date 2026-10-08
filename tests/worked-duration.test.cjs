const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../js/worked-duration.js"), "utf8");
const style = fs.readFileSync(path.join(__dirname, "../css/worked-duration.css"), "utf8");

function fixture(text = "Worked for 8m 41s", { excluded = false } = {}) {
  const attributes = new Map();
  const frames = [];
  const textNode = { nodeValue: text, parentElement: null };
  let stop;
  let notify;
  let disconnected = false;

  const element = {
    get textContent() { return textNode.nodeValue; },
    children: [],
    closest() { return excluded ? this : null; },
    getAttribute(name) { return attributes.get(name) ?? null; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
  };
  textNode.parentElement = element;
  const root = {
    querySelectorAll(selector) {
      return selector === "[data-ghrc-worked-duration]" && attributes.has("data-ghrc-worked-duration")
        ? [element] : [];
    },
  };
  const document = {
    querySelector(selector) { return selector === "main" ? root : null; },
    querySelectorAll(selector) { return root.querySelectorAll(selector); },
    createTreeWalker() {
      let first = true;
      return { nextNode() {
        if (!first) return null;
        first = false;
        return textNode;
      }};
    },
  };
  class MutationObserver {
    constructor(callback) { notify = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  }
  vm.runInNewContext(source, {
    document,
    NodeFilter: { SHOW_TEXT: 4 },
    requestAnimationFrame(fn) { frames.push(fn); },
    MutationObserver,
    globalThis: { __ghrcExtensionContext: {
      active: () => true,
      onStop(callback) { stop = callback; },
    }},
  });
  const flush = () => { while (frames.length) frames.shift()(); };
  return {
    element, attributes, flush,
    update(text) { textNode.nodeValue = text; notify(); flush(); },
    stop() { stop(); },
    get disconnected() { return disconnected; },
  };
}

test("completed worked-for timing becomes pony minutes while preserving its full text", () => {
  const f = fixture();
  f.flush();
  assert.equal(f.element.getAttribute("data-ghrc-worked-minutes"), "8m");
  assert.equal(f.element.getAttribute("title"), "Worked for 8m 41s");
  assert.equal(f.element.textContent, "Worked for 8m 41s");
  assert.equal(f.element.hasAttribute("data-ghrc-worked-duration"), true);
  f.update("Worked for 10m 5s");
  assert.equal(f.element.getAttribute("data-ghrc-worked-minutes"), "10m");
  assert.equal(f.element.getAttribute("title"), "Worked for 10m 5s");
  f.stop();
  assert.equal(f.disconnected, true);
  assert.equal(f.element.hasAttribute("data-ghrc-worked-duration"), false);
  assert.equal(f.element.hasAttribute("title"), false);
});

test("seconds and multi-hour values stay expressible in minutes", () => {
  const f = fixture("Worked for 42s");
  f.flush();
  assert.equal(f.element.getAttribute("data-ghrc-worked-minutes"), "<1m");
  f.update("Worked for 1h 3m 12s");
  assert.equal(f.element.getAttribute("data-ghrc-worked-minutes"), "63m");
});

test("unrelated messages and quoted prose are left unchanged", () => {
  const text = fixture("We worked for 8m 41s");
  text.flush();
  assert.equal(text.element.hasAttribute("data-ghrc-worked-duration"), false);
  const quote = fixture("Worked for 8m 41s", { excluded: true });
  quote.flush();
  assert.equal(quote.element.hasAttribute("data-ghrc-worked-duration"), false);
  const stale = fixture();
  stale.flush();
  stale.update("Show more");
  assert.equal(stale.element.hasAttribute("data-ghrc-worked-duration"), false);
});

test("badge uses bundled pony artwork without replacing the native label", () => {
  assert.match(style, /squeaky-belle-full\.webp/);
  assert.match(style, /content:\s*attr\(data-ghrc-worked-minutes\)/);
  assert.doesNotMatch(source, /replaceChild|innerHTML\s*=/);
});
