// Sample rendered frames in an unpacked extension while settings and React markup are delayed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');

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
    const entry = manifest.content_scripts.find(e => e.js?.includes('js/compact-header.js'));
    assert.equal(entry.run_at, 'document_start');
    assert.equal(entry.js[1], 'js/compact-header.js');
    for (const file of ['js/extension-context.js', 'js/compact-header.js', 'css/compact-header.css']) {
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
    fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({
      manifest_version: 3, name: 'Compact first paint fixture', version: '1.0', permissions: ['storage'],
      background: {service_worker: 'background.js'},
      content_scripts: [{matches:['http://127.0.0.1/*'], run_at:'document_start',
        css:['css/compact-header.css'], js:['js/extension-context.js','delay-settings.js','js/compact-header.js']}],
    }));
    const timers = new Set();
    const server = http.createServer((request, response) => {
      response.writeHead(200, {'content-type':'text/html'});
      response.write(`<html><head><style>body{margin:0}main{padding-top:64px}.stack{display:flex;flex-direction:column;justify-content:center;min-height:calc(100vh - 64px)}form{width:min(720px,calc(100% - 24px));margin-inline:auto;height:80px}h1{margin:0;height:60px}</style></head><body><main><div ${legacy ? 'id="thread"' : 'class="stack group/home-composer-layout"'} ${legacy ? 'class="stack"' : ''}>${legacy ? '<h1 id="welcome">Welcome</h1>' : '<div class="home-composer-anchor" id="welcome"><h1>Welcome</h1></div>'}<script>
        window.framesSeen=[];
        function sample(){const w=document.getElementById('welcome'),c=document.querySelector('form');if(w)framesSeen.push({welcomeVisible:!!w.getClientRects().length,composerTop:c?.getBoundingClientRect().top,pending:document.documentElement.hasAttribute('data-test-settings-pending')});requestAnimationFrame(sample)}requestAnimationFrame(sample);
      </script>`);
      const timer = setTimeout(() => {
        timers.delete(timer);
        response.end('<form><div id="prompt-textarea" contenteditable="true"></div><button type="button">Send</button></form></div></main></body></html>');
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
      if (home) assert.ok(frames.filter(f => f.composerTop !== undefined).every(f => f.composerTop < 100), JSON.stringify(frames));
      await page.evaluate(() => document.dispatchEvent(new Event('test:release-settings')));
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-test-settings-pending'));
      const final = await page.evaluate(() => ({welcomeVisible:!!document.getElementById('welcome').getClientRects().length,top:document.querySelector('form').getBoundingClientRect().top}));
      assert.equal(final.welcomeVisible, !home || !enabled);
      if (home && enabled) assert.ok(final.top < 100);
      if (!home || !enabled) assert.ok(final.top > 300);
      assert.deepEqual(errors, []);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      await context?.close();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(temporary, {recursive:true,force:true});
    }
  });
}
