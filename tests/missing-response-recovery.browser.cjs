const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '../js/missing-response-recovery.js'), 'utf8');
let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
});
after(async () => { await browser?.close(); });

async function fixture({ draft = '', active = false, queued = false, fail = false, delayed = false, remainBroken = false } = {}) {
  const p = await browser.newPage();
  let loads = 0;
  let reads = 0;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.clock.install();
  await p.addInitScript({ content: source });
  await p.route('https://recovery.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') {
      return route.fulfill({ json: { accessToken: 'fixture-only' } });
    }
    if (url.pathname.startsWith('/backend-api/conversation/')) {
      reads++;
      if (delayed) await held;
      return route.fulfill({ status: fail ? 429 : 200, json: {
        current_node: 'a', mapping: {
          u: { id: 'u', parent: null, message: { author: { role: 'user' } } },
          a: { id: 'a', parent: 'u', message: { id: 'a', author: { role: 'assistant' }, channel: 'final',
            status: 'finished_successfully', content: { content_type: 'text', parts: ['Saved answer'] } } },
        },
      } });
    }
    loads++;
    return route.fulfill({ contentType: 'text/html', body: `
      <div data-app-action-timeline-scroll style="height:300px;overflow:auto">
        <div data-turn-key="u" style="height:900px">Question <p id="answer"></p></div>
      </div>
      <form><textarea id="prompt-textarea">${draft}</textarea>${active ? '<button aria-label="Stop">Stop</button>' : ''}</form>
      ${queued ? '<aside id="ghrc-message-queue">Queued prompt</aside>' : ''}
      <script>
        const turn = document.querySelector('[data-turn-key]');
        const restored = sessionStorage.getItem('ghrc-missing-response-recovery:test');
        const items = [{type:'user-message'}, {type:'chatgpt-reasoning-group',completed:true,items:[]}];
        if(restored && !${remainBroken}) { items.push({type:'assistant-message'}); document.getElementById('answer').textContent = 'Saved answer'; }
        turn.__reactFiber$fixture = {memoizedProps:{entry:{turn:{status:'complete',items}}}};
        document.querySelector('[data-app-action-timeline-scroll]').scrollTop = restored ? 0 : 180;
      </script>` });
  });
  await p.goto('https://recovery.test/c/test');
  return { p, errors, loads: () => loads, reads: () => reads, release };
}

async function settle(p) {
  await p.clock.runFor(20_000);
  // Allow mocked HTTP requests and any resulting navigation to finish.
  await p.waitForTimeout(150);
}

test('recovers a saved missing answer once and restores the viewport', async () => {
  const f = await fixture();
  await settle(f.p);
  await f.p.waitForFunction(() => document.getElementById('answer')?.textContent === 'Saved answer');
  await f.p.clock.runFor(1_000);
  assert.equal(f.loads(), 2);
  assert.equal(await f.p.locator('[data-app-action-timeline-scroll]').evaluate(e => e.scrollTop), 180);
  await settle(f.p);
  assert.equal(f.loads(), 2);
  assert.deepEqual(f.errors, []);
  await f.p.close();
});

test('drafts, active responses and queued prompts prevent both reads and reloads', async () => {
  for (const options of [{ draft: 'Keep my draft' }, { active: true }, { queued: true }]) {
    const f = await fixture(options);
    await settle(f.p);
    assert.equal(f.reads(), 0);
    assert.equal(f.loads(), 1);
    assert.equal(await f.p.locator('textarea').inputValue(), options.draft || '');
    await f.p.close();
  }
});

test('a draft typed during the saved-answer request cancels recovery', async () => {
  const f = await fixture({ delayed: true });
  await settle(f.p);
  assert.equal(f.reads(), 1);
  await f.p.locator('textarea').fill('New draft');
  f.release();
  await f.p.waitForTimeout(150);
  assert.equal(f.loads(), 1);
  assert.equal(await f.p.locator('textarea').inputValue(), 'New draft');
  await f.p.close();
});

test('rate limits do not reload or repeatedly fetch', async () => {
  const f = await fixture({ fail: true });
  await settle(f.p);
  await f.p.clock.runFor(20_000);
  assert.equal(f.reads(), 1);
  assert.equal(f.loads(), 1);
  assert.deepEqual(f.errors, []);
  await f.p.close();
});

test('a failed repair cannot become a reload loop', async () => {
  const f = await fixture({ remainBroken: true });
  await settle(f.p);
  await f.p.waitForFunction(() => sessionStorage.getItem('ghrc-missing-response-recovery:test'));
  await settle(f.p);
  assert.equal(f.loads(), 2);
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.errors, []);
  await f.p.close();
});

test('a late native answer cancels recovery after the network read', async () => {
  const f = await fixture({ delayed: true });
  await settle(f.p);
  assert.equal(f.reads(), 1);
  await f.p.evaluate(() => {
    document.querySelector('[data-turn-key]').__reactFiber$fixture.memoizedProps.entry.turn.items
      .push({ type: 'assistant-message' });
    document.getElementById('answer').textContent = 'Native answer';
  });
  f.release();
  await f.p.waitForTimeout(150);
  assert.equal(f.loads(), 1);
  assert.equal(await f.p.locator('#answer').textContent(), 'Native answer');
  await f.p.close();
});
