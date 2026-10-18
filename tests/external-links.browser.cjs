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

async function fixture(settings = {}, githubResponse = null, nativeSplitSupported = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('https://chatgpt.com/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<style>body{margin:0}main{width:100%;min-height:1800px;padding-top:500px;box-sizing:border-box}</style><main><p><a id="source" href="https://example.org/source?utm_source=chatgpt&keep=1#section">Source reference</a></p><p><a id="internal" href="/c/another">Another chat</a></p></main>',
  }));
  await page.route('https://example.org/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Source content</h1>' }));
  await page.route('https://preview.test/link-preview.html', route => route.fulfill({
    contentType: 'text/html', body: '<body><script>' + read('js/links/link-preview-host.js') + '</script></body>',
  }));
  await page.goto('https://chatgpt.com/c/example');
  await page.evaluate(({ settings, githubResponse, nativeSplitSupported }) => {
    window.settingsListeners = [];
    window.runtimeListeners = [];
    window.previewRequests = [];
    window.storageWrites = [];
    window.openedLinks = [];
    window.copiedLinks = [];
    window.nativeSplitSupported = nativeSplitSupported;
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
          if (message.type === 'open-native-split-view') return { ok: window.nativeSplitSupported };
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
  }, { settings, githubResponse, nativeSplitSupported });
  await page.addStyleTag({ content: read('css/external-links.css') });
  await page.addScriptTag({ content: read('js/links/citation-links-main.js') });
  await page.addScriptTag({ content: read('js/links/external-links.js') });
  return page;
}

test('all sidebar buttons prefer the same native split, including GitHub documentation', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true, openExternalLinksInSplitViewOnLeft: true }, null, true);
  for (const href of ['https://www.random.org/', 'https://en.wikipedia.org/wiki/Special:Random', 'https://github.com/owner/repo/blob/main/README.md', 'https://docs.github.com/en']) {
    await page.locator('#source').evaluate((link, href) => { link.href = href; }, href);
    await page.waitForFunction(href => document.querySelector('.ghrc-link-sidebar-button')?.dataset.href === href, href);
    await page.locator('.ghrc-link-sidebar-button').click();
    await page.waitForFunction(href => previewRequests.some(message => message.type === 'open-native-split-view' && message.url === href), href);
    assert.equal(await page.locator('#ghrc-link-preview').count(), 0);
  }
  const requests = await page.evaluate(() => previewRequests);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(message => message.type === 'open-native-split-view' && message.onLeft === true));
  await page.close();
});

test('normal link click keeps the configured new-tab behavior and sidebar controls are opt-in', async () => {
  const page = await fixture();
  await page.locator('#source').click();
  assert.deepEqual(await page.evaluate(() => openedLinks), [['https://example.org/source?keep=1#section', '_blank', 'noopener,noreferrer']]);
  assert.equal(await page.locator('.ghrc-link-actions').count(), 0);
  assert.equal(page.url(), 'https://chatgpt.com/c/example');
  await page.close();
});

test('external-link arrows can be hidden and restored without hiding sidebar buttons or changing navigation', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true, hideExternalLinkArrows: true });
  await page.locator('#source').evaluate(link => {
    link.innerHTML = 'Source reference <svg id="external-arrow" aria-hidden="true" width="14" height="14"><path d="M3 11L11 3M3 3h8v8"/></svg>';
  });
  await page.locator('#external-arrow[data-ghrc-external-link-arrow]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#external-arrow').isVisible(), false);
  assert.equal(await page.locator('.ghrc-link-sidebar-button svg').isVisible(), true);
  await page.locator('#source').click();
  assert.equal((await page.evaluate(() => openedLinks)).length, 1);
  await page.evaluate(() => settingsListeners.forEach(fn => fn({ hideExternalLinkArrows: { newValue: false } }, 'local')));
  assert.equal(await page.locator('#external-arrow').isVisible(), true);
  await page.close();
});

