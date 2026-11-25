const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "js/settings/spellcheck-launcher-image.js"), "utf8");
const KEY = "spellcheckLauncherImage";

function fixture(initial = null) {
  let saved = initial;
  let onStorageChanged;
  const element = (id) => ({
    id, disabled: false, src: "", value: "", textContent: "", files: [],
    listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    trigger(name, event = {}) { return this.listeners[name](event); },
  });
  const preview = element("spellcheck-launcher-image-preview");
  const picker = element("spellcheck-launcher-image-file");
  const reset = element("reset-spellcheck-launcher-image");
  const status = element("spellcheck-launcher-image-status");
  const elements = Object.fromEntries([preview, picker, reset, status].map(e => [e.id, e]));
  const chrome = {
    runtime: { getURL: (p) => "chrome-extension://test/" + p },
    storage: {
      local: {
        async get(defaults) { return { ...defaults, [KEY]: saved }; },
        async set(values) {
          saved = values[KEY];
          onStorageChanged?.({ [KEY]: { newValue: saved } }, "local");
        },
        async remove(key) {
          assert.equal(key, KEY);
          saved = null;
          onStorageChanged?.({ [KEY]: { newValue: undefined } }, "local");
        },
      },
      onChanged: { addListener(fn) { onStorageChanged = fn; } },
    },
  };
  class Reader {
    readAsDataURL(file) {
      this.result = file.dataUrl;
      queueMicrotask(() => this.onload?.());
    }
  }
  class Probe {
    set src(data) {
      queueMicrotask(() => data.includes("broken") ? this.onerror?.() : this.onload?.());
    }
  }
  vm.runInNewContext(source, {
    chrome, document: { getElementById: id => elements[id] },
    FileReader: Reader, Image: Probe,
  });
  return {
    picker, preview, reset, status,
    get saved() { return saved; },
    async ready() { await new Promise(setImmediate); },
    async select(file) {
      picker.files = [file];
      let stopped = false;
      await picker.trigger("change", { stopPropagation() { stopped = true; } });
      return stopped;
    },
  };
}

test("a user image persists locally and can be restored to the bundled icon", async () => {
  const f = fixture();
  await f.ready();
  assert.equal(f.preview.src, "chrome-extension://test/artwork/spellcheck-only.jpg");
  assert.equal(f.reset.disabled, true);
  const image = "data:image/png;base64,aGVsbG8=";
  assert.equal(await f.select({ type: "image/png", size: 5, dataUrl: image }), true);
  assert.equal(f.saved, image);
  assert.equal(f.preview.src, image);
  const reopened = fixture(f.saved);
  await reopened.ready();
  assert.equal(reopened.preview.src, image);
  await reopened.reset.trigger("click");
  assert.equal(reopened.saved, null);
  assert.equal(reopened.preview.src, "chrome-extension://test/artwork/spellcheck-only.jpg");
  assert.equal(reopened.reset.disabled, true);
});

test("rejects SVGs, oversized files and corrupt image data", async () => {
  const original = "data:image/webp;base64,aGVsbG8=";
  const f = fixture(original);
  await f.ready();
  await f.select({ type: "image/svg+xml", size: 10, dataUrl: "data:image/svg+xml;base64,aGVsbG8=" });
  await f.select({ type: "image/png", size: 1024 * 1024 + 1, dataUrl: "data:image/png;base64,aGVsbG8=" });
  await f.select({ type: "image/png", size: 10, dataUrl: "data:image/png;base64,broken" });
  assert.equal(f.saved, original);
  assert.equal(f.preview.src, original);
  assert.match(f.status.textContent, /not saved/);
});

test("popup and standalone settings offer the image picker and reset", () => {
  for (const page of ["popup.html", "options.html"]) {
    const html = fs.readFileSync(path.join(root, page), "utf8");
    for (const id of ["spellcheck-launcher-image-preview", "spellcheck-launcher-image-file",
      "reset-spellcheck-launcher-image", "spellcheck-launcher-image-status"]) {
      assert.equal(html.split('id="' + id + '"').length, 2, page + " " + id);
    }
    assert.match(html, /src="js\/settings\/spellcheck-launcher-image\.js"/);
  }
});
