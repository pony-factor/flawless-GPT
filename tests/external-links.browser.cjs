const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
let browser;

before(async () => {
  browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
});
after(async () => { await browser?.close(); });

async function fixture(settings = {}, githubResponse = null) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('https://chatgpt.com/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<style>body{margin:0}main{width:100%;min-height:1800px;padding-top:500px;box-sizing:border-box}</style><main><p><a id="source" href="https://example.org/source?utm_source=chatgpt&keep=1#section">Source reference</a></p><p><a id="internal" href="/c/another">Another chat</a></p></main>',
  }));
  await page.route('https://example.org/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Source content</h1>' }));
  await page.route('https://preview.test/link-preview.html', route => route.fulfill({
    contentType: 'text/html', body: '<body><script>' + read('js/link-preview-host.js') + '</script></body>',
  }));
  await page.goto('https://chatgpt.com/c/example');
  await page.evaluate(({ settings, githubResponse }) => {
    window.settingsListeners = [];
    window.runtimeListeners = [];
    window.previewRequests = [];
    window.storageWrites = [];
    window.openedLinks = [];
    window.copiedLinks = [];
    window.open = (...args) => openedLinks.push(args);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async value => copiedLinks.push(value) },
    });
    window.chrome = {
      runtime: {
        getURL: file => `https://preview.test/${file}`,
        onMessage: { addListener: fn => runtimeListeners.push(fn) },
        sendMessage: async message => {
          previewRequests.push(message);
          if (message.type === 'load-github-link-preview') return githubResponse;
          if (message.type === 'open-native-split-view') return { ok: true };
          return { ok: true };
        },
      },
      storage: {
        local: {
          get: async defaults => ({ ...defaults, ...settings }),
          set: async value => { storageWrites.push(value); },
        },
        onChanged: { addListener: listener => settingsListeners.push(listener) },
      },
    };
  }, { settings, githubResponse });
  await page.addStyleTag({ content: read('css/external-links.css') });
  await page.addScriptTag({ content: read('js/external-links.js') });
  return page;
}

test('normal link click keeps the configured new-tab behavior and sidebar controls are opt-in', async () => {
  const page = await fixture();
  await page.locator('#source').click();
  assert.deepEqual(await page.evaluate(() => openedLinks), [['https://example.org/source?keep=1#section', '_blank', 'noopener,noreferrer']]);
  assert.equal(await page.locator('.ghrc-link-actions').count(), 0);
  assert.equal(page.url(), 'https://chatgpt.com/c/example');
  await page.close();
});

test('sidebar mode adds a separate action while preserving the normal new-tab indicator', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  const actions = page.locator('.ghrc-link-actions');
  await actions.waitFor();
  assert.equal(await actions.locator('.ghrc-link-mode').textContent(), '↗');
  assert.equal(await actions.locator('.ghrc-link-mode').getAttribute('title'), 'Normal click opens in a new tab');
  assert.equal(await actions.locator('.ghrc-link-sidebar-button').getAttribute('aria-label'), 'Open link beside chat');

  await page.locator('#source').click();
  assert.equal(await page.locator('#ghrc-link-preview').count(), 0);
  assert.equal((await page.evaluate(() => openedLinks)).length, 1);

  await page.evaluate(() => window.scrollTo(0, 420));
  const before = await page.evaluate(() => window.scrollY);
  await actions.locator('.ghrc-link-sidebar-button').click();
  await page.frameLocator('#ghrc-link-preview iframe').frameLocator('iframe').locator('h1').waitFor();
  const after = await page.evaluate(() => window.scrollY);
  assert.ok(Math.abs(after - before) < 3);
  assert.equal((await page.evaluate(() => openedLinks)).length, 1);
  const preview = await page.locator('#ghrc-link-preview').boundingBox();
  assert.ok(preview.width > 576);
  assert.ok(preview.x >= 1279 - preview.width);
  assert.equal(await page.locator('html').getAttribute('data-ghrc-link-preview'), 'right');
  await page.close();
});

test('preview waits for its navigation watch without mounting a same-origin blank frame', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  const warnings = [];
  page.on('console', message => {
    if (/both allow-scripts and allow-same-origin/.test(message.text())) warnings.push(message.text());
  });
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async message => {
      if (message.type === 'watch-link-preview') await new Promise(resolve => { window.releaseWatch = resolve; });
      return send(message);
    };
  });
  await page.locator('.ghrc-link-sidebar-button').click();
  await page.waitForFunction(() => Boolean(window.releaseWatch));
  assert.equal(await page.locator('#ghrc-link-preview iframe').count(), 0);
  await page.evaluate(() => releaseWatch());
  await page.frameLocator('#ghrc-link-preview iframe').frameLocator('iframe').locator('h1').waitFor();
  assert.deepEqual(warnings, []);
  await page.close();
});