test('hidden arrow wrappers leave no gap before trailing punctuation', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true, hideExternalLinkArrows: true });
  await page.locator('.ghrc-link-with-actions').waitFor();
  await page.evaluate(() => {
    const link = document.getElementById('source');
    link.innerHTML = 'Source reference<span id="native-arrow-wrapper" style="display:inline-block;width:14px;margin-left:4px"><svg width="14" height="14"><path d="M3 11L11 3"/></svg></span>';
    link.nextElementSibling.after(document.createTextNode(', next phrase.'));
  });
  await page.locator('.ghrc-link-trailing-punctuation').waitFor();
  const gap = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('source').firstChild);
    const labelEnd = range.getBoundingClientRect().right;
    range.selectNodeContents(document.querySelector('.ghrc-link-trailing-punctuation'));
    return range.getBoundingClientRect().left - labelEnd;
  });
  assert.ok(Math.abs(gap) < 1, `Unwanted gap before punctuation: ${gap}px`);
  assert.equal(await page.locator('#native-arrow-wrapper').isVisible(), false);
  assert.equal(await page.locator('.ghrc-link-sidebar-button').isVisible(), true);
  await page.close();
});

test('sidebar icons follow trailing punctuation without changing the sentence or destination', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true }, null, true);
  await page.locator('.ghrc-link-with-actions').waitFor();
  await page.evaluate(() => {
    const group = document.getElementById('source').nextElementSibling;
    const trigger = document.createElement('span');
    trigger.setAttribute('data-d-component', 'popover-trigger');
    const link = group.previousElementSibling;
    group.before(trigger);
    trigger.append(link, group);
    trigger.after(document.createTextNode('). Next sentence.'));
  });
  await page.locator('.ghrc-link-trailing-punctuation').waitFor();
  assert.equal(await page.locator('.ghrc-link-trailing-punctuation').textContent(), ').');
  assert.equal(await page.locator('#source').getAttribute('href'), 'https://example.org/source?keep=1#section');
  assert.ok((await page.locator('#source').locator('xpath=ancestor::p').textContent()).endsWith('). Next sentence.'));
  await page.setViewportSize({ width: 320, height: 800 });
  const geometry = await page.evaluate(() => {
    const punctuation = document.querySelector('.ghrc-link-trailing-punctuation');
    const range = document.createRange();
    range.selectNodeContents(punctuation);
    return { text: range.getBoundingClientRect().toJSON(), action: document.querySelector('.ghrc-link-actions').getBoundingClientRect().toJSON() };
  });
  assert.ok(geometry.action.x >= geometry.text.right);
  assert.ok(geometry.action.x - geometry.text.right < 6);
  await page.locator('.ghrc-link-sidebar-button').click();
  assert.equal((await page.evaluate(() => previewRequests)).at(-1).url, 'https://example.org/source?keep=1#section');
  await page.evaluate(() => settingsListeners.forEach(fn => fn({ openExternalLinksInSplitView: { newValue: false } }, 'local')));
  assert.equal(await page.locator('.ghrc-link-trailing-punctuation').count(), 0);
  assert.ok((await page.locator('#source').locator('xpath=ancestor::p').textContent()).endsWith('). Next sentence.'));
  await page.close();
});

test('late hydration moves whitespace-separated punctuation before the sidebar icon', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('.ghrc-link-with-actions').waitFor();
  await page.evaluate(() => {
    const group = document.getElementById('source').nextElementSibling;
    const trigger = document.createElement('span');
    trigger.setAttribute('data-d-component', 'popover-trigger');
    const link = group.previousElementSibling;
    group.before(trigger);
    trigger.append(link, group);
    trigger.after(document.createTextNode(' '), document.createTextNode('. After hydration.'));
  });
  await page.locator('.ghrc-link-trailing-punctuation').waitFor();
  assert.equal(await page.locator('main p:first-child').textContent(), 'Source reference. After hydration.');
  assert.equal(await page.locator('.ghrc-link-trailing-punctuation').textContent(), '.');
  const order = await page.locator('.ghrc-link-with-actions').evaluate(group =>
    [...group.children].map(node => node.className || node.tagName.toLowerCase()));
  assert.deepEqual(order, ['ghrc-link-trailing-punctuation', 'ghrc-link-actions']);
  await page.evaluate(() => settingsListeners.forEach(listener =>
    listener({ openExternalLinksInSplitView: { newValue: false } }, 'local')));
  assert.equal(await page.locator('main p:first-child').textContent(), 'Source reference . After hydration.');
  await page.close();
});

