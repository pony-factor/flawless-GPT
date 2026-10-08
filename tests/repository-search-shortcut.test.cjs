const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadShortcuts() {
  const context = { globalThis: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../js/repository-search-shortcut.js"), "utf8"),
    context,
  );
  return context.globalThis.__ghrcRepositorySearchShortcut;
}

function event(key, extra = {}) {
  return {
    key, code: "", altKey: false, ctrlKey: false, metaKey: false,
    shiftKey: false, defaultPrevented: false, repeat: false,
    isComposing: false, ...extra,
  };
}

test("Alt+R remains the default and supports macOS Option keyboard layouts", () => {
  const shortcuts = loadShortcuts();
  assert.equal(shortcuts.format(), "Alt+R");
  assert.equal(shortcuts.matches(event("r", { code: "KeyR", altKey: true })), true);
  assert.equal(shortcuts.matches(event("®", { code: "KeyR", altKey: true })), true);
  assert.equal(shortcuts.matches(event("r")), false);
});

test("user-selected Delete, Backspace, letters, and modifier combinations round trip", () => {
  const shortcuts = loadShortcuts();
  for (const key of ["Delete", "Backspace", "x", "F8", "ArrowDown", "Escape", " "]) {
    const configured = shortcuts.fromEvent(event(key));
    assert.ok(configured, key);
    assert.equal(shortcuts.matches(event(key), configured), true);
  }
  const del = shortcuts.fromEvent(event("Delete"));
  assert.equal(shortcuts.format(del), "Del");
  assert.equal(shortcuts.matches(event("Backspace"), del), false);
  const combination = shortcuts.fromEvent(event("k", { code: "KeyK", ctrlKey: true, shiftKey: true }));
  assert.equal(shortcuts.format(combination), "Ctrl+Shift+K");
  assert.equal(shortcuts.matches(event("k", { code: "KeyK", ctrlKey: true, shiftKey: true }), combination), true);
  assert.equal(shortcuts.matches(event("k", { code: "KeyK", ctrlKey: true }), combination), false);
});

test("ignore invalid shortcut values, modifier-only presses, and repeat/composition", () => {
  const shortcuts = loadShortcuts();
  assert.equal(shortcuts.format({ key: "Alt" }), "Alt+R");
  assert.equal(shortcuts.fromEvent(event("Control", { ctrlKey: true })), null);
  assert.equal(shortcuts.fromEvent(event("Unidentified")), null);
  assert.equal(shortcuts.matches(event("Delete", { repeat: true }), { key: "Delete" }), false);
  assert.equal(shortcuts.matches(event("Delete", { isComposing: true }), { key: "Delete" }), false);
  assert.equal(shortcuts.matches(event("Delete", { defaultPrevented: true }), { key: "Delete" }), false);
});

test("unmodified shortcuts preserve editable fields including ChatGPT's composer", () => {
  const shortcuts = loadShortcuts();
  const editor = { isContentEditable: true };
  assert.equal(shortcuts.isEditable({
    target: editor,
    composedPath: () => [editor],
  }, { activeElement: editor }), true);
  const input = { closest: (selector) => selector.includes("input") ? {} : null };
  assert.equal(shortcuts.isEditable({ target: input, composedPath: () => [input] },
    { activeElement: input }), true);
  const surface = { isContentEditable: false, closest: () => null };
  assert.equal(shortcuts.isEditable({ target: surface, composedPath: () => [surface] },
    { activeElement: surface }), false);
  assert.equal(shortcuts.hasModifiers(shortcuts.fromEvent(event("Delete"))), false);
  assert.equal(shortcuts.hasModifiers(shortcuts.DEFAULT), true);
  const emptyComposer = {
    textContent: "",
    querySelector: () => null,
  };
  const editorEvent = {
    target: {
      closest: (selector) => selector.includes("#prompt-textarea") ? emptyComposer : null,
    },
  };
  assert.equal(shortcuts.isEmptyComposer(editorEvent, { key: "Delete" }), true);
  assert.equal(shortcuts.isEmptyComposer(editorEvent, { key: "x" }), false);
  emptyComposer.textContent = "draft text";
  assert.equal(shortcuts.isEmptyComposer(editorEvent, { key: "Delete" }), false);
});

test("the shortcut helper is loaded before both settings and the content script", () => {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts.find((entry) =>
    entry.matches.includes("https://chatgpt.com/*")
    && entry.js.includes("js/content.js"),
  ).js;
  assert.ok(scripts.indexOf("js/repository-search-shortcut.js") >= 0);
  assert.ok(scripts.indexOf("js/repository-search-shortcut.js") < scripts.indexOf("js/content.js"));
  for (const name of ["options.html", "popup.html"]) {
    const html = fs.readFileSync(path.join(root, name), "utf8");
    assert.ok(html.includes('id="repository-search-shortcut"'));
    assert.ok(html.indexOf('src="js/repository-search-shortcut.js"')
      < html.indexOf('src="js/options.js"'));
  }
});
