const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

test("upgrade promotions are hidden by default, detected when inserted, and restored live", async () => {
  const browser = await chromium.launch({ executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><article data-message-author-role="assistant" id="answer"><p>GPT-6 Astra is built for work like this</p><button>Upgrade to Pro</button></article><div id="promotions"></div><form id="composer"><textarea></textarea></form></main>');
    await page.evaluate(() => {
      window.settingListeners = [];
      window.chrome = {
        storage: {
          local: { get: async defaults => defaults },
          onChanged: { addListener: listener => settingListeners.push(listener) },
        },
      };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, "../js/chat/hide-upgrade-promotions.js"), "utf8") });
    await page.evaluate(() => {
      document.getElementById("promotions").innerHTML =
        '<aside id="promo"><div><strong>GPT-6 Astra is built for work like this</strong><p>Upgrade to Pro for more of Astra’s stronger judgment, deeper context, and more polished results.</p><button>Upgrade to Pro</button></div><button aria-label="Close">×</button></aside>';
    });
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#promo")).display === "none");
    assert.equal(await page.locator("#answer").isVisible(), true);
    assert.equal(await page.locator("#composer").isVisible(), true);
    await page.evaluate(() => settingListeners.forEach(listener => listener({ hideUpgradePromotions: { newValue: false } }, "local")));
    assert.equal(await page.locator("#promo").isVisible(), true);
    await page.evaluate(() => settingListeners.forEach(listener => listener({ hideUpgradePromotions: { newValue: true } }, "local")));
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#promo")).display === "none");
    await page.evaluate(() => {
      document.getElementById("promo").innerHTML = "<p>A regular application notice.</p>";
    });
    await page.waitForFunction(() => !document.querySelector("#promo").hasAttribute("data-ghrc-upgrade-promotion"));
    assert.equal(await page.locator("#promo").isVisible(), true, "reused banner containers must not remain hidden");
  } finally {
    await browser.close();
  }
});