test('hydration replacing punctuation repositions it without duplication or a refresh', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('.ghrc-link-with-actions').waitFor();
  await page.evaluate(() => {
    document.getElementById('source').nextElementSibling.after(document.createTextNode('. Original.'));
  });
  await page.locator('.ghrc-link-trailing-punctuation').waitFor();
  await page.evaluate(() => {
    const group = document.getElementById('source').nextElementSibling;
    // The first insertion has already been relocated. Simulate React replacing
    // the remainder with fresh native punctuation during hydration.
    group.nextSibling.replaceWith(document.createTextNode('. Rehydrated.'));
  });
  await page.waitForFunction(() => document.querySelector('main p:first-child').textContent
    === 'Source reference. Rehydrated.');
  assert.equal(await page.locator('.ghrc-link-trailing-punctuation').count(), 1);
  assert.equal(await page.locator('.ghrc-link-trailing-punctuation').textContent(), '.');
  await page.evaluate(() => {
    const group = document.getElementById('source').nextElementSibling;
    group.nextSibling.data = '. Updated again.';
  });
  await page.waitForFunction(() => document.querySelector('main p:first-child').textContent
    === 'Source reference. Updated again.');
  assert.equal(await page.locator('.ghrc-link-trailing-punctuation').count(), 1);
  await page.evaluate(() => settingsListeners.forEach(listener =>
    listener({ openExternalLinksInSplitView: { newValue: false } }, 'local')));
  assert.equal(await page.locator('main p:first-child').textContent(), 'Source reference. Updated again.');
  await page.close();
});

test('streamed word spans keep punctuation before sidebar buttons through hydration and opt-out', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('.ghrc-link-with-actions').waitFor();
  await page.evaluate(() => {
    const link = document.getElementById('source');
    const wrapper = document.createElement('span');
    wrapper.innerHTML = '<span data-d-component="popover-trigger"></span>';
    link.before(wrapper);
    wrapper.firstChild.append(link, link.nextElementSibling);
    const punctuation = document.createElement('span');
    punctuation.dataset.dTextFlow = 'word';
    punctuation.id = 'streamed-punctuation';
    punctuation.textContent = ', ';
    wrapper.after(punctuation);
    window.originalPunctuation = punctuation;
  });
  await page.waitForFunction(() => document.querySelector('.ghrc-link-trailing-punctuation')?.textContent === ',');
  assert.equal(await page.locator('#streamed-punctuation').evaluate(e => e === window.originalPunctuation), true);
  await page.evaluate(() => { document.getElementById('streamed-punctuation').textContent = '. Next sentence.'; });
  await page.waitForFunction(() => document.querySelector('.ghrc-link-trailing-punctuation')?.textContent === '.');
  assert.equal(await page.locator('main p:first-child').textContent(), 'Source reference. Next sentence.');
  const gap = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('source'));
    const end = range.getBoundingClientRect().right;
    range.selectNodeContents(document.querySelector('.ghrc-link-trailing-punctuation'));
    return range.getBoundingClientRect().left - end;
  });
  assert.ok(Math.abs(gap) < 1, `Gap before streamed punctuation: ${gap}px`);
  await page.evaluate(() => settingsListeners.forEach(listener =>
    listener({ openExternalLinksInSplitView: { newValue: false } }, 'local')));
  assert.equal(await page.locator('#streamed-punctuation').textContent(), '. Next sentence.');
  await page.close();
});

test('long links wrap beside their button without overflowing a narrow chat', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('.ghrc-link-with-actions').waitFor();
  await page.locator('#source').evaluate(link => {
    link.textContent = 'https://commons.wikimedia.org/wiki/Special:Random/File/averylongunbrokenfilename';
    link.style.cssText = 'display:inline-flex;white-space:nowrap';
  });
  for (const width of [240, 320, 520]) {
    await page.setViewportSize({ width, height: 800 });
    const boxes = await page.evaluate(() => {
      const link = document.querySelector('#source');
      const group = link.nextElementSibling;
      const action = group.querySelector('.ghrc-link-actions');
      const text = document.createRange();
      text.selectNodeContents(link);
      const lastLine = [...text.getClientRects()].at(-1);
      return { group: group.getBoundingClientRect().toJSON(), link: link.getBoundingClientRect().toJSON(),
        action: action.getBoundingClientRect().toJSON(), scrollWidth: document.documentElement.scrollWidth,
        lastLine: lastLine.toJSON(), viewport: innerWidth, count: document.querySelectorAll('.ghrc-link-actions').length };
    });
    assert.ok(boxes.scrollWidth <= boxes.viewport, JSON.stringify(boxes));
    assert.ok(boxes.action.right <= boxes.viewport);
    assert.ok(boxes.action.x - boxes.lastLine.right >= 0, JSON.stringify(boxes));
    assert.ok(boxes.action.x - boxes.lastLine.right < 6, JSON.stringify(boxes));
    assert.ok(Math.abs(boxes.action.bottom - boxes.lastLine.bottom) < 4, JSON.stringify(boxes));
    assert.equal(boxes.count, 1);
  }
  await page.evaluate(() => settingsListeners.forEach(fn => fn({ openExternalLinksInSplitView: { newValue: false } }, 'local')));
  assert.equal(await page.locator('.ghrc-link-with-actions').count(), 0);
  assert.equal(await page.locator('#source').count(), 1);
  await page.close();
});

