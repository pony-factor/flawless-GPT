const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("custom composer placeholders update live, survive editor replacement, and restore defaults without editing drafts", async () => {
  const browser = await chromium.launch({ executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<div data-composer-markdown contenteditable="true" aria-label="Ask ChatGPT"><p data-placeholder="Ask ChatGPT">Partial draft</p></div><textarea id="prompt-textarea" placeholder="Ask anything">Another draft</textarea><input id="other" placeholder="Search">');
    await page.evaluate(() => {
      window.listeners = [];
      window.settings = {};
      window.chrome = { runtime: { id: "fixture" }, storage: {
        local: { get: async defaults => ({ ...defaults, ...settings }) },
        onChanged: { addListener: listener => listeners.push(listener) },
      } };
      window.setPlaceholder = value => {
        settings.composerPlaceholder = value;
        listeners.forEach(listener => listener({ composerPlaceholder: { newValue: value } }, "local"));
      };
    });
    await page.addScriptTag({ content: read("js/extension-context.js") });
    await page.addStyleTag({ content: read("css/chat-display.css") });
    await page.addScriptTag({ content: read("js/composer-placeholder.js") });
    assert.equal(await page.locator("[data-placeholder]").getAttribute("data-placeholder"), "Ask ChatGPT");
    await page.evaluate(() => {
      // Simulate the host editor restoring the placeholder it owns after a mutation.
      window.hostPlaceholderUpdates = 0;
      window.hostObserver = new MutationObserver(records => {
        for (const record of records) {
          hostPlaceholderUpdates++;
          if (record.target.getAttribute("data-placeholder") !== "Ask ChatGPT") {
            record.target.setAttribute("data-placeholder", "Ask ChatGPT");
          }
        }
      });
      hostObserver.observe(document.querySelector("[data-placeholder]"), { attributes: true, attributeFilter: ["data-placeholder"] });
    });
    await page.evaluate(() => setPlaceholder("Dash"));
    await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-placeholder]"), "::before").content === '"Dash"');
    await page.waitForFunction(() => document.querySelector('textarea').placeholder === 'Dash');
    await page.evaluate(() => { settings.composerColors = { placeholder: '#123456' }; });
    await page.addScriptTag({ content: read('js/composer-colors.js') });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--ghrc-composer-placeholder') === '#123456');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-placeholder]'), '::before').content), '"Dash"');

    assert.equal(await page.locator("[data-placeholder]").getAttribute("data-placeholder"), "Ask ChatGPT");
    assert.equal(await page.locator("textarea").getAttribute("placeholder"), "Dash");
    assert.equal(await page.locator("[data-composer-markdown]").textContent(), "Partial draft");
    assert.equal(await page.locator("textarea").inputValue(), "Another draft");
    assert.equal(await page.locator("#other").getAttribute("placeholder"), "Search");
    assert.equal(await page.evaluate(() => hostPlaceholderUpdates), 0);
    await page.evaluate(() => hostObserver.disconnect());
    await page.evaluate(() => {
      document.querySelector("[data-placeholder]").setAttribute("data-placeholder", "Ask a follow-up");
    });
    await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-placeholder]"), "::before").content === '"Dash"');
    await page.evaluate(() => setPlaceholder(""));
    await page.waitForFunction(() => document.querySelector("[data-placeholder]").dataset.placeholder === "Ask a follow-up");
    await page.waitForFunction(() => !document.querySelector("[data-ghrc-placeholder-text]"));
    assert.equal(await page.locator("textarea").getAttribute("placeholder"), "Ask anything");
    await page.evaluate(() => {
      setPlaceholder('Write <anything> "here"');
      document.querySelector("[data-composer-markdown]").innerHTML = '<p data-placeholder="New chat">Restored draft</p>';
    });
    await page.waitForFunction(() => document.querySelector("[data-placeholder]").dataset.ghrcPlaceholderText === 'Write <anything> "here"');
    assert.equal(await page.locator("[data-composer-markdown]").textContent(), "Restored draft");
    const replacementText = await page.evaluate(() => {
      setPlaceholder('Dash');
      document.querySelector('[data-composer-markdown]').innerHTML = '<p data-placeholder="New chat"><br></p>';
      // Read the new paragraph before the mutation observer or animation frame runs.
      return getComputedStyle(document.querySelector('[data-placeholder]'), '::before').content;
    });
    assert.equal(replacementText, '"Dash"');
    await page.evaluate(() => setPlaceholder(" "));
    await page.waitForFunction(() => document.querySelector("[data-placeholder]").dataset.placeholder === "New chat");
    await page.waitForFunction(() => !document.querySelector("[data-ghrc-placeholder-text]"));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("a composer that becomes editable after hydration receives its saved placeholder", async () => {
  const browser = await chromium.launch({ executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div data-composer-markdown contenteditable="false"><p class="placeholder" data-placeholder="Ask ChatGPT"><br></p></div>');
    await page.evaluate(() => {
      window.chrome = {runtime:{id:'fixture'}, storage:{local:{get:async defaults=>({...defaults,composerPlaceholder:'Dash'})},onChanged:{addListener(){}}}};
    });
    await page.addStyleTag({ content: read('css/chat-display.css') });
    await page.addScriptTag({ content: read('js/extension-context.js') });
    await page.addScriptTag({ content: read('js/composer-placeholder.js') });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-ghrc-placeholder-text]').count(), 0);
    await page.evaluate(() => document.querySelector('[data-composer-markdown]').setAttribute('contenteditable', 'true'));
    await page.waitForFunction(() => document.querySelector('[data-placeholder]').dataset.ghrcPlaceholderText === 'Dash');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-placeholder]'), '::before').content === '"Dash"');
    assert.equal(await page.locator('[data-placeholder]').getAttribute('data-placeholder'), 'Ask ChatGPT');
    assert.equal(await page.locator('[data-composer-markdown]').textContent(), '');
  } finally {
    await browser.close();
  }
});
