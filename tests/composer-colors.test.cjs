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

test("chat bar HEX fields sync with pickers and reject invalid edits", async () => {
  class Element {
    constructor() {
      this.children = [];
      this.events = {};
      this.attributes = {};
      this.value = "";
    }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, callback) { (this.events[name] ??= []).push(callback); }
    emit(name) {
      for (const callback of this.events[name] || []) callback({ target: this, stopPropagation() {} });
    }
  }
  const panel = new Element(), grid = new Element(), reset = new Element();
  const stored = [];
  const chrome = { storage: {
    local: {
      get: async () => ({ composerColors: { surface: "#AABBCC" } }),
      set: async value => { stored.push(value.composerColors); },
    },
  }};
  vm.runInNewContext(source, {
    chrome,
    document: {
      getElementById: id => ({
        "composer-color-settings": panel,
        "composer-color-grid": grid,
        "composer-color-reset": reset,
      })[id] || null,
      createElement: () => new Element(),
    },
  });
  await Promise.resolve();
  assert.equal(grid.children.length, 19);
  const [label, controls] = grid.children[0].children;
  const toggle = label.children[0], [picker, hex] = controls.children;
  assert.equal(toggle.checked, true);
  assert.equal(picker.value, "#aabbcc");
  assert.equal(hex.value, "#aabbcc");
  assert.equal(hex.disabled, false);
  const otherControls = grid.children[1].children[1];
  assert.equal(otherControls.children[1].disabled, true);

  const flush = () => new Promise(resolve => setImmediate(resolve));
  hex.value = "00FF7f";
  hex.emit("input");
  await flush();
  assert.equal(picker.value, "#00ff7f");
  assert.equal(stored.at(-1).surface, "#00ff7f");

  const saves = stored.length;
  hex.value = "#badcolor";
  hex.emit("input");
  await flush();
  assert.equal(hex.attributes["aria-invalid"], "true");
  assert.equal(stored.length, saves);
  assert.equal(picker.value, "#00ff7f");
  hex.emit("change");
  assert.equal(hex.value, "#00ff7f");
  assert.equal(hex.attributes["aria-invalid"], undefined);

  picker.value = "#123456";
  picker.emit("input");
  await flush();
  assert.equal(hex.value, "#123456");
  assert.equal(stored.at(-1).surface, "#123456");

  toggle.checked = false;
  toggle.emit("change");
  await flush();
  assert.equal(hex.disabled, true);
  assert.equal(picker.disabled, true);
  assert.equal(stored.at(-1).surface, undefined);

  toggle.checked = true;
  toggle.emit("change");
  await flush();
  assert.equal(hex.disabled, false);
  assert.equal(stored.at(-1).surface, "#123456");

  reset.emit("click");
  await flush();
  assert.equal(toggle.checked, false);
  assert.equal(stored.at(-1).surface, undefined);
});