test('wrapped documentation links reserve their height above the next list item', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.evaluate(() => {
    const list = document.createElement('ul');
    list.style.cssText = 'font:16px/26px sans-serif;margin:0;padding-left:24px';
    list.innerHTML = '<li>Stacked Pull Requests: <span style="display:inline-flex;height:26px;max-height:26px;white-space:nowrap"><a id="stacked" href="https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks">https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks</a></span></li><li id="next-item">GitHub Branches: https://docs.github.com/en/rest/branches</li>';
    document.querySelector('main').replaceChildren(list);
  });
  await page.locator('#stacked + .ghrc-link-with-actions .ghrc-link-actions').waitFor();
  for (const width of [240, 320, 520, 768]) {
    await page.setViewportSize({ width, height: 800 });
    const boxes = await page.evaluate(() => {
      const group = document.getElementById('stacked').parentElement;
      return { wrapped: group.getBoundingClientRect().toJSON(), next: document.getElementById('next-item').getBoundingClientRect().toJSON() };
    });
    assert.ok(boxes.next.top >= boxes.wrapped.bottom, JSON.stringify(boxes));
  }
  await page.close();
});

test('sidebar mode adds only the sidebar action and preserves normal new-tab clicks', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  const actions = page.locator('.ghrc-link-actions');
  await actions.waitFor();
  assert.equal(await actions.locator('.ghrc-link-mode').count(), 0);
  assert.equal(await actions.locator('.ghrc-link-sidebar-button').getAttribute('aria-label'), 'Open link beside chat');

  await page.evaluate(() => {
    for (const insideChat of [false, true]) {
      const popup = document.createElement('div');
      popup.setAttribute('data-radix-popper-content-wrapper', '');
      popup.innerHTML = '<a href="https://example.org/source">Hovered URL</a>';
      (insideChat ? document.querySelector('main') : document.body).append(popup);
    }
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('[data-radix-popper-content-wrapper] .ghrc-link-actions').count(), 0);
  assert.equal(await page.locator('.ghrc-link-sidebar-button').count(), 1);

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

test('image card capture handlers cannot intercept the sidebar icon', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('.ghrc-link-sidebar-button').waitFor();
  await page.addStyleTag({ content: 'main p:first-child{position:relative;pointer-events:none}#image-overlay{position:absolute;inset:0;pointer-events:auto}' });
  await page.evaluate(() => {
    const overlay = document.createElement('button');
    overlay.id = 'image-overlay';
    overlay.setAttribute('aria-label', 'Open image');
    document.querySelector('#source').parentElement.append(overlay);
    window.imageViewerClicks = 0;
    document.querySelector('main').addEventListener('click', event => {
      imageViewerClicks++;
      event.stopImmediatePropagation();
    }, true);
  });
  await page.locator('.ghrc-link-sidebar-button svg rect').click();
  await page.frameLocator('#ghrc-link-preview iframe').frameLocator('iframe').locator('h1').waitFor();
  assert.equal(await page.evaluate(() => imageViewerClicks), 0);
  assert.equal((await page.evaluate(() => openedLinks)).length, 0);
  await page.close();
});

test('ordinary link popovers keep a single sidebar icon', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('.ghrc-link-with-actions').waitFor();
  await page.evaluate(() => {
    const group = document.getElementById('source').nextElementSibling;
    const trigger = document.createElement('span');
    trigger.setAttribute('data-d-component', 'popover-trigger');
    trigger.__reactFiber$fixture = { memoizedProps: { __dilHostElement: { props: { onVisibleKey: 'https://example.org/source' } } } };
    const link = group.previousElementSibling;
    group.before(trigger);
    trigger.append(link, group);
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.ghrc-link-sidebar-button').count(), 1);
  await page.close();
});

test('inline citation icons open the first source while the citation keeps its complete source list', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true }, null, true);
  await page.evaluate(() => {
    const chip = document.createElement('button');
    chip.id = 'inline-citation';
    chip.setAttribute('data-d-component', 'popover-trigger');
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.textContent = 'GitHub Docs +1';
    let fiber = {
      memoizedProps: { __dilHostElement: { props: { children: [
        { props: { onVisibleKey: 'https://docs.github.com/en/rest/branches' } },
        { props: { onVisibleKey: 'https://docs.github.com/en/rest/commits' } },
      ] } } },
    };
    for (let level = 0; level < 19; level++) fiber = { memoizedProps: {}, return: fiber };
    chip.__reactFiber$fixture = fiber;
    window.citationOpens = 0;
    const showSources = () => {
      citationOpens++;
      if (document.getElementById('citation-list')) return;
      const list = document.createElement('div');
      list.id = 'citation-list';
      list.setAttribute('role', 'dialog');
      list.textContent = 'Branches documentation; Commits documentation';
      document.body.append(list);
    };
    chip.addEventListener('click', showSources);
    chip.addEventListener('mouseenter', showSources);
    document.querySelector('main').append(chip);
  });
  const icon = page.locator('#inline-citation + .ghrc-inline-citation-actions button');
  await icon.waitFor();
  assert.equal(await icon.getAttribute('data-href'), 'https://docs.github.com/en/rest/branches');
  await icon.click();
  assert.equal(await page.evaluate(() => citationOpens), 0);
  assert.equal((await page.evaluate(() => previewRequests)).at(-1).url, 'https://docs.github.com/en/rest/branches');
  await page.locator('#inline-citation').hover();
  assert.equal(await page.locator('#citation-list').textContent(), 'Branches documentation; Commits documentation');
  await page.locator('#inline-citation').click();
  assert.equal(await page.evaluate(() => citationOpens), 2);
  await page.evaluate(() => settingsListeners.forEach(fn => fn({ openExternalLinksInSplitView: { newValue: false } }, 'local')));
  assert.equal(await page.locator('.ghrc-inline-citation-actions').count(), 0);
  await page.close();
});

