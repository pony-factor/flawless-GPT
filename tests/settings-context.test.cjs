const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { TextEncoder, TextDecoder } = require("node:util");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

for (const page of ["options.html", "popup.html"]) {
  for (const mode of ["missing-storage", "missing-runtime"]) {
    test(`${page} handles ${mode} without starting storage-dependent controls`, async () => {
      const html = read(page);
      const dom = new JSDOM(html, { url: "https://extension.test/", runScripts: "outside-only" });
      try {
        const { window } = dom;
        window.TextEncoder = TextEncoder;
        window.TextDecoder = TextDecoder;
        let calls = 0;
        window.chrome = mode === "missing-storage"
          ? { runtime: { id: "fixture" } }
          : { storage: { local: { get() { calls++; throw new Error("Unexpected storage access"); } }, onChanged: {} } };
        const scripts = [...window.document.querySelectorAll("script[src]")].map(node => node.getAttribute("src"));
        assert.equal(scripts[0], "js/settings/context.js");
        for (const script of scripts) window.eval(read(script));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(calls, 0);
        assert.equal(window.document.querySelector("main").inert, true);
        assert.match(window.document.getElementById("settings-context-notice").textContent, /reopen settings/);
        assert.equal(window.__ghrcSettingsContext.active(), false);
        assert.equal(window.document.querySelectorAll("#settings-context-notice").length, 1);
      } finally {
        dom.window.close();
      }
    });
  }
}

test("settings context stays active until reload and blocks later interactions", () => {
  const dom = new JSDOM("<main><button>Save</button></main>", { runScripts: "outside-only" });
  try {
    const { window } = dom;
    window.chrome = { runtime: { id: "fixture" }, storage: { local: {}, onChanged: {} } };
    window.eval(read("js/settings/context.js"));
    assert.equal(window.__ghrcSettingsContext.active(), true);
    assert.equal(window.document.getElementById("settings-context-notice"), null);
    const button = window.document.querySelector("button");
    let clicks = 0;
    button.addEventListener("click", () => clicks++);
    button.click();
    assert.equal(clicks, 1);
    window.chrome.storage = undefined;
    button.click();
    assert.equal(clicks, 1);
    assert.equal(window.__ghrcSettingsContext.active(), false);
    assert.equal(window.document.querySelector("main").inert, true);
  } finally {
    dom.window.close();
  }
});

test("a pending invalidation rejection marks the settings page unavailable", () => {
  const dom = new JSDOM("<main></main>", { runScripts: "outside-only" });
  try {
    const { window } = dom;
    window.chrome = { runtime: { id: "fixture" }, storage: { local: {}, onChanged: {} } };
    window.eval(read("js/settings/context.js"));
    window.__ghrcSettingsContext.report(new Error("Extension context invalidated."));
    assert.equal(window.__ghrcSettingsContext.active(), false);
    assert.ok(window.document.getElementById("settings-context-notice"));
  } finally {
    dom.window.close();
  }
});
