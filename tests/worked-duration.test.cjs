const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../js/worked-duration.js"), "utf8");
const style = fs.readFileSync(path.join(__dirname, "../css/worked-duration.css"), "utf8");

function fixture(text = "Worked for 8m 41s", { excluded = false, dotsEnabled = false } = {}) {
  const attributes = new Map();
  const properties = new Map();
  const frames = [];
  const textNode = { nodeValue: text, parentElement: null };
  let stop;
  let notify;
  let storageChangeListener;
  let disconnected = false;

  const element = {
    style: {
      getPropertyValue(name) { return properties.get(name) ?? ""; },
      setProperty(name, value) { properties.set(name, value); },
      removeProperty(name) { properties.delete(name); },
    },
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
    chrome: {
      runtime: { getURL: (resource) => `chrome-extension://fixture/${resource}` },
      storage: {
        local: { async get(defaults) { return { ...defaults, workedDurationDots: dotsEnabled }; } },
        onChanged: {
          addListener(fn) { storageChangeListener = fn; },
          removeListener(fn) { if (storageChangeListener === fn) storageChangeListener = null; },
        },
      },
    },
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
    async ready() { await Promise.resolve(); flush(); },
    toggleDots(enabled) {
      dotsEnabled = enabled;
      if (!storageChangeListener) throw new Error("Storage listener missing");
      storageChangeListener({ workedDurationDots: { newValue: enabled } }, "local");
      flush();
    },
    get listening() { return Boolean(storageChangeListener); },
    update(text) { textNode.nodeValue = text; notify(); flush(); },
    stop() { stop(); },
    get disconnected() { return disconnected; },
  };
}

test("completed worked-for timing becomes cannon minutes while preserving its full text", () => {
  const f = fixture();
  f.flush();
  assert.equal(f.element.getAttribute("data-ghrc-worked-minutes"), "8m");
  assert.equal(f.element.getAttribute("title"), "Worked for 8m 41s");
  assert.equal(f.element.textContent, "Worked for 8m 41s");
  assert.equal(f.element.hasAttribute("data-ghrc-worked-duration"), true);
  assert.equal(f.element.style.getPropertyValue("--ghrc-worked-artwork"), 'url("chrome-extension://fixture/artwork/searching-complete.png")');
  f.update("Worked for 10m 5s");
  assert.equal(f.element.getAttribute("data-ghrc-worked-minutes"), "10m");
  assert.equal(f.element.getAttribute("title"), "Worked for 10m 5s");
  f.stop();
  assert.equal(f.disconnected, true);
  assert.equal(f.element.hasAttribute("data-ghrc-worked-duration"), false);
  assert.equal(f.element.hasAttribute("title"), false);
  assert.equal(f.element.style.getPropertyValue("--ghrc-worked-artwork"), "");
});

test("sub-minute values hide the time and show minutes starting at one minute", () => {
  const f = fixture("Worked for 42s");
  f.flush();
  assert.equal(f.element.getAttribute("data-ghrc-worked-minutes"), "");
  f.update("Worked for 59s");
  assert.equal(f.element.getAttribute("data-ghrc-worked-minutes"), "");
  f.update("Worked for 60s");
  assert.equal(f.element.getAttribute("data-ghrc-worked-minutes"), "1m");
  f.update("Worked for 1h 3m 12s");
  assert.equal(f.element.getAttribute("data-ghrc-worked-minutes"), "63m");
  f.update("Worked for 0m 30s");
  assert.equal(f.element.getAttribute("data-ghrc-worked-minutes"), "");
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

test("badge uses bundled cannon artwork without replacing the native label", () => {
  assert.match(source, /chrome\.runtime\.getURL\("artwork\/searching-complete\.png"\)/);
  assert.match(style, /var\(--ghrc-worked-artwork\)/);
  assert.match(style, /content:\s*attr\(data-ghrc-worked-minutes\)/);
  assert.doesNotMatch(source, /replaceChild|innerHTML\s*=/);
});

test("opt-in dots render one per minute beneath the cannon and switch live", async () => {
  const f = fixture("Worked for 8m 41s", { dotsEnabled: true });
  await f.ready();
  assert.equal(f.element.hasAttribute("data-ghrc-worked-dots-mode"), true);
  assert.equal(f.element.getAttribute("data-ghrc-worked-dots").split("•").length - 1, 8);
  assert.equal(f.element.getAttribute("data-ghrc-worked-minutes"), "8m");
  assert.equal(f.element.getAttribute("title"), "Worked for 8m 41s");

  f.update("Worked for 1h 3m 12s");
  const dots = f.element.getAttribute("data-ghrc-worked-dots");
  assert.equal(dots.split("•").length - 1, 63);
  assert.equal(dots.split("\n").length, 6);
  assert.equal(dots.split("\n")[0].split("•").length - 1, 12);

  f.toggleDots(false);
  assert.equal(f.element.hasAttribute("data-ghrc-worked-dots-mode"), false);
  assert.equal(f.element.hasAttribute("data-ghrc-worked-dots"), false);
  assert.equal(f.element.getAttribute("data-ghrc-worked-minutes"), "63m");

  f.toggleDots(true);
  f.update("Worked for 59s");
  assert.equal(f.element.getAttribute("data-ghrc-worked-minutes"), "");
  assert.equal(f.element.hasAttribute("data-ghrc-worked-dots-mode"), false);
  assert.equal(f.element.hasAttribute("data-ghrc-worked-dots"), false);

  f.update("Worked for 1m");
  assert.equal(f.element.getAttribute("data-ghrc-worked-dots"), "•");
  f.stop();
  assert.equal(f.element.hasAttribute("data-ghrc-worked-dots"), false);
  assert.equal(f.listening, false);
});

test("dot display is an opt-in preference exposed in both settings pages", () => {
  const js = fs.readFileSync(path.join(__dirname, "../js/options.js"), "utf8");
  for (const htmlFile of ["options.html", "popup.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", htmlFile), "utf8");
    assert.match(html, /id="worked-duration-dots"/);
  }
  assert.match(js, /workedDurationDots: false/);
  assert.match(js, /workedDurationDots: workedDurationDotsInput\.checked/);
  assert.match(style, /content:\s*attr\(data-ghrc-worked-dots\)/);
  assert.match(style, /\[data-ghrc-worked-duration\]\[data-ghrc-worked-dots-mode\]::after/);
});
