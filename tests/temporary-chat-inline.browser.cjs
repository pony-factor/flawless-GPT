// Browser fixture only: clicks a simulated native Temporary Chat control,
// never sends a message to ChatGPT.
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

async function fixture(native = true) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://chatgpt.com/**", route => route.fulfill({
    contentType: "text/html",
    body: '<header>' + (native
      ? '<button type="button" id="native-temp" aria-label="Temporary chat">Temporary</button>'
      : "") + '</header><main><form><textarea id="prompt-textarea">Draft stays intact</textarea><button type="button" id="ghrc-message-queue-button">Queue</button><button type="button" id="ghrc-clipboard-send-button">Clipboard</button><button type="button" id="send">Send</button></form></main>',
  }));
  await page.goto("https://chatgpt.com/");
  await page.evaluate(() => {
    window.nativeClicks = 0;
    document.getElementById("native-temp")?.addEventListener("click", () => window.nativeClicks++);
    window.__ghrcExtensionContext = {
      active: () => true, onStop: () => {}, handleError: error => { throw error; },
    };
    window.__ghrcMessageQueue = {
      findComposerInput: () => document.getElementById("prompt-textarea"),
      findActionButton: () => document.getElementById("send"),
    };
  });
  await page.addStyleTag({ content: read("css/temporary-chat-inline.css") });
  await page.addScriptTag({ content: read("js/temporary-chat-inline.js") });
  return { page, errors };
}

test("places a working Temporary control in the composer without submitting the draft", async () => {
  const { page, errors } = await fixture();
  try {
    await page.waitForSelector("#ghrc-temporary-chat-inline");
    assert.deepEqual(await page.locator("form > button").evaluateAll(nodes => nodes.map(n => n.id)), [
      "ghrc-temporary-chat-inline", "ghrc-message-queue-button", "ghrc-clipboard-send-button", "send",
    ]);
    assert.equal(await page.locator("#native-temp").evaluate(el => getComputedStyle(el).display), "none");
    await page.getByRole("button", { name: "Start a temporary chat" }).click();
    assert.equal(await page.evaluate(() => window.nativeClicks), 1);
    assert.equal(await page.locator("#prompt-textarea").inputValue(), "Draft stays intact");
    await page.evaluate(() => document.getElementById("native-temp").setAttribute("aria-pressed", "true"));
    await page.waitForFunction(() => document.getElementById("ghrc-temporary-chat-inline")?.getAttribute("aria-pressed") === "true");
    assert.equal(await page.getByRole("button", { name: "Temporary chat active" }).count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("rebinds to a replaced native control and clears itself on other routes", async () => {
  const { page, errors } = await fixture();
  try {
    await page.waitForSelector("#ghrc-temporary-chat-inline");
    await page.evaluate(() => {
      const old = document.getElementById("native-temp");
      const replacement = old.cloneNode(true);
      replacement.addEventListener("click", () => window.nativeClicks += 10);
      old.replaceWith(replacement);
    });
    await page.waitForFunction(() => document.getElementById("native-temp")?.hasAttribute("data-ghrc-temporary-chat-native"));
    await page.locator("#ghrc-temporary-chat-inline").click();
    assert.equal(await page.evaluate(() => window.nativeClicks), 10);

    await page.evaluate(() => {
      history.pushState({}, "", "/c/existing");
      dispatchEvent(new Event("ghrc:route-change"));
    });
    await page.waitForFunction(() => !document.getElementById("ghrc-temporary-chat-inline"));
    assert.equal(await page.locator("#native-temp").evaluate(el => getComputedStyle(el).display !== "none"), true);
    await page.evaluate(() => {
      history.pushState({}, "", "/");
      dispatchEvent(new Event("ghrc:route-change"));
    });
    await page.waitForSelector("#ghrc-temporary-chat-inline");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("does not invent Temporary Chat when ChatGPT provides no native action", async () => {
  const { page, errors } = await fixture(false);
  try {
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#ghrc-temporary-chat-inline").count(), 0);
    assert.equal(await page.locator("html[data-ghrc-temporary-chat-inline-ready]").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