test('embedded citation buttons open the actual source beside chat without invoking native navigation', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.evaluate(() => {
    const popup = document.createElement('div');
    popup.setAttribute('role', 'dialog');
    const source = document.createElement('button');
    source.id = 'citation-source';
    source.setAttribute('data-d-component', 'pressable');
    source.setAttribute('aria-label', 'Open example.org');
    source.textContent = 'Embedded source';
    source.__reactFiber$fixture = { memoizedProps: {}, return: {
      memoizedProps: { __dilHostElement: { props: { children: { props: {
        __dilHostElement: { props: { onVisibleKey: 'https://example.org/embedded' } },
      } } } } },
    } };
    window.nativeCitationClicks = 0;
    source.addEventListener('click', () => nativeCitationClicks++);
    popup.append(source);
    document.body.append(popup);
  });
  const action = page.locator('[role="dialog"] .ghrc-link-sidebar-button');
  await action.waitFor();
  assert.equal(await action.getAttribute('data-href'), 'https://example.org/embedded');
  await action.click();
  await page.frameLocator('#ghrc-link-preview iframe').frameLocator('iframe').locator('h1').waitFor();
  assert.equal(await page.evaluate(() => nativeCitationClicks), 0);
  assert.equal((await page.evaluate(() => openedLinks)).length, 0);
  await page.close();
});

test('sidebar fallback still loads after extension APIs are invalidated by a reload', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('.ghrc-link-sidebar-button').waitFor();
  await page.evaluate(() => {
    chrome.runtime.getURL = () => { throw new Error('Extension context invalidated.'); };
    chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
  });
  await page.locator('.ghrc-link-sidebar-button').click();
  await page.frameLocator('#ghrc-link-preview iframe').frameLocator('iframe').locator('h1').waitFor();
  assert.equal(await page.frameLocator('#ghrc-link-preview iframe').frameLocator('iframe').locator('h1').textContent(), 'Source content');
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
  assert.deepEqual(headerChildren, ['ghrc-preview-destination', 'Copy link', 'Open in new tab', 'Close website preview']);

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

test('current-tab mode keeps only the separate sidebar action', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true, openExternalLinksInNewTabs: false });
  await page.locator('.ghrc-link-actions').waitFor();
  assert.equal(await page.locator('.ghrc-link-mode').count(), 0);
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


