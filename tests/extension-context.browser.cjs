const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
});
after(async () => { await browser?.close(); });
async function fixture({ delayed = false } = {}) {
  const p = await browser.newPage();
  p.errors = []; p.warnings = [];
  p.on('pageerror', e => p.errors.push(e.message));
  p.on('console', e => { if (e.type() === 'warning') p.warnings.push(e.text()); });
  await p.route('https://context.test/**', r => r.fulfill({ contentType: 'text/html', body: '<main><form><textarea id="prompt-textarea"></textarea><button id="send">Send</button></form></main>' }));
  await p.goto('https://context.test/');
  await p.evaluate(({ delayed }) => {
    window.calls = 0; window.listeners = []; window.pending = [];
    window.chrome = { runtime: { id: 'fixture', onMessage: { addListener(fn) { window.runtimeListener = fn; } }, getURL: p => `chrome-extension://fixture/${p}`, sendMessage: async () => ({ ok: true, owners: [] }) }, storage: { local: {
      get: async defaults => {
        calls++;
        if (delayed) return await new Promise((resolve, reject) => pending.push({ resolve, reject, defaults }));
        return { ...defaults, pinnedRepositories: ['owner/repo'], showClipboardSendButton: true, showSpellcheckGptLauncher: true };
      }, set: async () => {}, remove: async () => {},
    }, onChanged: { addListener(fn) { listeners.push(fn); } } } };
    window.__ghrcMessageQueue = { findActionButton: () => document.getElementById('send'), enqueueText: async t => { window.queued = t; return true; } };
  }, { delayed });
  await p.addScriptTag({ content: read('js/extension-context.js') });
  return p;
}
for (const mode of ['missing-runtime', 'missing-storage', 'rejected-request']) {
  test(`warm pins survive ${mode} without unhandled errors or repeated API calls`, async () => {
    const p = await fixture({ delayed: mode === 'rejected-request' });
    await p.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<section id="github-repositories-for-chatgpt"><p class="ghrc-state">Loading repositories…</p></section>'); });
    await p.addScriptTag({ content: read('js/repository-fast-ui.js') });
    await p.evaluate(mode => {
      if (mode === 'missing-runtime') chrome.runtime = undefined;
      else if (mode === 'missing-storage') chrome.storage = undefined;
      else pending.forEach(p => p.reject(new Error('Extension context invalidated.')));
      document.body.append(document.createElement('div'));
    }, mode);
    await p.waitForTimeout(50);
    const calls = await p.evaluate(() => window.calls);
    await p.evaluate(() => document.body.append(document.createElement('div')));
    await p.waitForTimeout(50);
    assert.equal(await p.evaluate(() => window.calls), calls);
    assert.equal(await p.evaluate(() => __ghrcExtensionContext.active()), false);
    assert.deepEqual(p.errors, []); assert.deepEqual(p.warnings, []);
    await p.close();
  });
}
test('normal warm pins render and unpin', async () => {
  const p = await fixture();
  await p.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<section id="github-repositories-for-chatgpt"><p class="ghrc-state">Loading repositories…</p></section>'));
  await p.addScriptTag({ content: read('js/repository-fast-ui.js') });
  await p.getByRole('button', { name: 'Unpin owner/repo' }).click();
  assert.equal(await p.locator('.ghrc-repository').count(), 0);
  assert.deepEqual(p.errors, []);
  await p.close();
});
test('pending settings reject safely in display, clipboard, dashboard and spellcheck scripts', async () => {
  const p = await fixture({ delayed: true });
  await p.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<section id="github-repositories-for-chatgpt"><footer class="ghrc-dashboard-footer"></footer></section>'));
  for (const script of ['compact-header', 'collapse-sidebar', 'chat-display', 'clipboard-send', 'content', 'spellcheck-launcher', 'force-high-thinking', 'owner-grid', 'hide-cookie-preferences', 'chatgpt-disclaimer', 'block-voice-prompts', 'youtube-search', 'highlighted-pages']) {
    await p.addScriptTag({ content: read(`js/${script}.js`) });
  }
  await p.evaluate(() => {
    chrome.runtime = undefined; chrome.storage = undefined;
    pending.forEach(p => p.reject(new Error('Extension context invalidated.')));
    document.body.append(document.createElement('div'));
    window.dispatchEvent(new Event('resize'));
  });
  await p.waitForTimeout(100);
  assert.deepEqual(p.errors, []); assert.deepEqual(p.warnings, []);
  assert.equal(await p.evaluate(() => __ghrcExtensionContext.active()), false);
  await p.close();
});
test('clipboard denial preserves the draft, resets the button, and permits a retry', async () => {
  const p = await fixture();
  await p.evaluate(() => {
    document.getElementById('prompt-textarea').value = 'Partial draft';
    navigator.clipboard.readText = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await p.addScriptTag({ content: read('js/clipboard-send.js') });
  const button = p.locator('#ghrc-clipboard-send-button');
  await button.click();
  assert.equal(await button.isEnabled(), true);
  assert.match(await button.getAttribute('title'), /paste into the composer/);
  assert.equal(await p.locator('textarea').inputValue(), 'Partial draft');
  await p.evaluate(() => { navigator.clipboard.readText = async () => 'Retry text'; });
  await button.click();
  assert.equal(await p.evaluate(() => queued), 'Retry text');
  assert.deepEqual(p.errors, []); assert.deepEqual(p.warnings, []);
  await p.close();
});
test('the lifecycle bootstrap runs before API-consuming content scripts', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const early = manifest.content_scripts.find(s => s.run_at === 'document_start' && s.world !== 'MAIN');
  assert.equal(early.js[0], 'js/extension-context.js');
});

for (const script of ['avatar-cache-ui', 'message-queue']) {
  test(`${script} handles a pending request rejected during reload`, async () => {
    const p = await fixture({ delayed: true });
    if (script === 'avatar-cache-ui') await p.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<section id="github-repositories-for-chatgpt"><img class="ghrc-owner-avatar" src="https://avatars.githubusercontent.com/u/1"></section>');
    });
    await p.addScriptTag({ content: read(`js/${script}.js`) });
    assert.ok(await p.evaluate(() => pending.length > 0));
    await p.evaluate(() => {
      chrome.runtime = undefined; chrome.storage = undefined;
      pending.forEach(p => p.reject(new Error('Extension context invalidated.')));
      history.pushState({}, '', '/c/after-reload');
      window.dispatchEvent(new PopStateEvent('popstate'));
      document.body.append(document.createElement('div'));
    });
    await p.waitForTimeout(100);
    const calls = await p.evaluate(() => window.calls);
    await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => window.calls), calls);
    assert.deepEqual(p.errors, []); assert.deepEqual(p.warnings, []);
    assert.equal(await p.evaluate(() => __ghrcExtensionContext.active()), false);
    await p.close();
  });
}
test('queue navigation catches invalidation after its storage read starts', async () => {
  const p = await fixture({ delayed: true });
  await p.addScriptTag({ content: read('js/message-queue.js') });
  await p.evaluate(() => { pending.forEach(p => p.resolve(p.defaults)); pending = []; });
  await p.waitForTimeout(50);
  await p.evaluate(() => {
    history.pushState({}, '', '/c/new-conversation');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await p.waitForFunction(() => pending.length > 0);
  await p.evaluate(() => pending.forEach(p => p.reject(new Error('Extension context invalidated.'))));
  await p.waitForTimeout(100);
  assert.deepEqual(p.errors, []); assert.deepEqual(p.warnings, []);
  assert.equal(await p.evaluate(() => __ghrcExtensionContext.active()), false);
  await p.close();
});

for (const pendingAction of ['get', 'set']) {
  test(`guidance sync cancels a pending ${pendingAction} bridge quietly on reload`, async () => {
    const p = await fixture();
    await p.evaluate(pendingAction => {
      window.bridgeRequests = [];
      window.guidanceWrites = 0;
      chrome.storage.local.get = async () => ({
        webCommitGuidance: 'Local', webCommitGuidanceLastSynced: 'Remote',
      });
      chrome.storage.local.set = async () => { guidanceWrites++; };
      window.addEventListener('message', event => {
        const message = event.data;
        if (message?.channel !== 'flawless-web-commit-guidance' || message.direction !== 'request') return;
        bridgeRequests.push(message.action);
        if (message.action === pendingAction) return;
        window.postMessage({ ...message, direction: 'response', ok: true, guidance: 'Remote' }, location.origin);
      });
    }, pendingAction);
    await p.addScriptTag({ content: read('js/web-commit-guidance-sync.js') });
    await p.waitForFunction(action => bridgeRequests.includes(action), pendingAction);
    await p.evaluate(() => {
      chrome.runtime = undefined;
      __ghrcExtensionContext.active();
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await p.waitForTimeout(100);
    assert.deepEqual(p.errors, []);
    assert.deepEqual(p.warnings, []);
    assert.equal(await p.evaluate(() => guidanceWrites), 0);
    assert.deepEqual(await p.evaluate(() => bridgeRequests), pendingAction === 'get' ? ['get'] : ['get', 'set']);
    await p.close();
  });
}
