const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const source = fs.readFileSync(path.join(__dirname, "../js/chat/hide-scheduled-recommendations.js"), "utf8");
const html = '<main><section id="active"><h2>Active</h2><article>My real scheduled task</article></section><div id="slot"></div></main>';
const suggestions = '<section id="recommended"><div><button aria-label="Recommended"><span>Recommended</span><svg></svg></button></div>'
  + '<div class="suggestion"><strong>Sweetiebot-SCM reliability alerts</strong><p>Notify me when Sweetiebot-SCM changes background commits.</p><button aria-label="Add task">+</button></div>'
  + '<div class="suggestion"><strong>Cross-extension spellcheck alerts</strong><p>Let me know about new Flawless-GPT and Fractured-GH changes.</p><button aria-label="Add task">+</button></div></section>';

test("hides only scheduled recommendations; updates when toggled or replaced", async () => {
  const browser = await chromium.launch({ executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    await page.goto("https://chatgpt.com/scheduled");
    await page.evaluate(() => {
      window.settingListeners = [];
      window.chrome = { storage: {
        local: { get: async (defaults) => defaults },
        onChanged: { addListener: (callback) => settingListeners.push(callback) },
      } };
    });
    await page.addScriptTag({ content: source });
    await page.evaluate((markup) => { document.querySelector("#slot").innerHTML = markup; }, suggestions);
    await page.waitForFunction(() => document.querySelector("#recommended")?.hasAttribute("data-ghrc-scheduled-recommendations"));
    assert.equal(await page.locator("#recommended").isVisible(), false);
    assert.equal(await page.locator("#active").isVisible(), true);
    await page.evaluate(() => settingListeners.forEach((callback) => callback({ hideScheduledRecommendations: { newValue: false } }, "local")));
    await page.waitForFunction(() => !document.querySelector("#recommended").hasAttribute("data-ghrc-scheduled-recommendations"));
    assert.equal(await page.locator("#recommended").isVisible(), true);
    await page.evaluate(() => settingListeners.forEach((callback) => callback({ hideScheduledRecommendations: { newValue: true } }, "local")));
    await page.waitForFunction(() => document.querySelector("#recommended").hasAttribute("data-ghrc-scheduled-recommendations"));
    await page.evaluate(() => { document.querySelector("#slot").innerHTML = "<p>There are no recommendations.</p>"; });
    assert.equal(await page.locator("#active").isVisible(), true);
  } finally {
    await browser.close();
  }
});