test('left-side preview moves the panel, keeps controls ordered, and resizes from its right edge', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true, openExternalLinksInSplitViewOnLeft: true });
  const actions = page.locator('.ghrc-link-actions');
  await actions.waitFor();
  await actions.locator('.ghrc-link-sidebar-button').click();
  await page.frameLocator('#ghrc-link-preview iframe').frameLocator('iframe').locator('h1').waitFor();

  const preview = await page.locator('#ghrc-link-preview').boundingBox();
  assert.ok(preview.x <= 1);
  assert.equal(await page.locator('html').getAttribute('data-ghrc-link-preview'), 'left');

  const headerChildren = await page.locator('#ghrc-link-preview header').evaluate(
    header => [...header.children].map(child => child.getAttribute('aria-label') || child.className),
  );
  assert.deepEqual(headerChildren, ['Close website preview', 'Open in new tab', 'Copy link', 'ghrc-preview-destination']);

  const destination = page.locator('#ghrc-link-preview .ghrc-preview-destination');
  assert.equal(await destination.getAttribute('href'), 'https://example.org/source?keep=1#section');
  assert.equal(await destination.locator('img').getAttribute('src'), 'https://example.org/favicon.ico');
  assert.equal(await destination.locator('span').textContent(), 'example.org/source#section');

  const before = (await page.locator('#ghrc-link-preview').boundingBox()).width;
  const separator = page.getByRole('separator', { name: 'Resize website sidebar' });
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  const after = (await page.locator('#ghrc-link-preview').boundingBox()).width;
  assert.ok(after > before);
  await page.close();
});

test('current-tab mode is shown as the normal action while the sidebar remains separate', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true, openExternalLinksInNewTabs: false });
  const mode = page.locator('.ghrc-link-mode');
  await mode.waitFor();
  assert.equal(await mode.textContent(), '→');
  assert.equal(await mode.getAttribute('title'), 'Normal click opens in this tab');
  assert.equal(await page.locator('.ghrc-link-sidebar-button').count(), 1);
  await page.close();
});

test('GitHub embeds the website first and uses the API only after the active frame is blocked', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true }, {
    ok: true,
    subtitle: 'owner/repo #42',
    title: 'A useful PR',
    details: 'Open · author',
    body: '<img src=x onerror="window.injected=true">',
    files: [{ filename: 'example.js', additions: 2, deletions: 1, patch: '+safe change' }],
  });
  await page.route('https://github.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Full GitHub website</h1>' }));
  await page.locator('#source').evaluate(link => { link.href = 'https://github.com/owner/repo/pull/42'; });
  await page.locator('.ghrc-link-sidebar-button').click();
  await page.frameLocator('#ghrc-link-preview iframe').frameLocator('iframe').locator('h1').waitFor();
  assert.equal((await page.evaluate(() => previewRequests)).some(message => message.type === 'load-github-link-preview'), false);
  const watch = (await page.evaluate(() => previewRequests)).find(message => message.type === 'watch-link-preview');
  await page.evaluate(watch => runtimeListeners.forEach(fn => fn({
    type: 'link-preview-navigation-error', previewId: 'stale', url: watch.url, error: 'net::ERR_BLOCKED_BY_RESPONSE',
  })), watch);
  await page.evaluate(watch => runtimeListeners.forEach(fn => fn({
    type: 'link-preview-navigation-error', previewId: watch.previewId, url: watch.url, error: 'net::ERR_INTERNET_DISCONNECTED',
  })), watch);
  assert.equal((await page.evaluate(() => previewRequests)).some(message => message.type === 'load-github-link-preview'), false);
  assert.equal(await page.locator('#ghrc-link-preview iframe').count(), 1);
  await page.evaluate(watch => runtimeListeners.forEach(fn => fn({
    type: 'link-preview-navigation-error', previewId: watch.previewId, url: watch.url, error: 'net::ERR_BLOCKED_BY_RESPONSE',
  })), watch);
  await page.locator('#ghrc-link-preview h2').waitFor();
  assert.equal(await page.locator('#ghrc-link-preview h2').textContent(), 'A useful PR');
  assert.equal(await page.locator('#ghrc-link-preview iframe').count(), 0);
  assert.equal(await page.locator('#ghrc-link-preview .ghrc-preview-body img').count(), 0);
  assert.match(await page.locator('#ghrc-link-preview details').textContent(), /safe change/);
  assert.ok((await page.evaluate(() => previewRequests)).some(message => message.type === 'load-github-link-preview'));
  await page.close();
});

test('the vertical divider resizes the sidebar and persists the allocation', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('.ghrc-link-sidebar-button').click();
  await page.frameLocator('#ghrc-link-preview iframe').frameLocator('iframe').locator('h1').waitFor();
  const before = (await page.locator('#ghrc-link-preview').boundingBox()).width;
  const separator = page.getByRole('separator', { name: 'Resize website sidebar' });
  await separator.focus();
  await page.keyboard.press('ArrowLeft');
  const after = (await page.locator('#ghrc-link-preview').boundingBox()).width;
  assert.ok(after > before);
  assert.ok((await page.evaluate(() => storageWrites)).some(write => Number.isFinite(write.linkPreviewWidth)));
  await page.close();
});

