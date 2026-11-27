const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
let browser;

before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    headless: true,
  });
});
after(async () => { await browser?.close(); });

async function fixture({ html, route = '/' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
  const body = html ||
    '<style>body{margin:0}aside{position:fixed;left:0;top:0;width:260px;height:100vh;background:#eee}svg{width:24px;height:24px}button{display:flex;align-items:center}button[aria-label="Show sidebar"]{position:absolute;left:7px;top:12px;width:44px;height:44px}</style><aside><button aria-label="Show sidebar" onclick="window.sidebarClicks=(window.sidebarClicks||0)+1"><svg></svg></button><button aria-label="New chat" onclick="window.newChats=(window.newChats||0)+1"><svg></svg><span>New chat</span></button><p>ChatGPT</p></aside><main></main>';
  await page.route('https://chatgpt.com/**', request => request.fulfill({
    body: '<!doctype html>' + body,
    contentType: 'text/html',
  }));
  await page.goto('https://chatgpt.com' + route);
  await page.evaluate(() => {
    window.chrome = {
      runtime: { id: 'fixture', getURL: file => 'chrome-extension://fixture/' + file },
      storage: { local: {} },
    };
  });
  await page.addStyleTag({ content: read('css/chat/flawless-corner.css') });
  await page.addScriptTag({ content: read('js/core/extension-context.js') });
  await page.addScriptTag({ content: read('js/chat/flawless-corner.js') });
  return page;
}

test('one mascot starts native New chat without opening the sidebar', async () => {
  const page = await fixture();
  const mascot = page.locator('#ghrc-flawless-corner');
  assert.equal(await mascot.count(), 1);
  assert.equal(await mascot.getAttribute('aria-label'), 'New chat');
  assert.match(await mascot.locator('img').getAttribute('src'), /artwork\/flawless-headshot\/SB-full\.webp$/);
  const bounds = await mascot.boundingBox();
  assert.equal(bounds.width, 33);
  assert.equal(bounds.height, 33);
  assert.deepEqual(bounds, { x: 13, y: 18, width: 33, height: 33 });
  // Recenter when ChatGPT changes sidebar padding or the control moves.
  await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Show sidebar"]');
    button.style.left = '27px';
    button.style.top = '30px';
    window.dispatchEvent(new Event('resize'));
  });
  assert.deepEqual(await mascot.boundingBox(), { x: 33, y: 36, width: 33, height: 33 });
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('ghrc-flawless-corner')).borderTopLeftRadius), '4px');
  assert.equal(await page.getByRole('button', { name: 'New chat', exact: true }).count(), 0);
  await mascot.click();
  assert.equal(await page.evaluate(() => window.newChats), 1);
  assert.equal(await page.evaluate(() => window.sidebarClicks || 0), 0);
  await page.evaluate(() => {
    document.querySelector('button[aria-label="Show sidebar"]').setAttribute('aria-label', 'Hide sidebar');
  });
  await page.waitForFunction(() => !document.querySelector('.ghrc-flawless-hidden-new-chat'));
  assert.equal(await mascot.count(), 1);
  await mascot.click();
  assert.equal(await page.evaluate(() => window.newChats), 2);
  await page.evaluate(() => document.getElementById('ghrc-flawless-corner').remove());
  await page.waitForFunction(() => !!document.getElementById('ghrc-flawless-corner'));
  assert.equal(await mascot.count(), 1);
  assert.deepEqual(page.errors, []);
  await page.close();
});


test('compact homepage removes the floating mascot and restores the native controls', async () => {
  const page = await fixture();
  try {
    await page.setViewportSize({ width: 562, height: 800 });
    const mascot = page.locator('#ghrc-flawless-corner');
    const toggle = page.getByRole('button', { name: 'Show sidebar' });
    const newChat = page.getByRole('button', { name: 'New chat', exact: true });
    await mascot.waitFor();
    await page.evaluate(() => document.documentElement.setAttribute('data-ghrc-compact-header', 'true'));
    await mascot.waitFor({ state: 'detached' });
    assert.equal(await toggle.locator('svg').isVisible(), true);
    assert.equal(await newChat.isVisible(), true);
    await newChat.press('Enter');
    assert.equal(await page.evaluate(() => window.newChats), 1);
    await page.evaluate(() => document.documentElement.removeAttribute('data-ghrc-compact-header'));
    await mascot.waitFor();
    assert.equal(await toggle.locator('svg').isVisible(), false);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.close();
  }
});

