// Sample rendered frames in an unpacked extension while settings and React markup are delayed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');

for (const [shell, frame, centeredGrid] of [
  ['thread divider', 'data-app-shell-thread-edge-divider'],
  ['main content container', 'class="@container/app-shell-main-content"'],
  ['homepage grid', 'class="@container/app-shell-main-content"', true],
]) test(`compact composer stays inside the ${shell} scroll boundary`, async () => {
  const browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>
        body { margin: 0 }
        main { height: 800px; overflow: hidden }
        :is([data-app-shell-main-content-layout], [data-app-shell-thread-edge-divider],
            [class~="@container/app-shell-main-content"]) {
          --app-shell-main-content-frame-top-offset: 52px;
          --app-shell-main-content-offset: var(--app-shell-main-content-frame-top-offset);
        }
        .frame {
          margin-top: var(--app-shell-main-content-frame-top-offset);
        }
        [role="presentation"] { height: 700px; overflow-y: auto }
        :is(.home-composer-centered, [class~="sm:home-composer-centered"]) {
          margin-top: calc(-1 * var(--app-shell-main-content-offset));
        }
        .centered-grid { display: grid; height: 700px; grid-template-rows: 1fr auto 1fr }
        form { height: 52px; background: #303030; color: white }
      </style>
      <main><div data-app-shell-main-content-layout><div ${frame}><div class="frame"><div role="presentation">
        <div class="group/home-composer-layout"><div class="${shell === 'thread divider' ? '' : 'sm:'}home-composer-centered${centeredGrid ? ' centered-grid' : ''}">
          ${centeredGrid ? '<div></div><div>' : ''}
          <form><div contenteditable="true">Dash</div><button>Send</button></form>
          <section style="height:${centeredGrid ? 300 : 1000}px">Repositories</section>
          ${centeredGrid ? '</div><div></div>' : ''}
        </div></div>
      </div></div></div></div></main>
    `);
    const geometry = () => page.evaluate(() => {
      const form = document.querySelector('form').getBoundingClientRect();
      const boundary = document.querySelector('[role="presentation"]').getBoundingClientRect();
      const hit = document.elementFromPoint(form.left + 10, form.top + 2);
      return { top: form.top, bottom: form.bottom, boundaryTop: boundary.top,
        hit: Boolean(hit?.closest('form')), draft: document.querySelector('[contenteditable]').textContent };
    });
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-ghrc-new-chat', 'true');
      document.documentElement.setAttribute('data-ghrc-compact-header', 'true');
    });
    const before = await geometry();
    if (centeredGrid) {
      assert.ok(before.top > before.boundaryTop + 100, 'native grid centers the composer and dashboard');
    } else {
      assert.ok(before.top < before.boundaryTop, 'native centering reproduces the clipped composer');
    }
    await page.addStyleTag({ path: path.join(__dirname, '../css/chat/compact-header.css') });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const after = await geometry();
      assert.equal(after.top, 28);
      assert.ok(after.top >= after.boundaryTop && after.bottom <= 800);
      assert.equal(after.hit, true, 'top of composer is visible and receives pointer input');
      assert.equal(after.draft, 'Dash');
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-ghrc-show-model-controls', 'true'));
    const withControls = await geometry();
    assert.equal(withControls.boundaryTop, 52, 'visible model controls retain their inset');
    assert.equal(withControls.top, 80);
    assert.equal(withControls.hit, true);
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-ghrc-show-model-controls');
      document.documentElement.removeAttribute('data-ghrc-compact-header');
    });
    const restored = await geometry();
    assert.equal(restored.boundaryTop, 52, 'disabling compact mode restores native spacing');
    if (centeredGrid) assert.equal(restored.top, before.top, 'disabling compact mode restores grid centering');
  } finally {
    await browser.close();
  }
});

for (const [route, width, legacy, enabled] of [
  ['/', 1280, false, true],
  ['/?temporary-chat=true', 390, true, true],
  ['/', 1280, false, false],
  ['/c/existing', 1280, false, true],
]) {
  test(`homepage first paint precedes settings and composer hydration (${route}, ${width}, compact=${enabled})`, async () => {
    const root = path.resolve(__dirname, '..');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-startup-'));
    const extension = path.join(temporary, 'extension');
    fs.mkdirSync(extension);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const entry = manifest.content_scripts.find(e => e.js?.includes('js/chat/compact-header.js'));
    assert.equal(entry.run_at, 'document_start');
    assert.ok(entry.js.indexOf('js/chat/compact-header.js') > entry.js.indexOf('js/core/extension-context.js'));
    for (const file of ['js/core/extension-context.js', 'js/chat/compact-header.js', 'css/chat/compact-header.css']) {
      fs.mkdirSync(path.dirname(path.join(extension, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(extension, file));
    }
    fs.writeFileSync(path.join(extension, 'delay-settings.js'), `
      const nativeGet = chrome.storage.local.get.bind(chrome.storage.local);
      const released = new Promise(resolve => document.addEventListener('test:release-settings', resolve, {once:true}));
      chrome.storage.local.get = async defaults => {
        document.documentElement.setAttribute('data-test-settings-pending', 'true');
        await released;
        document.documentElement.removeAttribute('data-test-settings-pending');
        return nativeGet(defaults);
      };
    `);
    fs.writeFileSync(path.join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
    // Exercise the real settings controls and save handler with an empty vault.
    // This isolated extension never loads the user's credentials or profile.
    for (const file of ['js/settings/options.js', 'js/settings/popup.js', 'js/settings/options-page.js', 'js/dashboard/repository-search-shortcut.js']) {
      fs.mkdirSync(path.dirname(path.join(extension, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(extension, file));
    }
    fs.writeFileSync(path.join(extension, 'empty-vault.js'), 'globalThis.TokenVault={loadTokens:async()=>[],saveTokens:async()=>{},clearTokens:async()=>{}};');
    for (const file of ['popup.html', 'options.html']) {
      const markup = fs.readFileSync(path.join(root, file), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
        .replace('</body>', `<script src="empty-vault.js"></script><script src="js/dashboard/repository-search-shortcut.js"></script><script src="js/settings/options.js"></script><script src="js/settings/${file === 'popup.html' ? 'popup' : 'options-page'}.js"></script></body>`);
      fs.writeFileSync(path.join(extension, file), markup);
    }
    fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({
      manifest_version: 3, name: 'Compact first paint fixture', version: '1.0', permissions: ['storage'],
      background: {service_worker: 'background.js'},
      content_scripts: [{matches:['http://127.0.0.1/*'], run_at:'document_start',
        css:['css/chat/compact-header.css'], js:['js/core/extension-context.js','delay-settings.js','js/chat/compact-header.js']}],
    }));
    const timers = new Set();
    const server = http.createServer((request, response) => {
      response.writeHead(200, {'content-type':'text/html'});
      response.write(`<html><head><style>body{margin:0}main{padding-top:64px}[data-app-shell-main-content-layout]{--app-shell-main-content-frame-top-offset:52px;padding-top:var(--app-shell-main-content-frame-top-offset)}.stack{display:flex;flex-direction:column;justify-content:center;min-height:calc(100vh - 64px)}form{width:min(720px,calc(100% - 24px));margin-inline:auto;height:80px}h1{margin:0;height:60px}</style></head><body><main><div data-app-shell-main-content-layout="default"><div ${legacy ? 'id="thread"' : 'class="stack group/home-composer-layout"'} ${legacy ? 'class="stack"' : ''}>${legacy ? '<h1 id="welcome">Welcome</h1>' : '<div class="home-composer-anchor" id="welcome"><h1>Welcome</h1></div>'}<script>
        window.framesSeen=[];
        function sample(){const w=document.getElementById('welcome'),c=document.querySelector('form');if(w)framesSeen.push({welcomeVisible:!!w.getClientRects().length,composerTop:c?.getBoundingClientRect().top,pending:document.documentElement.hasAttribute('data-test-settings-pending')});requestAnimationFrame(sample)}requestAnimationFrame(sample);
      </script>`);
      const timer = setTimeout(() => {
        timers.delete(timer);
        response.end('<form><div id="prompt-textarea" contenteditable="true"></div><button type="button">Send</button></form></div></div></main></body></html>');
      }, 300);
      timers.add(timer);
    });
    let context;
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
        executablePath: process.env.BROWSER_EXECUTABLE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        headless:true, viewport:{width,height:800}, args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
      });
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      await worker.evaluate(enabled => chrome.storage.local.set({compactNewChatHeader:enabled}), enabled);
      const page = await context.newPage();
      const errors=[];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}${route}`, {waitUntil:'domcontentloaded'});
      await page.waitForFunction(() => framesSeen.filter(f => f.composerTop !== undefined).length >= 8);
      const frames = await page.evaluate(() => framesSeen);
      const home = !route.startsWith('/c/');
      assert.ok(frames.some(f => f.composerTop === undefined), 'sample welcome before composer hydration');
      assert.ok(frames.every(f => f.pending), 'settings must still be pending for every sampled frame');
      assert.ok(frames.every(f => f.welcomeVisible === !home), JSON.stringify(frames));
      if (home) assert.ok(frames.filter(f => f.composerTop !== undefined).every(f => f.composerTop === 28), JSON.stringify(frames));
      await page.evaluate(() => document.dispatchEvent(new Event('test:release-settings')));
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-test-settings-pending'));
      const final = await page.evaluate(() => ({welcomeVisible:!!document.getElementById('welcome').getClientRects().length,top:document.querySelector('form').getBoundingClientRect().top}));
      assert.equal(final.welcomeVisible, !home || !enabled);
      if (home && enabled) assert.equal(final.top, 28);
      if (!home || !enabled) assert.ok(final.top > 300);
      await page.locator('#prompt-textarea').fill('Keep this draft');
      await page.evaluate(() => document.querySelector('form').insertAdjacentHTML('afterend',
        '<button id="ghrc-spellcheck-gpt-launcher">Spellcheck</button><button id="ghrc-clipboard-open-url-button">Clipboard</button><section id="github-repositories-for-chatgpt">Repositories</section>'));
      await worker.evaluate(() => chrome.storage.local.set({ hideNewChatComposer: true }));
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-ghrc-hide-new-chat-composer'));
      assert.equal(await page.locator('form').isVisible(), !home);
      assert.equal(await page.locator('#ghrc-spellcheck-gpt-launcher').isVisible(), !home);
      assert.equal(await page.locator('#ghrc-clipboard-open-url-button').isVisible(), !home);
      assert.equal(await page.locator('#github-repositories-for-chatgpt').isVisible(), true);
      await worker.evaluate(() => chrome.storage.local.set({ hideNewChatComposer: false }));
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ghrc-hide-new-chat-composer'));
      assert.equal(await page.locator('form').isVisible(), true);
      assert.equal(await page.locator('#prompt-textarea').innerText(), 'Keep this draft');
      if (home && enabled && width === 1280) {
        for (const file of ['popup.html', 'options.html']) {
          const settingsPage = await context.newPage();
          settingsPage.on('pageerror', error => errors.push(error.message));
          await settingsPage.goto(worker.url().replace(/background\.js$/, file));
          await settingsPage.waitForFunction(() => tokenStateLoaded);
          await settingsPage.getByRole('tab', { name: 'ChatGPT', exact: true }).click();
          const toggle = settingsPage.getByRole('checkbox', { name: /Hide new-chat composer bar/ });
          assert.equal(await toggle.isChecked(), false);
          await toggle.check();
          await page.waitForFunction(() => document.documentElement.hasAttribute('data-ghrc-hide-new-chat-composer'));
          assert.equal(await page.locator('form').isVisible(), false);
          await settingsPage.reload();
          await settingsPage.waitForFunction(() => tokenStateLoaded);
          await settingsPage.getByRole('tab', { name: 'ChatGPT', exact: true }).click();
          assert.equal(await toggle.isChecked(), true, 'saved preference survives reopening settings');
          await toggle.uncheck();
          await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ghrc-hide-new-chat-composer'));
          assert.equal(await page.locator('form').isVisible(), true);
          assert.equal(await page.locator('#prompt-textarea').innerText(), 'Keep this draft');
          await settingsPage.close();
        }
      }
      assert.deepEqual(errors, []);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      await context?.close();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(temporary, {recursive:true,force:true});
    }
  });
}
