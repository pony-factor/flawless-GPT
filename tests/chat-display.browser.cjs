// Run with Playwright available; native-menu fixtures never send real messages.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const displaySource = read('js/chat-display.js');
const thinkingSource = read('js/force-high-thinking.js');
const displayCss = read('css/chat-display.css');
const compactCss = read('css/compact-header.css');
let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
});
after(async () => { await browser?.close(); });

async function fixture({ stored = {}, maximize = false, slider = false, unresolved = false, delayed = false, delayStorage = false } = {}) {
  const p = await browser.newPage();
  p.errors = [];
  p.on('pageerror', error => p.errors.push(error.message));
  await p.route('https://display.test/**', r => r.fulfill({ contentType: 'text/html', body: `
    <style>body{margin:0;background:#171717;color:#eee;font-family:sans-serif}main{margin-left:52px} .ghrc-compact-composer-stack{display:flex;flex-direction:column;align-items:stretch;min-height:100vh;justify-content:center}form{width:min(768px,calc(100% - 24px));margin-left:0;background:#292929;padding:10px;box-sizing:border-box;border-radius:20px}textarea{width:80%;background:transparent;color:inherit}section{margin:24px auto;width:min(768px,calc(100% - 24px))}[role=menu]{position:fixed;top:0;left:0;background:#333;padding:10px}</style>
    <main><div class="group/home-composer-layout ghrc-compact-composer-stack">
    <form><textarea id="prompt-textarea">Partial draft</textarea><span style="display:contents"><button type="button" id="model" aria-label="Select ChatGPT model" aria-haspopup="menu" aria-expanded="false" aria-controls="model-menu" data-selected-reasoning-effort="standard"><span aria-hidden="true">Thinking effort</span><span id="level">Standard</span></button></span><button type="button" id="send">Send</button></form>
    <div><section class="group/home-suggestions"><div class="group/home-suggestion-list-item"><button>Create an image or sticker</button></div><div class="group/home-suggestion-list-item"><button>Write or edit</button></div><div class="group/home-suggestion-list-item"><button>Search the web</button></div></section></div>
    <article><p>Search the web</p><button id="ordinary">Write or edit</button></article>
    <div id="conversation-feedback"><span>Is this conversation helpful so far?</span><button type="button">Helpful</button><button type="button">Not helpful</button><button type="button">Close</button></div></div></main>` }));
  await p.goto('https://display.test/');
  await p.evaluate(({ stored, slider, unresolved, delayed, delayStorage }) => {
    window.settings = structuredClone(stored);
    window.listeners = [];
    window.chrome = { runtime: { id: "fixture" }, storage: { local: {
      async get(defaults) {
        if (delayStorage) await new Promise(resolve => { window.resolveStorage = resolve; });
        return { ...defaults, ...window.settings };
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { newValue: value };
          window.settings[key] = value;
        }
        window.listeners.forEach(fn => fn(changes, 'local'));
      },
    }, onChanged: { addListener(fn) { window.listeners.push(fn); } } } };
    const trigger = document.getElementById('model');
    window.opens = 0; window.closes = 0; window.visibleMenuFrames = 0;
    const open = () => {
      if (trigger.getAttribute('aria-expanded') === 'true') return;
      trigger.setAttribute('aria-expanded', 'true');
      window.opens++;
      setTimeout(() => {
        const menu = document.createElement('div');
        menu.id = 'model-menu'; menu.role = 'menu';
        if (unresolved) menu.textContent = 'Loading model options';
        else if (slider) {
          menu.innerHTML = '<div role="slider" tabindex="0" aria-valuenow="1" aria-valuemax="3"></div>';
          menu.firstElementChild.addEventListener('keydown', event => {
            if (event.key === 'ArrowRight') {
              const value = Math.min(3, Number(menu.firstElementChild.getAttribute('aria-valuenow')) + 1);
              menu.firstElementChild.setAttribute('aria-valuenow', value);
              window.sliderValue = value;
            }
          });
        } else {
          for (const level of ['Standard', 'Heavy']) {
            const option = document.createElement('div'); option.role = 'menuitem'; option.textContent = level;
            option.addEventListener('click', () => {
              trigger.setAttribute('data-selected-reasoning-effort', level.toLowerCase());
              document.getElementById('level').textContent = level;
              // Deliberately keep the menu open: the extension must dismiss it.
            });
            menu.append(option);
          }
        }
        menu.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
        document.body.append(menu);
      }, delayed ? 120 : 0);
    };
    const close = () => {
      trigger.setAttribute('aria-expanded', 'false');
      window.closes++;
      setTimeout(() => document.getElementById('model-menu')?.remove(), 60);
    };
    trigger.addEventListener('click', () => trigger.getAttribute('aria-expanded') === 'true' ? close() : open());
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') open();
      if (event.key === 'Escape') close();
    });
    window.frameMonitor = true;
    const frame = () => {
      if (!window.frameMonitor) return;
      const menu = document.getElementById('model-menu');
      if (menu && Number(getComputedStyle(menu).opacity) > 0 && menu.getClientRects().length) window.visibleMenuFrames++;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, { stored, slider, unresolved, delayed, delayStorage });
  await p.addStyleTag({ content: displayCss + compactCss });
  await p.addScriptTag({ content: read("js/extension-context.js") });
  await p.addScriptTag({ content: displaySource });
  if (maximize) await p.addScriptTag({ content: thinkingSource });
  return p;
}

