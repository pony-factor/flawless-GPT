const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../js/composer-colors.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../css/composer-colors.css"), "utf8");

test("composer color overrides validate, update live and clean up", async () => {
  const attrs = new Set(), props = new Map(), listeners = [];
  let cleanup;
  const root = {
    setAttribute: name => attrs.add(name),
    removeAttribute: name => attrs.delete(name),
    style: {
      setProperty: (name, value) => props.set(name, value),
      removeProperty: name => props.delete(name),
    },
  };
  const chrome = { storage: {
    local: { get: async () => ({ composerColors: {} }) },
    onChanged: {
      addListener: fn => listeners.push(fn),
      removeListener: fn => listeners.splice(listeners.indexOf(fn), 1),
    },
  }};
  vm.runInNewContext(source, {
    chrome,
    document: { documentElement: root, getElementById: () => null },
    globalThis: { __ghrcExtensionContext: {
      active: () => true, run: fn => fn(), onStop: fn => { cleanup = fn; },
    }},
  });
  await Promise.resolve();
  assert.equal(attrs.size, 0);
  listeners[0]({ composerColors: { surface: "#AABBCC", "send-icon": "#123456", text: "red" } }, "local");
  assert.equal(props.get("--ghrc-composer-surface"), "#aabbcc");
  assert.equal(props.get("--ghrc-composer-send-icon"), "#123456");
  assert.equal(attrs.has("data-ghrc-color-text"), false);
  listeners[0]({ composerColors: { "surface-border": "#ffffff" } }, "local");
  assert.equal(attrs.has("data-ghrc-color-surface"), false);
  assert.equal(attrs.has("data-ghrc-color-surface-border"), true);
  cleanup();
  assert.equal(attrs.size, 0);
  assert.equal(props.size, 0);
  assert.equal(listeners.length, 0);
});

test("all independent composer colors have corresponding scoped CSS selectors", () => {
  const swatches = [...source.matchAll(/\["([a-z-]+)","[^"]+","#[0-9a-f]{6}"\]/g)].map(match => match[1]);
  assert.equal(swatches.length, 19);
  for (const name of swatches) assert.ok(css.includes(`html[data-ghrc-color-${name}]`));
  assert.ok(css.includes("form:has(#prompt-textarea)"));
});