test('blocked embedded previews can still fall back to the browser native split', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('.ghrc-link-sidebar-button').click();
  await page.frameLocator('#ghrc-link-preview iframe').frameLocator('iframe').locator('h1').waitFor();
  const watch = (await page.evaluate(() => previewRequests)).find(message => message.type === 'watch-link-preview');
  assert.ok(watch);
  await page.evaluate(watch => runtimeListeners.forEach(fn => fn({
    type: 'link-preview-navigation-error',
    previewId: watch.previewId,
    url: watch.url,
  })), watch);
  await page.waitForFunction(() => previewRequests.some(message => message.type === 'open-native-split-view'));
  assert.equal(await page.locator('#ghrc-link-preview').count(), 0);
  await page.close();
});

test('sidebar setting changes add and remove link actions immediately and close an open sidebar', async () => {
  const page = await fixture();
  assert.equal(await page.locator('.ghrc-link-actions').count(), 0);
  await page.evaluate(() => settingsListeners.forEach(fn => fn({ openExternalLinksInSplitView: { newValue: true } }, 'local')));
  await page.locator('.ghrc-link-actions').waitFor();
  await page.locator('.ghrc-link-sidebar-button').click();
  assert.equal(await page.locator('#ghrc-link-preview').count(), 1);
  await page.evaluate(() => settingsListeners.forEach(fn => fn({ openExternalLinksInSplitView: { newValue: false } }, 'local')));
  assert.equal(await page.locator('#ghrc-link-preview').count(), 0);
  assert.equal(await page.locator('.ghrc-link-actions').count(), 0);
  await page.close();
});

test('streaming mutations do not rescan the existing conversation container', async () => {
  const page = await fixture();
  await page.evaluate(() => {
    const main = document.querySelector('main');
    const querySelectorAll = main.querySelectorAll.bind(main);
    window.mainLinkScans = 0;
    main.querySelectorAll = selector => {
      if (selector === 'a[href]') window.mainLinkScans += 1;
      return querySelectorAll(selector);
    };
    for (let index = 0; index < 100; index += 1) {
      const token = document.createElement('span');
      token.textContent = String(index);
      main.append(token);
    }
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => mainLinkScans), 0);
  await page.close();
});

test('batched mutation handling still sanitizes newly added links', async () => {
  const page = await fixture();
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.id = 'dynamic-source';
    link.href = 'https://example.org/new?utm_source=stream&keep=1#section';
    document.querySelector('main').append(link);
  });
  await page.waitForFunction(() => document.getElementById('dynamic-source')?.href === 'https://example.org/new?keep=1#section');
  assert.equal(await page.locator('#dynamic-source').getAttribute('href'), 'https://example.org/new?keep=1#section');
  await page.close();
});

for (const side of ['right', 'left']) {
  test(`dragging the ${side} preview divider reflows the conversation and composer`, async () => {
    const page = await fixture({ openExternalLinksInSplitView: true, openExternalLinksInSplitViewOnLeft: side === 'left' });
    await page.evaluate(() => {
      const root = document.createElement('div');
      root.id = 'root';
      const layout = document.createElement('div');
      layout.className = 'relative flex flex-col Layout-example';
      layout.style.width = '100vw';
      const main = document.querySelector('main');
      const prose = document.createElement('p');
      prose.id = 'prose';
      prose.textContent = 'Conversation text should wrap within the available space. '.repeat(16);
      main.append(prose);
      const composer = document.createElement('div');
      composer.id = 'composer';
      composer.textContent = 'Message composer';
      composer.style.cssText = 'width:100%;height:60px';
      layout.append(main, composer);
      root.append(layout);
      document.body.prepend(root);
    });
    await page.locator('.ghrc-link-sidebar-button').click();
    await page.frameLocator('#ghrc-link-preview iframe').frameLocator('iframe').locator('h1').waitFor();
    const dimensions = () => page.evaluate(() => {
      const rect = id => {
        if (!document.getElementById(id)) return null;
        const { x, width, right, height } = document.getElementById(id).getBoundingClientRect();
        return { x, width, right, height };
      };
      return { root: rect('root'), chat: document.querySelector('main').getBoundingClientRect().toJSON(), composer: rect('composer'), prose: rect('prose'), preview: rect('ghrc-link-preview') };
    });
    const before = await dimensions();
    const divider = await page.getByRole('separator', { name: 'Resize website sidebar' }).boundingBox();
    await page.mouse.move(divider.x + divider.width / 2, 300);
    await page.mouse.down();
    await page.mouse.move(divider.x + divider.width / 2 + (side === 'left' ? 140 : -140), 300, { steps: 5 });
    await page.mouse.up();
    const after = await dimensions();
    assert.ok(after.preview.width > before.preview.width + 100);
    assert.ok(after.chat.width < before.chat.width - 100);
    assert.ok(after.prose.height > before.prose.height);
    for (const state of [before, after]) {
      assert.ok(Math.abs(state.chat.width - state.root.width) < 1);
      assert.ok(Math.abs(state.composer.width - state.root.width) < 1);
      if (side === 'right') assert.ok(state.chat.right <= state.preview.x + 1);
      else assert.ok(state.chat.x >= state.preview.right - 1);
    }
    await page.getByRole('button', { name: 'Close website preview' }).click();
    assert.equal((await dimensions()).chat.width, 1280);
    await page.close();
  });
}
