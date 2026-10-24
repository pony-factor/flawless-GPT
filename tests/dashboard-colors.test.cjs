const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "js/dashboard/dashboard-colors.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "css/styles.css"), "utf8");

function element() {
  const listeners = new Map();
  return {
    children: [],
    attributes: {},
    hidden: false,
    append(...items) { this.children.push(...items); },
    addEventListener(name, fn) { listeners.set(name, fn); },
    emit(name, event = {}) { listeners.get(name)?.(event); },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("HEX values save and defaults restore independently", async () => {
  const panel = element(), grid = element(), reset = element();
  const writes = [];
  const chrome = { storage: {
    local: {
      get: async () => ({ dashboardColors: { accentLight: "#AABBCC" } }),
      set: async values => { writes.push(values.dashboardColors); },
    },
    onChanged: { addListener() {} },
  } };
  const document = {
    getElementById(id) { return {
      "dashboard-color-settings": panel, "dashboard-color-grid": grid,
      "dashboard-color-reset": reset,
    }[id] || null; },
    createElement: element,
  };
  vm.runInNewContext(source, { document, chrome, Promise });
  await tick();
  assert.equal(grid.children.length, 4);
  const [accentPicker, accentHex, accentDefault] = grid.children[0].children[1].children;
  const [linkPicker, linkHex, linkDefault] = grid.children[2].children[1].children;
  assert.equal(accentHex.value, "#aabbcc");
  assert.equal(accentDefault.hidden, false);
  assert.equal(linkDefault.hidden, true);
  assert.equal(linkHex.value, "#0969da");
  linkHex.value = "CC33AA";
  linkHex.emit("input");
  await tick();
  assert.equal(linkPicker.value, "#cc33aa");
  assert.equal(writes.at(-1).repositoryLight, "#cc33aa");
  const beforeInvalid = writes.length;
  linkHex.value = "#nothex";
  linkHex.emit("input");
  assert.equal(linkHex.attributes["aria-invalid"], "true");
  await tick();
  assert.equal(writes.length, beforeInvalid);
  linkHex.emit("change");
  assert.equal(linkHex.value, "#cc33aa");
  linkDefault.emit("click");
  await tick();
  assert.equal(linkDefault.hidden, true);
  assert.equal(writes.at(-1).repositoryLight, undefined);
  reset.emit("click");
  await tick();
  assert.equal(Object.keys(writes.at(-1)).length, 0);
  assert.equal(accentPicker.value, "#0969da");
  assert.equal(reset.disabled, true);
  let stopped = false;
  panel.emit("change", { stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
});

test("content-script overrides apply live and clean up", async () => {
  const values = new Map();
  let listener, stop;
  const document = {
    getElementById: () => null,
    documentElement: { style: {
      setProperty(name, value) { values.set(name, value); },
      removeProperty(name) { values.delete(name); },
    } },
  };
  const context = {
    active: () => true,
    onStop(fn) { stop = fn; },
    run(fn) { return fn(); },
  };
  const chrome = { storage: {
    local: { get: async () => ({ dashboardColors: {
      accentLight: "#aabbcc", repositoryDark: "#112233", accentDark: "invalid",
    } }) },
    onChanged: {
      addListener(fn) { listener = fn; },
      removeListener(fn) { assert.equal(fn, listener); },
    },
  } };
  vm.runInNewContext(source, { document, chrome, __ghrcExtensionContext: context });
  await tick();
  assert.equal(values.get("--ghrc-dashboard-accent-light"), "#aabbcc");
  assert.equal(values.get("--ghrc-dashboard-link-dark"), "#112233");
  assert.equal(values.has("--ghrc-dashboard-accent-dark"), false);
  listener({ dashboardColors: { newValue: { repositoryLight: "#abcdef" } } }, "local");
  assert.equal(values.get("--ghrc-dashboard-link-light"), "#abcdef");
  assert.equal(values.has("--ghrc-dashboard-accent-light"), false);
  stop();
  assert.equal(values.size, 0);
});

test("both settings surfaces expose HEX color controls and default theme colors", () => {
  for (const page of ["options.html", "popup.html"]) {
    const html = fs.readFileSync(path.join(root, page), "utf8");
    assert.match(html, /id="dashboard-color-settings"/);
    assert.match(html, /id="dashboard-color-grid"/);
    assert.match(html, /src="js\/dashboard\/dashboard-colors\.js"/);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.ok(manifest.content_scripts.some(entry => entry.js?.includes("js/dashboard/dashboard-colors.js")));
  assert.match(styles, /--ghrc-dashboard-accent-light, #0969da/);
  assert.match(styles, /--ghrc-dashboard-accent-dark, #4493f8/);
  assert.match(styles, /--ghrc-dashboard-link-light, var\(--ghrc-accent\)/);
  assert.match(styles, /--ghrc-dashboard-link-dark, var\(--ghrc-accent\)/);
  assert.match(styles, /\.ghrc-repository-name\s*\{\s*color: var\(--ghrc-repository-name-color\)/);
});