test('fallback preview puts close, copy, and open before the URL and closes after opening a tab', async () => {
  for (const onLeft of [false, true]) {
    const page = await fixture({
      openExternalLinksInSplitView: true,
      openExternalLinksInSplitViewOnLeft: onLeft,
    });
    await page.locator('.ghrc-link-sidebar-button').click();
    const preview = page.locator('#ghrc-link-preview');
    await preview.waitFor();
    const order = await preview.locator('header').evaluate(header =>
      [...header.children].map(child => child.getAttribute('aria-label') || child.className));
    assert.deepEqual(order, [
      'Close website preview', 'Copy link', 'Open in new tab', 'ghrc-preview-destination',
    ]);
    await preview.getByRole('link', { name: 'Open in new tab' }).click();
    assert.deepEqual(await page.evaluate(() => openedLinks), [
      ['https://example.org/source?keep=1#section', '_blank', 'noopener,noreferrer'],
    ]);
    assert.equal(await preview.count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-ghrc-link-preview')), false);
    assert.equal(page.url(), 'https://chatgpt.com/c/example');
    await page.close();
  }
});

test('GitHub fallback shows history arrows beside the URL and readable theme colors', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true }, {
    ok: true, title: 'Repository preview',
    entries: [{ title: 'Issues', url: 'https://github.com/owner/repo/issues' }],
  });
  await page.locator('#source').evaluate(link => { link.href = 'https://github.com/owner/repo'; });
  await page.locator('.ghrc-link-sidebar-button').click();
  const preview = page.locator('#ghrc-link-preview');
  await preview.locator('.ghrc-preview-entries a').waitFor();
  const headerChildren = await preview.locator('header').evaluate(header =>
    [...header.children].map(child => child.getAttribute('aria-label') || child.className));
  assert.deepEqual(headerChildren, [
    'Close website preview', 'Copy link', 'Open in new tab', 'Preview history', 'ghrc-preview-destination',
  ]);
  assert.equal(await preview.locator('.ghrc-preview-navigation svg').count(), 2);
  const back = preview.getByRole('button', { name: 'Back' });
  const forward = preview.getByRole('button', { name: 'Forward' });
  assert.equal(await back.isDisabled(), true);
  assert.equal(await forward.isDisabled(), true);
  const navBox = await preview.locator('.ghrc-preview-navigation').boundingBox();
  const urlBox = await preview.locator('.ghrc-preview-destination').boundingBox();
  assert.ok(navBox.x + navBox.width <= urlBox.x);

  await preview.locator('.ghrc-preview-entries a').click();
  assert.equal(await preview.locator('.ghrc-preview-destination').getAttribute('href'), 'https://github.com/owner/repo/issues');
  assert.equal(await back.isEnabled(), true);
  assert.equal(await forward.isDisabled(), true);
  await back.click();
  assert.equal(await preview.locator('.ghrc-preview-destination').getAttribute('href'), 'https://github.com/owner/repo');
  assert.equal(await forward.isEnabled(), true);
  await forward.click();
  assert.equal(await preview.locator('.ghrc-preview-destination').getAttribute('href'), 'https://github.com/owner/repo/issues');
  await preview.getByRole('button', { name: 'Copy link' }).click();
  assert.deepEqual(await page.evaluate(() => copiedLinks), ['https://github.com/owner/repo/issues']);

  const colors = () => page.evaluate(() => {
    const panel = document.querySelector('#ghrc-link-preview');
    const header = panel.querySelector('header');
    return {
      background: getComputedStyle(panel).backgroundColor,
      foreground: getComputedStyle(panel).color,
      toolbar: getComputedStyle(header).backgroundColor,
      controls: getComputedStyle(panel.querySelector('.ghrc-preview-navigation button:not(:disabled)')).backgroundColor,
    };
  });
  const light = await colors();
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  const dark = await colors();
  assert.notEqual(light.background, dark.background);
  assert.notEqual(light.foreground, dark.foreground);
  assert.notEqual(light.toolbar, dark.toolbar);
  assert.notEqual(light.controls, dark.controls);
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await preview.locator('header').evaluate(header => header.scrollWidth <= header.clientWidth), true);
  await preview.getByRole('link', { name: 'Open in new tab' }).click();
  assert.deepEqual(await page.evaluate(() => openedLinks), [
    ['https://github.com/owner/repo/issues', '_blank', 'noopener,noreferrer'],
  ]);
  assert.equal(await preview.count(), 0);
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
  await page.evaluate(watch => {
    window.nativeSplitSupported = true;
    runtimeListeners.forEach(fn => fn({
      type: 'link-preview-navigation-error',
      previewId: watch.previewId,
      url: watch.url,
    }));
  }, watch);
  await page.waitForFunction(() => previewRequests.filter(message => message.type === 'open-native-split-view').length === 2);
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

