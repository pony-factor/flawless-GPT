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
  assert.equal(swatches.length, 22);
  for (const name of swatches) assert.ok(css.includes(`html[data-ghrc-color-${name}]`));
  assert.ok(css.includes("form:has(#prompt-textarea)"));
  for (const attr of ["plus-background", "plus-icon", "plus-hover"]) {
    assert.ok(css.includes(`html[data-ghrc-color-${attr}]`), `plus ${attr} is scoped`);
  }
  assert.equal(css.split('[data-testid="composer-plus-btn"], #composer-plus-btn').length - 1, 3,
    "all toolbar declarations exclude the plus button");
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
      get: async () => ({ composerColors: { surface: "#AABBCC" }, composerColorSource: { "stop-background": "#008844", "stop-icon": "#ffffff", "plus-background": "#203040", "plus-icon": "#efefef" } }),
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
  const stopRow = grid.children[14];
  const stopMarker = stopRow.children[0].children[0];
  const [stopPicker, stopHex, stopClear] = stopRow.children[1].children;
  assert.equal(stopPicker.value, "#008844", "source accent replaces the white placeholder");
  assert.equal(stopHex.value, "#008844");
  assert.equal(stopMarker.hidden, false, "inherited preview is marked with an asterisk");
  assert.equal(stopClear.hidden, true, "source preview does not count as an override");
  const plusRow = grid.children[16];
  const plusMarker = plusRow.children[0].children[0];
  const [plusPicker, plusHex, plusClear] = plusRow.children[1].children;
  assert.equal(grid.children.length, 22);
  assert.equal(plusPicker.value, "#203040");
  assert.equal(plusHex.value, "#203040");
  assert.equal(plusClear.hidden, true);
  assert.equal(plusMarker.hidden, false, "native plus preview is marked as sourced");
  assert.equal(grid.children[17].children[1].children[1].value, "#efefef");
  assert.equal(grid.children[18].children[0].children.length, 0, "hover has no fabricated source marker");
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

  stopHex.value = "#123456";
  stopHex.emit("input");
  await flush();
  assert.equal(stopMarker.hidden, true, "custom stop colors are not marked inherited");
  assert.equal(stored.at(-1)["stop-background"], "#123456");
  stopClear.emit("click");
  await flush();
  assert.equal(stopHex.value, "#008844", "Default restores the source accent");
  assert.equal(stopMarker.hidden, false);
  assert.equal(stored.at(-1)["stop-background"], undefined);

  plusHex.value = "#abcdef";
  plusHex.emit("input");
  await flush();
  assert.equal(stored.at(-1)["plus-background"], "#abcdef");
  assert.equal(plusMarker.hidden, true, "custom plus overrides are no longer marked inherited");
  plusClear.emit("click");
  await flush();
  assert.equal(plusHex.value, "#203040", "plus Default restores the native preview");
  assert.equal(plusMarker.hidden, false);
  assert.equal(stored.at(-1)["plus-background"], undefined);

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


test("stop preview imports native ChatGPT colors without sampling an extension override", async () => {
  const attrs = new Set(), saves = [], timers = [];
  let cleanup;
  let background = "rgb(0, 170, 68)", icon = "rgb(255, 255, 255)", themeBackground = "";
  let plusBackground = "rgb(45, 56, 67)", plusIcon = "rgb(22, 33, 44)";
  const button = { querySelector: () => null };
  const plusButton = { querySelector: () => null };
  const root = {
    hasAttribute: name => attrs.has(name),
    setAttribute: name => attrs.add(name), removeAttribute: name => attrs.delete(name),
    style: { setProperty() {}, removeProperty() {} },
  };
  const chrome = { storage: {
    local: {
      get: async () => ({ composerColors: {} }),
      set: async snapshot => { saves.push(snapshot.composerColorSource); },
    },
    onChanged: { addListener() {}, removeListener() {} },
  }};
  vm.runInNewContext(source, {
    chrome,
    document: { documentElement: root, getElementById: () => null, querySelector: selector => selector.includes("composer-plus-btn") ? plusButton : button },
    getComputedStyle: element => element === root
      ? { getPropertyValue: key => key === "--theme-submit-btn-bg" ? themeBackground : "" }
      : element === plusButton ? { backgroundColor: plusBackground, color: plusIcon }
      : { backgroundColor: background, color: icon },
    setInterval: fn => { timers.push(fn); return 1; }, clearInterval() {},
    globalThis: { __ghrcExtensionContext: {
      active: () => true, run: fn => fn(), onStop: fn => { cleanup = fn; },
    }},
  });
  await Promise.resolve();
  assert.equal(saves.at(-1)["stop-background"], "#00aa44");
  assert.equal(saves.at(-1)["stop-icon"], "#ffffff");
  assert.equal(saves.at(-1)["plus-background"], "#2d3843");
  assert.equal(saves.at(-1)["plus-icon"], "#16212c");
  assert.equal(saves.at(-1)["plus-hover"], undefined, "never invent hovered colors");
  attrs.add("data-ghrc-color-stop-background");
  background = "rgb(18, 52, 86)";
  timers[0]();
  assert.equal(saves.length, 1, "Flawless override is not imported");
  themeBackground = "#aabbcc";
  timers[0]();
  assert.equal(saves.at(-1)["stop-background"], "#aabbcc");
  attrs.delete("data-ghrc-color-stop-background");
  timers[0]();
  assert.equal(saves.at(-1)["stop-background"], "#123456");
  attrs.add("data-ghrc-color-plus-background");
  plusBackground = "rgb(99, 99, 99)";
  timers[0]();
  assert.equal(saves.at(-1)["plus-background"], undefined, "custom plus CSS cannot become the inherited source");
  attrs.delete("data-ghrc-color-plus-background");
  timers[0]();
  assert.equal(saves.at(-1)["plus-background"], "#636363");
  cleanup();
});
