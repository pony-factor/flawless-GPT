const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('hides split and spaced usage percentages, preserves chat text, and restores on disable', async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><p id="message">5% usage remaining</p></main><aside id="cards"></aside>');
    await page.evaluate(() => {
      window.listeners = [];
      window.chrome = { storage: {
        local: { get: async defaults => defaults },
        onChanged: { addListener: listener => listeners.push(listener) },
      } };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../js/hide-usage-card.js'), 'utf8') });
    for (const [index, percentage] of ['5%', '5 %', '<span>5</span><span>%</span>'].entries()) {
      await page.evaluate(({ index, percentage }) => {
        document.getElementById('cards').insertAdjacentHTML('beforeend', `<section id="card-${index}"><button>${percentage}<span>usage remaining</span></button><p>Weekly 5% remaining</p><button>Add credits</button><button>Upgrade</button></section>`);
      }, { index, percentage });
      await page.waitForFunction(id => getComputedStyle(document.getElementById(id)).display === 'none', `card-${index}`);
    }
    assert.equal(await page.locator('#message').isVisible(), true);
    assert.equal(await page.locator('#cards').isVisible(), false);
    await page.evaluate(() => listeners.forEach(listener => listener({ hideUsageCard: { newValue: false } }, 'local')));
    assert.equal(await page.locator('#card-0').isVisible(), true);
    assert.equal(await page.locator('#card-1').isVisible(), true);
    assert.equal(await page.locator('#card-2').isVisible(), true);
  } finally {
    await browser.close();
  }
});