test('suggestions and model controls default hidden without hiding messages or the composer', async () => {
  const p = await fixture();
  assert.equal(await p.locator('[class~="group/home-suggestions"]').isVisible(), false);
  assert.equal(await p.locator('#model').isVisible(), false);
  assert.equal(await p.locator('#ordinary').isVisible(), true);
  await p.waitForFunction(() => document.getElementById('conversation-feedback').hasAttribute('data-ghrc-conversation-feedback-prompt'));
  assert.equal(await p.locator('#conversation-feedback').isVisible(), false);
  assert.equal(await p.locator('#prompt-textarea').inputValue(), 'Partial draft');
  await p.evaluate(() => document.querySelector('[class~="group/home-suggestions"]').insertAdjacentHTML('beforeend', '<div class="group/home-suggestion-list-item">New suggestion</div>'));
  assert.equal(await p.getByText('New suggestion').isVisible(), false);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('conversation tail space follows the newest turn', async () => {
  const p = await fixture();
  await p.evaluate(() => {
    const thread = document.createElement('div');
    thread.id = 'thread';
    thread.innerHTML = '<article data-testid="conversation-turn-1">Earlier turn</article><article data-testid="conversation-turn-2">Current last turn</article>';
    document.querySelector('main').append(thread);
  });
  await p.waitForFunction(() => document.querySelector('[data-testid="conversation-turn-2"]')?.hasAttribute('data-ghrc-conversation-tail-space'));
  assert.equal(await p.locator('[data-testid="conversation-turn-1"]').getAttribute('data-ghrc-conversation-tail-space'), null);
  const margin = await p.locator('[data-testid="conversation-turn-2"]').evaluate(element => getComputedStyle(element).marginBottom);
  assert.notEqual(margin, '0px');

  await p.evaluate(() => {
    const turn = document.createElement('article');
    turn.setAttribute('data-testid', 'conversation-turn-3');
    turn.textContent = 'New turn fills the previous tail space';
    document.getElementById('thread').append(turn);
  });
  await p.waitForFunction(() => document.querySelector('[data-testid="conversation-turn-3"]')?.hasAttribute('data-ghrc-conversation-tail-space'));
  assert.equal(await p.locator('[data-testid="conversation-turn-2"]').getAttribute('data-ghrc-conversation-tail-space'), null);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('default CSS hides controls before storage resolves and later honors stored opt-outs', async () => {
  const p = await fixture({ delayStorage: true, stored: { hideHomeSuggestions: false, hideModelControls: false } });
  assert.equal(await p.locator('[class~="group/home-suggestions"]').isVisible(), false);
  assert.equal(await p.locator('#model').isVisible(), false);
  await p.evaluate(() => window.resolveStorage());
  await p.waitForFunction(() => document.documentElement.hasAttribute('data-ghrc-show-model-controls'));
  assert.equal(await p.locator('#model').isVisible(), true);
  assert.equal(await p.locator('[class~="group/home-suggestions"]').isVisible(), true);
  await p.close();
});

test('explicit opt-outs show controls, suggestions, and feedback; toggles update live', async () => {
  const p = await fixture({ stored: { hideHomeSuggestions: false, hideModelControls: false, hideConversationFeedbackPrompt: false } });
  await p.waitForFunction(() => document.documentElement.hasAttribute('data-ghrc-show-model-controls'));
  assert.equal(await p.locator('#model').isVisible(), true);
  assert.equal(await p.locator('[class~="group/home-suggestions"]').isVisible(), true);
  assert.equal(await p.locator('#conversation-feedback').isVisible(), true);
  await p.evaluate(() => chrome.storage.local.set({ hideHomeSuggestions: true, hideModelControls: true, hideConversationFeedbackPrompt: true }));
  await p.waitForFunction(() => !document.documentElement.hasAttribute('data-ghrc-show-model-controls'));
  assert.equal(await p.locator('#model').isVisible(), false);
  assert.equal(await p.locator('[class~="group/home-suggestions"]').isVisible(), false);
  assert.equal(await p.locator('#conversation-feedback').isVisible(), false);
  await p.evaluate(() => chrome.storage.local.set({ hideConversationFeedbackPrompt: false }));
  await p.waitForFunction(() => !document.documentElement.hasAttribute('data-ghrc-hide-conversation-feedback-prompt'));
  assert.equal(await p.locator('#conversation-feedback').isVisible(), true);
  await p.close();
});

for (const delayed of [false, true]) {
  test(`maximization stays invisible while selecting and closing a portaled menu (delayed=${delayed})`, async () => {
    const p = await fixture({ maximize: true, delayed, stored: { forceHighThinking: true } });
    await p.waitForFunction(() => document.getElementById('model').getAttribute('data-selected-reasoning-effort') === 'heavy');
    await p.waitForFunction(() => !document.getElementById('model-menu') && document.getElementById('model').hasAttribute('data-ghrc-high-thinking-selector'));
    assert.equal(await p.evaluate(() => visibleMenuFrames), 0);
    assert.equal(await p.locator('#prompt-textarea').inputValue(), 'Partial draft');
    assert.equal(await p.locator('#send').isVisible(), true);
    assert.equal(await p.evaluate(() => opens), 1);
    assert.deepEqual(p.errors, []);
    await p.close();
  });
}

test('hidden slider can be maximized without flashing its overlay', async () => {
  const p = await fixture({ maximize: true, slider: true, stored: { forceHighThinking: true } });
  await p.waitForFunction(() => window.sliderValue === 3 && !document.getElementById('model-menu'));
  assert.equal(await p.evaluate(() => visibleMenuFrames), 0);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('unresolved selection is dismissed on disable and manual model menus remain visible', async () => {
  const p = await fixture({ maximize: true, unresolved: true, stored: { forceHighThinking: true } });
  await p.locator('#model-menu').waitFor({ state: 'attached' });
  await p.evaluate(() => chrome.storage.local.set({ forceHighThinking: false, hideModelControls: false }));
  await p.waitForFunction(() => !document.getElementById('model-menu'));
  await p.locator('#model').click();
  await p.locator('#model-menu').waitFor();
  assert.equal(await p.locator('#model-menu').evaluate(e => getComputedStyle(e).opacity), '1');
  assert.deepEqual(p.errors, []);
  await p.close();
});

for (const width of [390, 1280]) {
  test(`compact composer stays centered after hiding suggestions at width ${width}`, async () => {
    const p = await fixture();
    await p.setViewportSize({ width, height: 800 });
    await p.evaluate(() => {
      document.documentElement.setAttribute('data-ghrc-new-chat', '');
      document.documentElement.setAttribute('data-ghrc-compact-header', '');
    });
    const geometry = await p.evaluate(() => {
      const main = document.querySelector('main').getBoundingClientRect();
      const composer = document.querySelector('form').getBoundingClientRect();
      return { offset: Math.abs((composer.left + composer.width / 2) - (main.left + main.width / 2)), top: composer.top, width: composer.width };
    });
    assert.ok(geometry.offset <= 1, JSON.stringify(geometry));
    assert.ok(geometry.width > 0 && geometry.width < width);
    assert.ok(geometry.top < 80);
    await p.screenshot({ path: `/tmp/flawless-startup-${width}.png` });
    await p.close();
  });
}
