const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CODEX_TEST_CHROMIUM || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true }); });
after(async () => { await browser?.close(); });

for (const identity of ['aria-label="Add files and more"', 'id="composer-plus-btn"', 'data-testid="composer-plus-btn"', 'data-composer-navigation-target="add-context"']) {
  test(`dedicated + colors reach native SVG and hover without an editor (${identity})`, async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<style>
        button { background-color: rgb(30, 30, 30); width: 44px; height: 44px; }
        .text-default { color: rgb(240, 240, 240); }
        button:hover, button[data-state="open"] { background-color: rgb(60, 60, 60); }
      </style><button ${identity}><span><svg class="text-default"><use fill="currentColor"></use></svg></span></button>`);
      await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../css/composer/colors.css'), 'utf8') });
      const colors = { 'plus-background': '#112233', 'plus-icon': '#43af49', 'plus-hover': '#ac11ff' };
      await page.evaluate(colors => {
        for (const [key, value] of Object.entries(colors)) {
          document.documentElement.setAttribute(`data-ghrc-color-${key}`, '');
          document.documentElement.style.setProperty(`--ghrc-composer-${key}`, value);
        }
      }, colors);
      const button = page.locator('button');
      const background = () => button.evaluate(el => getComputedStyle(el).backgroundColor);
      assert.equal(await background(), 'rgb(17, 34, 51)');
      assert.equal(await page.locator('svg').evaluate(el => getComputedStyle(el).color), 'rgb(67, 175, 73)');
      assert.equal(await page.locator('use').evaluate(el => getComputedStyle(el).fill), 'rgb(67, 175, 73)');
      await button.hover();
      assert.equal(await background(), 'rgb(172, 17, 255)');
      await button.evaluate(el => { el.dataset.state = 'open'; });
      await page.mouse.move(200, 200);
      assert.equal(await background(), 'rgb(172, 17, 255)');
      await page.evaluate(() => {
        for (const key of ['plus-background', 'plus-icon', 'plus-hover']) document.documentElement.removeAttribute(`data-ghrc-color-${key}`);
        document.querySelector('button').dataset.state = 'closed';
      });
      assert.equal(await background(), 'rgb(30, 30, 30)');
      assert.equal(await page.locator('svg').evaluate(el => getComputedStyle(el).color), 'rgb(240, 240, 240)');
    } finally { await page.close(); }
  });
}

test('input outline follows the rounded ChatGPT composer surface and can be reset', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <form id="home"><div class="ComposerLayoutBody-a ComposerSurface-b">
        <div data-composer-markdown contenteditable="true"></div>
      </div></form>
      <form id="thread"><div class="ComposerLayoutRoot-a ComposerSurface-b">
        <div data-composer-markdown contenteditable="true"></div>
      </div></form>
      <form id="legacy"><textarea id="prompt-textarea"></textarea></form>
      <form id="unrelated"><textarea></textarea></form>
    `);
    await page.addStyleTag({ path: path.join(__dirname, '../css/composer/colors.css') });
    await page.evaluate(() => {
      const root = document.documentElement;
      root.setAttribute('data-ghrc-color-surface-outline', '');
      root.style.setProperty('--ghrc-composer-surface-outline', '#aabb22');
    });
    const outline = (selector, property = 'outline') =>
      page.locator(selector).evaluate((el, prop) => getComputedStyle(el)[prop], property);
    for (const selector of ['#home > div', '#thread > div', '#legacy']) {
      assert.equal(await outline(selector), 'rgb(170, 187, 34) solid 2px');
    }
    for (const selector of ['#home', '#thread', '#unrelated']) {
      assert.equal(await outline(selector, 'outlineStyle'), 'none');
    }
    await page.locator('#thread [contenteditable]').focus();
    assert.equal(await outline('#thread > div'), 'rgb(170, 187, 34) solid 2px');
    await page.evaluate(() => document.documentElement.removeAttribute('data-ghrc-color-surface-outline'));
    assert.equal(await outline('#thread > div', 'outlineStyle'), 'none');
  } finally { await page.close(); }
});
