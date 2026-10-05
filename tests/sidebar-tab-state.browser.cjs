const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

test('sidebar toggles stay in their tab while new documents start collapsed', async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    headless: true,
  });
  try {
    const context = await browser.newContext();
    await context.addCookies([{
      name: 'codex_sidebar_state', value: 'expanded', url: 'http://sidebar.test/',
    }]);
    await context.addInitScript({ path: path.join(__dirname, '../js/sidebar-tab-state.js') });
    const requestCookies = [];
    await context.route('http://sidebar.test/**', route => {
      requestCookies.push(route.request().headers().cookie || '');
      return route.fulfill({
      contentType: 'text/html',
      body: `<button id="toggle">Toggle sidebar</button><script>
        const channel = new BroadcastChannel('codex:preference-cookies');
        window.received = [];
        function readState() {
          window.sidebar = document.cookie.split('; ').find(c => c.startsWith('codex_sidebar_state='))?.split('=')[1];
        }
        channel.onmessage = event => { received.push(event.data); readState(); };
        window.addEventListener('focus', readState);
        document.getElementById('toggle').onclick = () => {
          document.cookie = 'codex_sidebar_state=' + (sidebar === 'expanded' ? 'collapsed' : 'expanded') + '; Path=/';
          readState();
          channel.postMessage('codex_sidebar_state');
        };
        window.sendPreference = value => channel.postMessage(value);
        readState();
      </script>`,
      });
    });
    const first = await context.newPage();
    const second = await context.newPage();
    await first.goto('http://sidebar.test/');
    await second.goto('http://sidebar.test/');
    assert.match(requestCookies[0], /codex_sidebar_state=expanded/);
    assert.match(requestCookies[1], /codex_sidebar_state=collapsed/);
    await first.click('#toggle');
    // A subsequent preference acts as a delivery barrier on the same channel.
    await first.evaluate(() => {
      document.cookie = 'codex_appearance_theme=dark; Path=/';
      sendPreference('codex_appearance_theme');
    });
    await second.waitForFunction(() => received.includes('codex_appearance_theme'));
    await second.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal(await first.evaluate(() => sidebar), 'expanded');
    assert.equal(await second.evaluate(() => sidebar), 'collapsed');
    assert.deepEqual(await second.evaluate(() => received), ['codex_appearance_theme']);
    assert.equal(await second.evaluate(() => document.cookie.includes('codex_appearance_theme=dark')), true);
    assert.equal((await context.cookies()).find(cookie => cookie.name === 'codex_sidebar_state')?.value, 'collapsed');
    await first.reload();
    assert.equal(await first.evaluate(() => sidebar), 'collapsed');
    assert.match(requestCookies.at(-1), /codex_sidebar_state=collapsed/);
    await second.click('#toggle');
    await first.click('#toggle');
    await first.click('#toggle');
    await second.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal(await first.evaluate(() => sidebar), 'collapsed');
    assert.equal(await second.evaluate(() => sidebar), 'expanded');
  } finally {
    await browser.close();
  }
});