test('mascot animates in place on hover and returns to its still frame on exit', async () => {
  const page = await fixture();
  const mascot = page.locator('#ghrc-flawless-corner');
  const image = mascot.locator('img');
  const initialBounds = await mascot.boundingBox();

  assert.ok((await image.getAttribute('src')).endsWith('artwork/flawless-headshot/SB-full.webp'));
  await mascot.hover();
  assert.ok((await image.getAttribute('src')).endsWith('artwork/flawless-headshot/SB-full.gif'));
  assert.deepEqual(await mascot.boundingBox(), initialBounds);

  await page.mouse.move(600, 300);
  assert.ok((await image.getAttribute('src')).endsWith('artwork/flawless-headshot/SB-full.webp'));
  assert.deepEqual(await mascot.boundingBox(), initialBounds);

  await mascot.hover();
  assert.ok((await image.getAttribute('src')).endsWith('artwork/flawless-headshot/SB-full.gif'));
  await mascot.click();
  assert.equal(await page.evaluate(() => window.newChats), 1);
  assert.equal(await page.evaluate(() => window.sidebarClicks || 0), 0);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('animated mascot image is web-accessible to ChatGPT pages', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const resources = manifest.web_accessible_resources.flatMap(group => group.resources);
  assert.ok(resources.includes('artwork/flawless-headshot/SB-full.webp'));
  assert.ok(resources.includes('artwork/flawless-headshot/SB-full.gif'));
});

test('the modern toolbar keeps the native New chat action and uses its icon slot', async () => {
  const page = await fixture({
    html: '<aside hidden><button aria-label="Toggle sidebar"><svg></svg></button><button aria-label="New chat"><svg></svg></button></aside><header><button aria-label="New chat" onclick="window.newChats=(window.newChats||0)+1"><svg aria-hidden="true" width="20" height="20"></svg></button></header>',
    route: '/c/example',
  });
  const button = page.getByRole('button', { name: 'New chat', exact: true });
  const image = button.locator('.ghrc-flawless-mascot-image');
  assert.equal(await image.count(), 1);
  assert.equal(await page.locator('#ghrc-flawless-corner').count(), 0);
  assert.equal(await button.locator('svg').isVisible(), false);
  await page.mouse.move(600, 300);
  await button.hover();
  assert.match(await image.getAttribute('src'), /SB-full\.gif$/);
  await button.click();
  assert.equal(await page.evaluate(() => window.newChats), 1);
  await button.evaluate(element => { element.innerHTML = '<svg width="20" height="20"></svg>'; });
  await image.waitFor();
  await page.evaluate(() => { history.pushState({}, '', '/s/example'); });
  await image.waitFor({ state: 'detached' });
  assert.equal(await button.locator('svg').isVisible(), true);
  await page.evaluate(() => { history.pushState({}, '', '/c/example'); });
  await image.waitFor();
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('the app navigation rail uses its native Home button for the mascot', async () => {
  const page = await fixture({
    html: `<style>
      .home-icon { display: inline-flex; position: relative; }
      .home-indicator { position: absolute; right: 4px; top: 4px; z-index: 1;
        width: 8px; height: 8px; background: green; border-radius: 50%; }
    </style><nav aria-label="App navigation" data-app-navigation-rail="true">
      <button data-sidebar-destination="builtin:home" onclick="window.homeClicks=(window.homeClicks||0)+1">
        <span class="home-icon"><svg aria-hidden="true" width="20" height="20"></svg><span class="home-indicator" aria-hidden="true"></span></span>
        <span>Home</span>
      </button>
      <button data-sidebar-destination="builtin:space">Space</button>
    </nav><header><button aria-label="New chat"><svg width="20" height="20"></svg></button></header>`,
    route: '/c/example',
  });
  const home = page.getByRole('button', { name: 'Home', exact: true });
  const newChat = page.getByRole('button', { name: 'New chat', exact: true });
  const mascot = home.locator('.ghrc-flawless-mascot-image');
  assert.equal(await page.locator('.ghrc-flawless-mascot-image').count(), 1);
  assert.equal(await home.locator('svg').isVisible(), false);
  assert.equal(await newChat.locator('svg').isVisible(), true);
  assert.equal(await mascot.evaluate(image => {
    const indicator = image.parentElement.querySelector('.home-indicator');
    const { x, y, width, height } = indicator.getBoundingClientRect();
    image.style.pointerEvents = 'auto';
    const front = document.elementFromPoint(x + width / 2, y + height / 2);
    image.style.removeProperty('pointer-events');
    return front === image;
  }), true);
  await home.hover();
  assert.match(await mascot.getAttribute('src'), /SB-full\.gif$/);
  await home.press('Enter');
  assert.equal(await page.evaluate(() => window.homeClicks), 1);

  await home.evaluate(element => { element.firstElementChild.outerHTML = element.firstElementChild.outerHTML.replace(/<img[^>]+>/, ''); });
  await mascot.waitFor();
  assert.equal(await home.locator('svg').isVisible(), false);
  await page.evaluate(() => {
    chrome.runtime = undefined;
    __ghrcExtensionContext.active();
  });
  assert.equal(await mascot.count(), 0);
  assert.equal(await home.locator('svg').isVisible(), true);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('shared links and pages without an eligible control have no floating mascot', async () => {
  for (const route of ['/s/example', '/share/example', '/']) {
    const html = route === '/'
      ? '<main><button aria-label="New chat">New chat</button></main>'
      : '<header><button aria-label="New chat"><svg width="20" height="20"></svg></button></header>';
    const page = await fixture({ html, route });
    assert.equal(await page.locator('.ghrc-flawless-mascot-image, #ghrc-flawless-corner').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'New chat', exact: true }).isVisible(), true);
    assert.deepEqual(page.errors, []);
    await page.close();
  }
});

test('native controls return when extension stops', async () => {
  const page = await fixture();
  await page.setViewportSize({ width: 320, height: 600 });
  const bounds = await page.locator('#ghrc-flawless-corner').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
  await page.evaluate(() => {
    chrome.runtime = undefined;
    __ghrcExtensionContext.active();
  });
  assert.equal(await page.locator('#ghrc-flawless-corner').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Show sidebar', exact: true }).locator('svg').isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'New chat', exact: true }).isVisible(), true);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('native ChatGPT wordmark stays hidden as the sidebar opens and updates', async () => {
  const page = await fixture();
  await page.evaluate(() => {
    const brand = document.createElement('a');
    brand.id = 'native-brand';
    brand.href = '/';
    brand.style.cssText = 'position:absolute;top:24px;left:75px';
    brand.innerHTML = '<span>ChatGPT</span>';
    document.querySelector('aside').append(brand);

    const history = document.createElement('p');
    history.id = 'history-name';
    history.style.cssText = 'position:absolute;top:185px;left:75px';
    history.textContent = 'ChatGPT';
    document.querySelector('aside').append(history);
    document.querySelector('main').innerHTML = '<h1>ChatGPT</h1>';
  });

  const label = page.locator('#native-brand span');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#native-brand span')).display === 'none');
  assert.equal(await page.locator('#history-name').isVisible(), true);
  assert.equal(await page.locator('main h1').isVisible(), true);

  await page.evaluate(() => {
    document.querySelector('button[aria-label="Show sidebar"]').setAttribute('aria-label', 'Hide sidebar');
    document.querySelector('#native-brand').innerHTML = '<span>ChatGPT</span>';
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#native-brand span')).display === 'none');
  assert.equal(await page.locator('#ghrc-flawless-corner').isVisible(), true);

  // Do not conceal unrelated header text when React changes the wordmark.
  await page.evaluate(() => { document.querySelector('#native-brand span').textContent = 'Workspace'; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#native-brand span')).display !== 'none');
  await page.evaluate(() => { document.querySelector('#native-brand span').textContent = 'ChatGPT'; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#native-brand span')).display === 'none');

  await page.evaluate(() => {
    chrome.runtime = undefined;
    __ghrcExtensionContext.active();
  });
  assert.equal(await label.isVisible(), true);
  assert.equal(await page.locator('#ghrc-flawless-corner').count(), 0);
  assert.deepEqual(page.errors, []);
  await page.close();
});
