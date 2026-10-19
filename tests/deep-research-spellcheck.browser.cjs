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

async function fixture() {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://chatgpt.com/**", route => route.fulfill({
    contentType: "text/html",
    body: [
      "<!doctype html><html><head></head><body><main><form id='chat'>",
      "<div data-composer-markdown id='prompt-textarea' contenteditable='true'>",
      "<p><span app-mention-path='app://connector_openai_deep_research' contenteditable='false'>Deep research</span> </p>",
      "<p>Reserch this subject carefuly</p></div>",
      "<button type='submit' data-testid='composer-submit-button'>Send</button>",
      "</form></main></body></html>",
    ].join(""),
  }));
  await page.goto("https://chatgpt.com/");
  await page.evaluate(() => {
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
      storage: { local: {} },
    };
  });
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