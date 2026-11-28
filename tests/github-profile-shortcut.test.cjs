const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const source = read("js/github/profile-shortcut.js");

function fixture(initial = false) {
  let login = "example-user";
  let onChange, onMutation, cleanup;
  const frames = new Map();
  let frameId = 0;
  const children = [];
  const parent = {};
  function element() {
    const attrs = new Map();
    return {
      parentElement: null,
      get nextElementSibling() {
        const index = children.indexOf(this);
        return index < 0 ? null : children[index + 1] || null;
      },
      setAttribute(key, value) { attrs.set(key, value); },
      getAttribute(key) { return attrs.get(key) ?? null; },
      append(child) { this.firstElementChild = child; },
      remove() {
        const index = children.indexOf(this);
        if (index >= 0) children.splice(index, 1);
        this.parentElement = null;
      },
      before(other) {
        other.remove();
        children.splice(children.indexOf(this), 0, other);
        other.parentElement = parent;
      },
    };
  }
  let logo = element();
  logo.parentElement = parent;
  logo.setAttribute("href", "/");
  children.push(logo);
  const document = {
    querySelector(selector) {
      if (selector.startsWith("meta")) return login ? { content: login } : null;
      if (selector.startsWith("a.AppHeader")) return logo;
      return null;
    },
    createElement: element,
    addEventListener() {},
    removeEventListener() {},
  };
  vm.runInNewContext(source, {
    document,
    chrome: { storage: {
      local: { async get() { return { showGithubProfileShortcut: initial }; } },
      onChanged: { addListener(fn) { onChange = fn; }, removeListener() {} },
    } },
    __ghrcExtensionContext: {
      active: () => true,
      run: (fn) => fn(),
      onStop(fn) { cleanup = fn; },
    },
    MutationObserver: class {
      constructor(fn) { onMutation = fn; }
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  const flush = () => {
    for (const [id, fn] of frames) { frames.delete(id); fn(); }
  };
  return {
    children,
    get logo() { return logo; },
    async ready() { await new Promise(resolve => setImmediate(resolve)); flush(); },
    toggle(value) { onChange({ showGithubProfileShortcut: { newValue: value } }, "local"); flush(); },
    mutate() { onMutation(); flush(); },
    changeLogin(value) { login = value; this.mutate(); },
    replaceLogo() {
      logo.remove();
      logo = element();
      logo.parentElement = parent;
      logo.setAttribute("href", "/");
      children.push(logo);
      this.mutate();
    },
    stop() { cleanup(); },
  };
}

test("default off, live toggle, native logo preserved, no duplicate on rerender", async () => {
  const f = fixture();
  await f.ready();
  assert.deepEqual(f.children, [f.logo]);
  f.toggle(true);
  const avatar = f.children[0];
  assert.equal(avatar.getAttribute("href"), "https://github.com/example-user");
  assert.equal(avatar.firstElementChild.getAttribute("src"), "https://github.com/example-user.png?size=64");
  assert.equal(f.children[1], f.logo);
  assert.equal(f.logo.getAttribute("href"), "/");
  f.mutate();
  f.replaceLogo();
  assert.deepEqual(f.children, [avatar, f.logo]);
  f.changeLogin("other-user");
  assert.equal(avatar.getAttribute("href"), "https://github.com/other-user");
  f.changeLogin("");
  assert.deepEqual(f.children, [f.logo]);
  f.changeLogin("example-user");
  f.toggle(false);
  assert.deepEqual(f.children, [f.logo]);
});

test("stored enabled preference mounts the shortcut and cleanup removes it", async () => {
  const f = fixture(true);
  await f.ready();
  assert.equal(f.children.length, 2);
  f.stop();
  assert.deepEqual(f.children, [f.logo]);
});

test("both settings surfaces and GitHub-wide manifest wiring are present", () => {
  for (const page of ["options.html", "popup.html"]) {
    assert.match(read(page), /id="show-github-profile-shortcut" type="checkbox"\s*\/>/);
  }
  const settings = read("js/settings/options.js");
  assert.match(settings, /showGithubProfileShortcut: false/);
  assert.match(settings, /showGithubProfileShortcut: showGithubProfileShortcutInput\.checked/);
  const manifest = JSON.parse(read("manifest.json"));
  const entry = manifest.content_scripts.find(entry => entry.js?.includes("js/github/profile-shortcut.js"));
  assert.deepEqual(entry.matches, ["https://github.com/*"]);
  assert.ok(entry.css.includes("css/github/profile-shortcut.css"));
});
