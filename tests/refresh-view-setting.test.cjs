const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const source = read("js/chat/chat-display.js");
const css = read("css/refresh-view.css");

function fixture(initial = {}) {
  const attributes = new Set();
  let onStorageChanged;
  const settings = { ...initial };
  const document = {
    documentElement: {
      toggleAttribute(name, enabled) {
        if (enabled) attributes.add(name);
        else attributes.delete(name);
      },
      setAttribute(name) { attributes.add(name); },
    },
    querySelectorAll() { return []; },
  };
  const sandbox = {
    document,
    chrome: {
      storage: {
        local: { async get(defaults) { return { ...defaults, ...settings }; } },
        onChanged: { addListener(callback) { onStorageChanged = callback; } },
      },
    },
    __ghrcExtensionContext: {
      active() { return true; },
      onStop() {},
      run(callback) { return callback(); },
    },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame() {},
  };
  vm.runInNewContext(source, sandbox);
  return {
    attributes,
    async ready() { await new Promise(resolve => setImmediate(resolve)); },
    update(value) { onStorageChanged({ showRefreshView: { newValue: value } }, "local"); },
  };
}

test("Refresh view is shown by default and responds to live preference changes", async () => {
  const f = fixture();
  await f.ready();
  assert.equal(f.attributes.has("data-ghrc-hide-refresh-view"), false);
  f.update(false);
  assert.equal(f.attributes.has("data-ghrc-hide-refresh-view"), true);
  f.update(true);
  assert.equal(f.attributes.has("data-ghrc-hide-refresh-view"), false);
});

test("stored hidden preference is restored when a conversation loads", async () => {
  const f = fixture({ showRefreshView: false });
  await f.ready();
  assert.equal(f.attributes.has("data-ghrc-hide-refresh-view"), true);
});

test("both settings pages expose the default-on Refresh view switch", () => {
  for (const page of ["options.html", "popup.html"]) {
    const html = read(page);
    assert.equal((html.match(/id="show-refresh-view"/g) || []).length, 1);
    assert.match(html, /id="show-refresh-view" type="checkbox" checked/);
  }
  const settings = read("js/settings/options.js");
  assert.match(settings, /showRefreshView: showRefreshViewInput\.checked/);
  assert.match(settings, /showRefreshViewInput\.checked = settings\.showRefreshView !== false/);
});

test("hidden preference applies CSS without removing the refresh button", () => {
  assert.match(css, /:root\[data-ghrc-hide-refresh-view\] #ghrc-refresh-view \{ display: none !important; \}/);
  assert.doesNotMatch(source, /#ghrc-refresh-view.*remove\(/);
});
