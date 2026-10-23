const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require("playwright");

let browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    headless: true,
  });
});
after(async () => { await browser.close(); });

async function fixture({ enabled = true, existingChat = false } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://chatgpt.com/**", route => route.fulfill({
    contentType: "text/html",
    body: [
      "<!doctype html><html><head></head><body><main>",
      ...(existingChat ? [
        "<article data-message-author-role='user'>An earlier user message</article>",
        "<article data-message-author-role='assistant'>An earlier response</article>",
      ] : []),
      "<form id='chat'>",
      "<div data-composer-markdown id='prompt-textarea' contenteditable='true'>",
      "<p><span app-mention-path='app://connector_openai_deep_research' contenteditable='false'>Deep research</span> </p>",
      "<p>Reserch this subject carefuly</p></div>",
      "<button type='submit' data-testid='composer-submit-button'>Send</button>",
      "</form></main></body></html>",
    ].join(""),
  }));
  await page.goto(existingChat
    ? "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc"
    : "https://chatgpt.com/");
  await page.evaluate((enabled) => {
    window.spellcheckPreference = enabled;
    window.storageListeners = [];
    window.setSpellcheckEnabled = next => {
      const previous = window.spellcheckPreference;
      window.spellcheckPreference = next;
      const changes = { deepResearchSpellcheckEnabled: { oldValue: previous, newValue: next } };
      for (const listener of [...window.storageListeners]) listener(changes, "local");
    };
    window.requests = [];
    window.sent = 0;
    window.listeners = [];
    document.querySelector("form").addEventListener("submit", event => {
      event.preventDefault();
      window.sent++;
    });
    window.chrome = {
      runtime: {
        id: "fixture",
        onMessage: { addListener(fn) { window.listeners.push(fn); } },
        async sendMessage(message) {
          window.requests.push(message);
          if (message.type === "ghrc-research-spellcheck-claim") return { ok: true, job: null };
          if (message.type === "ghrc-research-spellcheck-begin") return { ok: true, id: "job-one" };
          return { ok: true };
        },
      },
      storage: {
        local: { get: async defaults => ({ ...defaults, deepResearchSpellcheckEnabled: window.spellcheckPreference }) },
        onChanged: {
          addListener(fn) { window.storageListeners.push(fn); },
          removeListener(fn) { window.storageListeners = window.storageListeners.filter(listener => listener !== fn); },
        },
      },
    };
  }, enabled);
  for (const path of ["js/core/extension-context.js", "js/research/deep-research-spellcheck.js"])
    await page.addScriptTag({ content: fs.readFileSync(path, "utf8") });
  return { page, errors };
}

