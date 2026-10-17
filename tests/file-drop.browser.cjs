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

async function fixture({ input = true, multiple = true, acknowledge = true } = {}) {
  const page = await browser.newPage();
  await page.setContent(
    '<form id="composer"><textarea id="prompt-textarea">Existing draft</textarea>' +
    (input ? '<input type="file" aria-label="Attach files" ' + (multiple ? "multiple" : "") + '>' : "") +
    '</form><p id="browser-default"></p>'
  );
  await page.evaluate(({ acknowledge }) => {
    window.uploaded = [];
    window.nativeDropEvents = [];
    window.__ghrcExtensionContext = {
      active: () => true,
      onStop: cleanup => { window.stopFileDrop = cleanup; },
      handleError: error => { throw error; },
    };
    document.querySelector('input[type="file"]')?.addEventListener("change", event => {
      window.uploaded.push(...[...event.target.files].map(file => file.name));
      if (!acknowledge) return;
      const surface = document.querySelector("[data-composer-attachments]")
        || document.getElementById("composer").appendChild(document.createElement("div"));
      surface.setAttribute("data-composer-attachments", "");
      for (const file of event.target.files) {
        const button = document.createElement("button");
        button.setAttribute("aria-label", "Remove file");
        button.textContent = file.name;
        surface.append(button);
      }
    });
    document.getElementById("prompt-textarea").addEventListener("drop", event => {
      window.nativeDropEvents.push(event.defaultPrevented);
      // Model browser default behavior after propagation, not inside the target handler.
      queueMicrotask(() => {
        if (!event.defaultPrevented) document.getElementById("browser-default").textContent = "link inserted";
      });
    });
  }, { acknowledge });
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
    assert.equal(await page.locator('[data-composer-attachments] button').count(), 2);
    assert.deepEqual(await page.evaluate(() => window.nativeDropEvents), []);
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

test("missing upload input yields to ChatGPT's native handler without browser navigation", async () => {
  const page = await fixture({ input: false });
  try {
    await page.evaluate(() => {
      document.getElementById("prompt-textarea").addEventListener("drop", event => {
        const surface = document.createElement("div");
        surface.setAttribute("data-composer-attachments", "");
        for (const file of event.dataTransfer.files) {
          const button = document.createElement("button");
          button.setAttribute("aria-label", "Remove file");
          button.textContent = file.name;
          surface.append(button);
        }
        document.getElementById("composer").append(surface);
      });
    });
    const drop = await drag(page, "drop");
    assert.equal(drop.prevented, true);
    assert.deepEqual(await page.evaluate(() => window.nativeDropEvents), [false]);
    assert.equal(await page.locator('[data-composer-attachments] button').count(), 1);
    assert.equal(await page.locator("#browser-default").textContent(), "");
    assert.equal(await page.locator("#prompt-textarea").inputValue(), "Existing draft");
  } finally { await page.close(); }
});

test("input disappearing after the overlay still allows a native drop", async () => {
  const page = await fixture();
  try {
    await drag(page, "dragenter");
    assert.equal(await page.locator("#ghrc-file-drop-overlay").isVisible(), true);
    await page.evaluate(() => {
      document.querySelector('input[type="file"]').remove();
      document.getElementById("prompt-textarea").addEventListener("drop", event => {
        const surface = document.createElement("div");
        surface.dataset.composerAttachments = "";
        const button = document.createElement("button");
        button.setAttribute("aria-label", "Remove file");
        button.textContent = event.dataTransfer.files[0].name;
        surface.append(button);
        document.getElementById("composer").append(surface);
      });
    });
    const drop = await drag(page, "drop");
    assert.equal(drop.prevented, true);
    assert.deepEqual(await page.evaluate(() => window.nativeDropEvents), [false]);
    assert.equal(await page.locator('[data-composer-attachments] button').count(), 1);
    assert.equal(await page.locator("#browser-default").textContent(), "");
  } finally { await page.close(); }
});

test("missing attachment acknowledgement shows a warning instead of claiming success", async () => {
  const page = await fixture({ acknowledge: false });
  try {
    const drop = await drag(page, "drop");
    assert.equal(drop.prevented, true);
    assert.deepEqual(await page.evaluate(() => window.uploaded), ["notes.txt"]);
    // Advance only the perceived deadline; retain real short timer callbacks.
    await page.evaluate(() => {
      const now = Date.now();
      Date.now = () => now + 13_000;
    });
    await page.locator('#ghrc-file-drop-overlay[data-ghrc-drop-error]').waitFor();
    assert.match(await page.locator(".ghrc-file-drop-title").textContent(), /not confirmed/i);
    assert.match(await page.locator(".ghrc-file-drop-detail").textContent(), /chip/);
  } finally { await page.close(); }
});

test("native drop without acknowledgement also warns rather than silently failing", async () => {
  const page = await fixture({ input: false });
  try {
    const drop = await drag(page, "drop");
    assert.equal(drop.prevented, true);
    assert.deepEqual(await page.evaluate(() => window.nativeDropEvents), [false]);
    await page.evaluate(() => {
      const now = Date.now();
      Date.now = () => now + 13_000;
    });
    await page.locator('#ghrc-file-drop-overlay[data-ghrc-drop-error]').waitFor();
    assert.match(await page.locator(".ghrc-file-drop-title").textContent(), /not confirmed/i);
    assert.equal(await page.locator("#browser-default").textContent(), "");
  } finally { await page.close(); }
});

test("single-file input yields multi-file drops to native handling without losing files", async () => {
  const page = await fixture({ multiple: false });
  try {
    const drop = await drag(page, "drop", ["a.txt", "b.txt"]);
    assert.equal(drop.prevented, true);
    assert.deepEqual(await page.evaluate(() => window.uploaded), []);
    assert.deepEqual(await page.evaluate(() => window.nativeDropEvents), [false]);
    assert.equal(await page.locator("#browser-default").textContent(), "");
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