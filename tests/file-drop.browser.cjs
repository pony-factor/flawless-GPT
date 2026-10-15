// Browser fixture only; no real upload request or ChatGPT message is sent.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

let browser;
const source = fs.readFileSync(path.join(__dirname, "../js/file-drop.js"), "utf8");
const style = fs.readFileSync(path.join(__dirname, "../css/file-drop.css"), "utf8");

before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    headless: true,
  });
});
after(async () => { await browser?.close(); });

async function fixture({ input = true, multiple = true } = {}) {
  const page = await browser.newPage();
  await page.setContent(
    '<form id="composer"><textarea id="prompt-textarea">Existing draft</textarea>' +
    (input ? '<input type="file" aria-label="Attach files" ' + (multiple ? "multiple" : "") + '>' : "") +
    '</form><p id="browser-default"></p>'
  );
  await page.evaluate(() => {
    window.uploaded = [];
    window.__ghrcExtensionContext = {
      active: () => true,
      onStop: cleanup => { window.stopFileDrop = cleanup; },
      handleError: error => { throw error; },
    };
    document.querySelector('input[type="file"]')?.addEventListener("change", event => {
      window.uploaded.push(...[...event.target.files].map(file => file.name));
    });
    document.getElementById("prompt-textarea").addEventListener("drop", event => {
      if (!event.defaultPrevented) document.getElementById("browser-default").textContent = "link inserted";
    });
  });
  await page.addStyleTag({ content: style });
  await page.addScriptTag({ content: source });
  return page;
}

async function drag(page, type, names = ["notes.txt"]) {
  return page.evaluate(({ type, names }) => {
    const transfer = new DataTransfer();
    for (const name of names) transfer.items.add(new File(["notes"], name, { type: "text/plain" }));
    const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
    document.querySelector("#prompt-textarea").dispatchEvent(event);
    return { prevented: event.defaultPrevented, effect: transfer.dropEffect };
  }, { type, names });
}

test("themed overlay appears and native change attaches multiple files without changing draft", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--ghrc-composer-focus-ring", "#123abc");
      document.documentElement.style.setProperty("--ghrc-composer-surface", "#142536");
    });
    const enter = await drag(page, "dragenter");
    assert.equal(enter.prevented, true);
    assert.equal(await page.locator("#ghrc-file-drop-overlay").isVisible(), true);
    assert.equal(
      await page.locator(".ghrc-file-drop-card").evaluate(el => getComputedStyle(el).borderTopColor),
      "rgb(18, 58, 188)"
    );
    const result = await drag(page, "drop", ["one.txt", "two.txt"]);
    assert.equal(result.prevented, true);
    assert.deepEqual(await page.evaluate(() => window.uploaded), ["one.txt", "two.txt"]);
    assert.equal(await page.locator("#prompt-textarea").inputValue(), "Existing draft");
    assert.equal(await page.locator("#browser-default").textContent(), "");
    assert.equal(await page.locator("#ghrc-file-drop-overlay").isVisible(), false);
  } finally { await page.close(); }
});

test("text/link drags are left to the page", async () => {
  const page = await fixture();
  try {
    const prevented = await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.setData("text/uri-list", "https://example.com/");
      const event = new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer });
      document.getElementById("prompt-textarea").dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(prevented, false);
    assert.equal(await page.locator("#ghrc-file-drop-overlay").count(), 0);
  } finally { await page.close(); }
});

test("missing upload control blocks file link and explains + fallback", async () => {
  const page = await fixture({ input: false });
  try {
    const drop = await drag(page, "drop");
    assert.equal(drop.prevented, true);
    assert.equal(await page.locator("#ghrc-file-drop-overlay").isVisible(), true);
    assert.match(await page.locator(".ghrc-file-drop-detail").textContent(), /\+ button/);
    assert.equal(await page.locator("#browser-default").textContent(), "");
  } finally { await page.close(); }
});

test("single-file control refuses multi-file drop rather than losing files", async () => {
  const page = await fixture({ multiple: false });
  try {
    const drop = await drag(page, "drop", ["a.txt", "b.txt"]);
    assert.equal(drop.prevented, true);
    assert.deepEqual(await page.evaluate(() => window.uploaded), []);
    assert.match(await page.locator(".ghrc-file-drop-detail").textContent(), /one file/);
  } finally { await page.close(); }
});

test("escape and extension shutdown remove the overlay and listeners", async () => {
  const page = await fixture();
  try {
    await drag(page, "dragenter");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#ghrc-file-drop-overlay").isVisible(), false);
    await drag(page, "dragenter");
    await page.evaluate(() => window.stopFileDrop());
    assert.equal(await page.locator("#ghrc-file-drop-overlay").count(), 0);
    const result = await drag(page, "drop");
    assert.equal(result.prevented, false);
  } finally { await page.close(); }
});