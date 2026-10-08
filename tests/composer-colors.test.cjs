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

test("HEX or picker edits enable individual colors immediately without checkboxes", async () => {
  class Element {
    constructor() {
      this.children = []; this.events = {}; this.attributes = {}; this.value = "";
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
  const [picker, hex, clear] = controls.children;
  assert.equal(label.children.length, 0, "no redundant enable checkbox");
  assert.equal(picker.value, "#aabbcc");
  assert.equal(hex.value, "#aabbcc");
  assert.equal(clear.hidden, false);

  const [otherPicker, otherHex, otherClear] = grid.children[1].children[1].children;
  assert.equal(otherClear.hidden, true, "untouched colors inherit native theme");
  assert.equal(otherHex.disabled, undefined, "HEX editing starts enabled");
  const flush = () => new Promise(resolve => setImmediate(resolve));

  otherHex.value = "00FF7f";
  otherHex.emit("input");
  await flush();
  assert.equal(otherPicker.value, "#00ff7f");
  assert.equal(stored.at(-1)["surface-border"], "#00ff7f");
  assert.equal(otherClear.hidden, false);

  const saves = stored.length;
  otherHex.value = "#badcolor";
  otherHex.emit("input");
  await flush();
  assert.equal(otherHex.attributes["aria-invalid"], "true");
  assert.equal(stored.length, saves);
  otherHex.emit("change");
  assert.equal(otherHex.value, "#00ff7f");

  picker.value = "#123456";
  picker.emit("input");
  await flush();
  assert.equal(hex.value, "#123456");
  assert.equal(stored.at(-1).surface, "#123456");

  clear.emit("click");
  await flush();
  assert.equal(clear.hidden, true);
  assert.equal(stored.at(-1).surface, undefined);
  assert.equal(hex.value, "#303030");

  reset.emit("click");
  await flush();
  assert.equal(otherClear.hidden, true);
  assert.equal(stored.at(-1)["surface-border"], undefined);
});
