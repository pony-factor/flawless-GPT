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

test("overlay follows ChatGPT's live accent and surfaces, with independent composer overrides", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const root = document.documentElement;
      root.style.setProperty("--main-surface-primary", "#f3edf6");
      root.style.setProperty("--text-primary", "#243142");
      root.style.setProperty("--theme-submit-btn-bg", "#b14e88");
    });
    await drag(page, "dragenter");
    const palette = () => page.locator(".ghrc-file-drop-card").evaluate(card => {
      const icon = card.querySelector(".ghrc-file-drop-icon");
      return {
        background: getComputedStyle(card).backgroundColor,
        text: getComputedStyle(card).color,
        border: getComputedStyle(card).borderTopColor,
        icon: getComputedStyle(icon).color,
      };
    });
    assert.deepEqual(await palette(), {
      background: "rgb(243, 237, 246)",
      text: "rgb(36, 49, 66)",
      border: "rgb(177, 78, 136)",
      icon: "rgb(177, 78, 136)",
    });
    // Switching ChatGPT themes while dragging should update the existing card.
    await page.evaluate(() => {
      const root = document.documentElement;
      root.classList.add("dark");
      root.style.setProperty("--main-surface-primary", "#171b24");
      root.style.setProperty("--text-primary", "#e4e6ef");
      root.style.setProperty("--theme-submit-btn-bg", "#45a981");
    });
    assert.deepEqual(await palette(), {
      background: "rgb(23, 27, 36)",
      text: "rgb(228, 230, 239)",
      border: "rgb(69, 169, 129)",
      icon: "rgb(69, 169, 129)",
    });
    // Explicit composer colors override only the corresponding palette slots.
    await page.evaluate(() => {
      const root = document.documentElement;
      root.style.setProperty("--ghrc-composer-surface", "#302337");
      root.style.setProperty("--ghrc-composer-text", "#f5deff");
      root.style.setProperty("--ghrc-composer-surface-border", "#ee9a42");
    });
    assert.deepEqual(await palette(), {
      background: "rgb(48, 35, 55)",
      text: "rgb(245, 222, 255)",
      border: "rgb(238, 154, 66)",
      icon: "rgb(238, 154, 66)",
    });
    await page.evaluate(() => document.documentElement.style.setProperty("--ghrc-composer-focus-ring", "#8765dd"));
    assert.equal((await palette()).border, "rgb(135, 101, 221)");
    await page.evaluate(() => {
      const root = document.documentElement;
      for (const key of ["surface", "text", "surface-border", "focus-ring"]) {
        root.style.removeProperty(`--ghrc-composer-${key}`);
      }
    });
    assert.equal((await palette()).border, "rgb(69, 169, 129)");
    assert.equal((await palette()).background, "rgb(23, 27, 36)");
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