// Browser fixture for the manual Search UI preference. Never sends any prompt.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
let browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    headless: true,
  });
});
after(async () => { await browser?.close(); });

async function fixture(disabled) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://chatgpt.com/**", route => route.fulfill({
    contentType: "text/html",
    body: '<header><button id="sidebar-search">Search</button></header><main><form><button id="tool-search" aria-pressed="true">Search the web</button><button id="send">Send</button></form><div role="menu"><button id="menu-search" role="menuitem">Search</button><button id="other" role="menuitem">Deep research</button></div></main>',
  }));
  await page.goto("https://chatgpt.com/");
  await page.evaluate(value => {
    window.searchClicks = 0;
    window.listeners = [];
    const tool = document.getElementById("tool-search");
    tool.addEventListener("click", () => {
      window.searchClicks++;
      tool.setAttribute("aria-pressed", tool.getAttribute("aria-pressed") === "true" ? "false" : "true");
    });
    window.chrome = {
      storage: {
        local: { get: async () => ({ disableManualWebSearch: value }) },
        onChanged: {
          addListener: handler => window.listeners.push(handler),
          removeListener: handler => { window.listeners = window.listeners.filter(fn => fn !== handler); },
        },
      },
    };
    window.__ghrcExtensionContext = { active: () => true, onStop: () => {} };
  }, disabled);
  await page.addStyleTag({ content: read("css/disable-manual-web-search.css") });
  await page.addScriptTag({ content: read("js/disable-manual-web-search.js") });
  return { page, errors };
}

test("disables only manual Search controls, releases selected Search, and restores on change", async () => {
  const { page, errors } = await fixture(true);
  try {
    await page.waitForFunction(() => document.getElementById("tool-search").getAttribute("aria-pressed") === "false");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("menu-search")).display === "none");
    assert.equal(await page.evaluate(() => window.searchClicks), 1);
    assert.equal(await page.locator("#sidebar-search").isVisible(), true);
    assert.equal(await page.locator("#other").isVisible(), true);
    await page.evaluate(() => window.listeners.forEach(fn => fn({ disableManualWebSearch: { newValue: false } }, "local")));
    assert.equal(await page.locator("#menu-search").isVisible(), true);
    assert.equal(await page.locator("#tool-search").isVisible(), true);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("keeps native manual Search intact by default", async () => {
  const { page, errors } = await fixture(false);
  try {
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#tool-search").isVisible(), true);
    assert.equal(await page.evaluate(() => window.searchClicks), 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
