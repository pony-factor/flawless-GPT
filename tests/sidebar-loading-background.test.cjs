const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "js/sidebar-loading-background.js"), "utf8");

function start(readyState = "loading") {
  const attributes = new Set();
  const handlers = new Map();
  const timers = [];
  const document = {
    readyState,
    documentElement: {
      setAttribute: name => attributes.add(name),
      removeAttribute: name => attributes.delete(name),
    },
  };
  const window = {
    addEventListener: (name, callback) => handlers.set(name, callback),
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
  };
  vm.runInNewContext(source, { document, window });
  return { attributes, handlers, timers };
}

test("sidebar loading color starts before document is ready and clears on load", () => {
  const state = start();
  assert.equal(state.attributes.has("data-ghrc-sidebar-loading"), true);
  assert.equal(state.timers[0].delay, 8000);
  state.handlers.get("load")();
  assert.equal(state.attributes.has("data-ghrc-sidebar-loading"), false);
});

test("sidebar loading color also clears on pageshow or timeout", () => {
  const pageShow = start();
  pageShow.handlers.get("pageshow")();
  assert.equal(pageShow.attributes.size, 0);
  const timeout = start();
  timeout.timers[0].callback();
  assert.equal(timeout.attributes.size, 0);
});

test("already loaded pages do not apply the temporary color", () => {
  const state = start("complete");
  assert.equal(state.attributes.size, 0);
  assert.equal(state.timers.length, 0);
});

test("loading styles and script run at document_start", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const script = manifest.content_scripts.find(entry => entry.js?.includes("js/sidebar-loading-background.js"));
  const style = manifest.content_scripts.find(entry => entry.css?.includes("css/sidebar-loading-background.css"));
  assert.equal(script?.run_at, "document_start");
  assert.equal(style?.run_at, "document_start");
  const css = fs.readFileSync(path.join(root, "css/sidebar-loading-background.css"), "utf8");
  assert.match(css, /html\[data-ghrc-sidebar-loading\]/);
  assert.match(css, /background-color: #000 !important/);
});
