// Browser fixture only; no real upload request or ChatGPT message is sent.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

let browser;
const source = fs.readFileSync(path.join(__dirname, "../js/composer/file-drop.js"), "utf8");
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
      // An intercepted drop may be followed by a file-free UI cleanup event.
      // Only real file drops should count as native attachment attempts.
      if (!event.dataTransfer?.files?.length) return;
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
    for (const name of names) transfer.items.add(new File(["notes"], name, {
      type: name.endsWith(".png") ? "image/png" : "text/plain",
    }));
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
    // Flawless no longer swallows native dragenter before knowing the drop can attach.
    assert.equal(enter.prevented, false);
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

test("intercepted image drops release ChatGPT's click-through native drag overlay", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const veil = document.createElement("div");
      veil.id = "native-drop-veil";
      veil.textContent = "Add anything";
      veil.hidden = true;
      veil.style.cssText = "position:fixed;inset:0;pointer-events:none;background:rgba(0,0,0,.25)";
      document.body.append(veil);
      window.nativeCleanupDrops = [];
      // Model ChatGPT's own drag UI: a native document-level handler sees
      // dragenter, but a Flawless-consumed file drop never reaches it.
      document.addEventListener("dragenter", event => {
        if (Array.from(event.dataTransfer?.types || []).includes("Files")) veil.hidden = false;
      });
      document.addEventListener("drop", event => {
        window.nativeCleanupDrops.push(event.dataTransfer?.files?.length ?? -1);
        veil.hidden = true;
      });
    });
    await drag(page, "dragenter", ["photo.png"]);
    assert.equal(await page.locator("#native-drop-veil").isVisible(), true);
    const dropped = await drag(page, "drop", ["photo.png"]);
    assert.equal(dropped.prevented, true);
    assert.deepEqual(await page.evaluate(() => window.uploaded), ["photo.png"]);
    assert.equal(await page.locator('[data-composer-attachments] button').count(), 1);
    assert.equal(await page.locator("#native-drop-veil").isVisible(), false);
    assert.deepEqual(await page.evaluate(() => window.nativeCleanupDrops), [0]);
    assert.deepEqual(await page.evaluate(() => window.nativeDropEvents), []);
    assert.equal(await page.locator("#browser-default").textContent(), "");
  } finally { await page.close(); }
});

test("native file-drag UI receives a viewport exit with the original transfer", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.nativeDragging = false;
      window.nativeExitFiles = [];
      document.getElementById("composer").addEventListener("dragenter", event => {
        if (event.dataTransfer.types.includes("Files")) window.nativeDragging = true;
      });
      // Ignore file-free drop/dragend cleanup, as file-filtered native handlers do.
      document.getElementById("composer").addEventListener("dragleave", event => {
        if (!event.dataTransfer.types.includes("Files")) return;
        if (event.relatedTarget || event.clientX || event.clientY) return;
        window.nativeExitFiles = [...event.dataTransfer.files].map(file => file.name);
        window.nativeDragging = false;
      });
    });
    await drag(page, "dragenter", ["photo.png"]);
    assert.equal(await page.evaluate(() => window.nativeDragging), true);
    await drag(page, "drop", ["photo.png"]);
    assert.equal(await page.evaluate(() => window.nativeDragging), false);
    assert.deepEqual(await page.evaluate(() => window.nativeExitFiles), ["photo.png"]);
    assert.deepEqual(await page.evaluate(() => window.uploaded), ["photo.png"]);
    assert.deepEqual(await page.evaluate(() => window.nativeDropEvents), []);
    assert.equal(await page.locator('[data-composer-attachments] button').count(), 1);
  } finally { await page.close(); }
});

test("native cleanup still bubbles when the upload replaces the original drop target", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.nativeCleanup = [];
      document.getElementById("composer").addEventListener("drop", event => {
        window.nativeCleanup.push(event.dataTransfer.files.length);
      });
      document.querySelector('input[type="file"]').addEventListener("change", () => {
        document.getElementById("prompt-textarea").remove();
      });
    });
    await drag(page, "drop", ["photo.png"]);
    assert.deepEqual(await page.evaluate(() => window.uploaded), ["photo.png"]);
    assert.deepEqual(await page.evaluate(() => window.nativeCleanup), [0]);
    assert.equal(await page.locator('[data-composer-attachments] button').count(), 1);
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
    // Current ChatGPT exposes its accent through app tokens; the old submit
    // token can be absent or neutral even with a colorful active theme.
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--app-color-icon-accent", "#48a04c");
      document.documentElement.style.setProperty("--theme-submit-btn-bg", "#ffffff");
    });
    assert.equal((await palette()).border, "rgb(72, 160, 76)");
    assert.equal((await palette()).icon, "rgb(72, 160, 76)");
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