test("Enter defers Deep Research, applies Spellcheck result and requires a deliberate Go", async () => {
  const { page, errors } = await fixture();
  await page.locator("#prompt-textarea").click();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => requests.some(message => message.type === "ghrc-research-spellcheck-begin"));
  assert.equal(await page.evaluate(() => sent), 0);
  const prompt = await page.evaluate(() =>
    requests.find(message => message.type === "ghrc-research-spellcheck-begin").prompt);
  assert.equal(prompt, "Reserch this subject carefuly");
  await page.evaluate(async () => {
    window.applied = await new Promise(resolve => {
      listeners.find(fn => fn({
        type: "ghrc-research-spellcheck-apply", id: "job-one",
        original: "Reserch this subject carefuly", corrected: "Research this subject carefully.",
      }, {}, resolve));
    });
  });
  assert.equal(await page.evaluate(() => applied.ok), true);
  assert.equal(await page.locator('[app-mention-path="app://connector_openai_deep_research"]').count(), 1);
  assert.match(await page.locator("#prompt-textarea").innerText(), /Research this subject carefully\./);
  assert.equal(await page.evaluate(() => sent), 0);
  await page.getByRole("button", { name: "Send reviewed Deep Research prompt" }).click();
  assert.equal(await page.evaluate(() => sent), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test("changed source draft cannot be replaced or submitted by a stale result", async () => {
  const { page, errors } = await fixture();
  await page.locator("#prompt-textarea").click();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => requests.some(message => message.type === "ghrc-research-spellcheck-begin"));
  await page.locator("#prompt-textarea > p").last().evaluate(node => { node.textContent = "User edited the original prompt"; });
  await page.evaluate(async () => {
    window.applied = await new Promise(resolve => listeners.find(fn => fn({
      type: "ghrc-research-spellcheck-apply", id: "job-one",
      original: "Reserch this subject carefuly", corrected: "Research this subject carefully.",
    }, {}, resolve)));
  });
  assert.equal(await page.evaluate(() => applied.ok), false);
  assert.match(await page.locator("#prompt-textarea").innerText(), /User edited the original prompt/);
  assert.equal(await page.evaluate(() => sent), 0);
  assert.deepEqual(errors, []);
  await page.close();
});
test("disabling spellcheck restores normal Send and it can be re-enabled live", async () => {
  const { page, errors } = await fixture({ enabled: false });
  await page.getByRole("button", { name: "Send" }).click();
  assert.equal(await page.evaluate(() => sent), 1);
  assert.equal(await page.evaluate(() => requests.length), 0);
  await page.evaluate(() => setSpellcheckEnabled(true));
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForFunction(() => requests.some(message => message.type === "ghrc-research-spellcheck-begin"));
  assert.equal(await page.evaluate(() => sent), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test("disabling a pending spellcheck rejects stale corrections and allows Send", async () => {
  const { page, errors } = await fixture();
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForFunction(() => requests.some(message => message.type === "ghrc-research-spellcheck-begin"));
  await page.evaluate(() => setSpellcheckEnabled(false));
  await page.evaluate(async () => {
    window.applied = await new Promise(resolve => listeners.find(fn => fn({
      type: "ghrc-research-spellcheck-apply", id: "job-one",
      original: "Reserch this subject carefuly", corrected: "Research this subject carefully.",
    }, {}, resolve)));
  });
  assert.equal(await page.evaluate(() => applied.ok), false);
  assert.match(await page.locator("#prompt-textarea").innerText(), /Reserch this subject carefuly/);
  assert.equal(await page.getByRole("button", { name: "Send reviewed Deep Research prompt" }).count(), 0);
  await page.getByRole("button", { name: "Send" }).click();
  assert.equal(await page.evaluate(() => sent), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test("existing chat preserves conversation history and requires Go for the corrected research prompt", async () => {
  const { page, errors } = await fixture({ existingChat: true });
  const messages = await page.locator("[data-message-author-role]").allTextContents();
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForFunction(() => requests.some(message => message.type === "ghrc-research-spellcheck-begin"));
  const request = await page.evaluate(() =>
    requests.find(message => message.type === "ghrc-research-spellcheck-begin"));
  assert.equal(request.sourcePath, "/c/12345678-1234-1234-1234-123456789abc");
  assert.equal(await page.evaluate(() => sent), 0);
  await page.evaluate(async () => {
    window.applied = await new Promise(resolve => listeners.find(fn => fn({
      type: "ghrc-research-spellcheck-apply", id: "job-one",
      original: "Reserch this subject carefuly", corrected: "Research this subject carefully.",
    }, {}, resolve)));
  });
  assert.equal(await page.evaluate(() => applied.ok), true);
  assert.deepEqual(await page.locator("[data-message-author-role]").allTextContents(), messages);
  assert.equal(await page.evaluate(() => sent), 0);
  await page.getByRole("button", { name: "Send reviewed Deep Research prompt" }).click();
  assert.equal(await page.evaluate(() => sent), 1);
  assert.equal(new URL(page.url()).pathname, "/c/12345678-1234-1234-1234-123456789abc");
  assert.deepEqual(errors, []);
  await page.close();
});

test("switching existing chats during spellcheck preserves the current conversation draft", async () => {
  const { page, errors } = await fixture({ existingChat: true });
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForFunction(() => requests.some(message => message.type === "ghrc-research-spellcheck-begin"));
  await page.evaluate(() => history.pushState({}, "", "/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
  await page.evaluate(async () => {
    window.applied = await new Promise(resolve => listeners.find(fn => fn({
      type: "ghrc-research-spellcheck-apply", id: "job-one",
      original: "Reserch this subject carefuly", corrected: "Research this subject carefully.",
    }, {}, resolve)));
  });
  assert.equal(await page.evaluate(() => applied.ok), false);
  assert.match(await page.locator("#prompt-textarea").innerText(), /Reserch this subject carefuly/);
  assert.equal(await page.evaluate(() => sent), 0);
  assert.deepEqual(errors, []);
  await page.close();
});