test('opening a tracked link beside chat preserves unrelated query parameters and fragments', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true }, null, true);
  const action = page.locator('.ghrc-link-sidebar-button');
  await action.waitFor();
  await page.locator('#source').evaluate(link => {
    link.href = 'https://example.org/source?utm_source=chatgpt.com&keep=1&UTM_Campaign=sidebar#section';
  });
  await page.waitForFunction(() => document.querySelector('.ghrc-link-sidebar-button')?.dataset.href
    === 'https://example.org/source?keep=1#section');
  // Even a cached unclean action URL must not bypass the navigation-time filter.
  await action.evaluate(button => { button.dataset.href = 'https://example.org/source?utm_source=chatgpt.com&keep=1#section'; });
  await action.click();
  assert.equal((await page.evaluate(() => previewRequests)).at(-1).url, 'https://example.org/source?keep=1#section');
  await page.close();
});

test('citation sidebar links strip UTM tags but preserve source metadata and setting changes', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true }, null, true);
  const tracked = 'https://example.org/citation?utm_source=chatgpt.com&keep=1&utm_medium=sidebar#section';
  const clean = 'https://example.org/citation?keep=1#section';
  await page.evaluate(href => {
    const chip = document.createElement('button');
    chip.id = 'tracked-citation';
    chip.setAttribute('data-d-component', 'popover-trigger');
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.textContent = 'Citation';
    chip.__reactFiber$fixture = { memoizedProps: { __dilHostElement: { props: {
      children: [{ props: { onVisibleKey: href } }],
    } } } };
    document.querySelector('main').append(chip);
  }, tracked);
  const action = page.locator('#tracked-citation + .ghrc-inline-citation-actions button');
  await action.waitFor();
  assert.equal(await action.getAttribute('data-href'), clean);
  assert.equal(await page.locator('#tracked-citation').getAttribute('data-ghrc-citation-url'), tracked);
  await action.click();
  assert.equal((await page.evaluate(() => previewRequests)).at(-1).url, clean);

  await page.evaluate(() => settingsListeners.forEach(listener =>
    listener({ stripUtmTracking: { newValue: false } }, 'local')));
  assert.equal(await action.getAttribute('data-href'), tracked);
  await action.click();
  assert.equal((await page.evaluate(() => previewRequests)).at(-1).url, tracked);

  await page.evaluate(() => settingsListeners.forEach(listener =>
    listener({ stripUtmTracking: { newValue: true } }, 'local')));
  assert.equal(await action.getAttribute('data-href'), clean);
  await action.click();
  assert.equal((await page.evaluate(() => previewRequests)).at(-1).url, clean);
  await page.close();
});

test('fallback sidebar preview copies the cleaned destination', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('.ghrc-link-sidebar-button').click();
  await page.frameLocator('#ghrc-link-preview iframe').frameLocator('iframe').locator('h1').waitFor();
  await page.getByRole('button', { name: 'Copy link' }).click();
  assert.deepEqual(await page.evaluate(() => copiedLinks), ['https://example.org/source?keep=1#section']);
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

test('native Markdown updates can remove decorated links from their original parent', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('.ghrc-link-with-actions').waitFor();
  const result = await page.evaluate(() => {
    const parent = document.querySelector('main p');
    const link = document.getElementById('source');
    const nativeParentPreserved = link.parentNode === parent;
    parent.removeChild(link);
    const replacement = document.createElement('a');
    replacement.id = 'replacement';
    replacement.href = 'https://example.org/updated';
    replacement.textContent = 'Updated Markdown link';
    parent.append(replacement);
    return nativeParentPreserved;
  });
  assert.equal(result, true);
  await page.locator('#replacement + .ghrc-link-with-actions').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.ghrc-link-with-actions').length === 1);
  assert.equal(await page.locator('.ghrc-link-sidebar-button').getAttribute('data-href'), 'https://example.org/updated');
  await page.close();
});


test('details source chips retain their layout with the sidebar action on the same line', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('#source').evaluate(link => {
    link.parentElement.style.cssText = 'width:360px';
    link.style.cssText = 'display:inline-flex;justify-content:space-between';
    link.dataset.testid = 'chatgpt-citation';
    link.setAttribute('aria-label', 'League of Legends: Biography, https://example.org/source, 1 additional source');
    link.innerHTML = '<span>League of Legends…</span><span>+1</span>';
  });
  await page.locator('#source.ghrc-source-citation').waitFor();
  const boxes = await page.evaluate(() => {
    const link = document.getElementById('source');
    return { link: link.getBoundingClientRect().toJSON(),
      count: link.lastElementChild.getBoundingClientRect().toJSON(),
      action: link.nextElementSibling.getBoundingClientRect().toJSON() };
  });
  assert.ok(boxes.action.left >= boxes.link.right, JSON.stringify(boxes));
  assert.ok(Math.abs(boxes.action.top - boxes.link.top) < 5, JSON.stringify(boxes));
  assert.ok(boxes.count.right <= boxes.link.right, JSON.stringify(boxes));
  assert.ok(boxes.action.right <= 360, JSON.stringify(boxes));
  await page.close();
});

test('trailing link punctuation shares the surrounding text baseline', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('.ghrc-link-with-actions').waitFor();
  await page.locator('#source').evaluate(link => {
    const paragraph = document.createElement('p');
    paragraph.style.cssText = 'font:16px/26px sans-serif';
    paragraph.append(link.cloneNode(true), document.createTextNode('. Watch the next sentence.'));
    link.parentElement.replaceWith(paragraph);
  });
  await page.locator('.ghrc-link-trailing-punctuation').waitFor();
  const boxes = await page.evaluate(() => {
    const rect = element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().toJSON();
    };
    return { link: rect(document.getElementById('source')),
      punctuation: rect(document.querySelector('.ghrc-link-trailing-punctuation')) };
  });
  assert.ok(Math.abs(boxes.link.top - boxes.punctuation.top) < 0.5, JSON.stringify(boxes));
  assert.ok(Math.abs(boxes.link.right - boxes.punctuation.left) < 0.5, JSON.stringify(boxes));
  await page.close();
});


test('details source counts keep padding inside the citation pill', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.locator('#source').evaluate(link => {
    link.dataset.testid = 'chatgpt-citation';
    link.style.cssText = 'height:18px;padding-inline:4px 8px;font:9px/9px sans-serif';
    link.innerHTML = '<span style="display:flex;align-items:center;height:100%"><span>League of Legends…</span><span id="source-count" style="display:flex;align-items:center;height:100%;padding-inline:4px;margin-inline-end:-4px">+1</span></span>';
  });
  await page.locator('#source.ghrc-source-citation').waitFor();
  const boxes = await page.locator('#source').evaluate(link => {
    const count = link.querySelector('#source-count');
    const range = document.createRange();
    range.selectNodeContents(count);
    return { pill: link.getBoundingClientRect().toJSON(), count: range.getBoundingClientRect().toJSON() };
  });
  assert.ok(boxes.pill.right - boxes.count.right >= 7.5, JSON.stringify(boxes));
  assert.ok(Math.abs((boxes.count.top + boxes.count.bottom) / 2 - (boxes.pill.top + boxes.pill.bottom) / 2) <= 1, JSON.stringify(boxes));
  await page.close();
});

test('image-source URL text remains vertically centered beside its action', async () => {
  const page = await fixture({ openExternalLinksInSplitView: true });
  await page.addStyleTag({ content: '*{box-sizing:border-box}' });
  await page.locator('#source').evaluate(link => {
    link.parentElement.style.cssText = 'display:flex;font:16px/26px sans-serif';
    link.classList.add('bg-media-control-background');
    link.style.cssText = 'display:flex;align-items:center;height:24px;font:12px/16px sans-serif;padding-inline:8px';
    link.innerHTML = '<span class="truncate">lol-walpapercave.blogspot.com</span>';
  });
  await page.locator('#source + .ghrc-link-with-actions').waitFor();
  const centers = await page.locator('#source').evaluate(link => {
    const range = document.createRange();
    range.selectNodeContents(link.firstElementChild);
    const text = range.getBoundingClientRect();
    const action = link.nextElementSibling.querySelector('.ghrc-link-actions').getBoundingClientRect();
    return { text: text.y + text.height / 2, action: action.y + action.height / 2 };
  });
  assert.ok(Math.abs(centers.text - centers.action) <= 1, JSON.stringify(centers));
  await page.close();
});
