const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = [
  'vendor/showdown.min.js',
  'vendor/purify.min.js',
  'js/core/chatgpt-route-events.js',
  'js/chat/missing-response-recovery.js',
].map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n;\n');
let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
});
after(async () => { await browser?.close(); });

async function fixture({ draft = '', active = false, queued = false, fail = false, delayed = false, remainBroken = false, reasoningSteps = 0, toolReasoning = false, earlierMissing = false, savedText = 'Saved answer', noMessageId = false } = {}) {
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
          earlier: { id: 'earlier', parent: null, message: { author: { role: 'user' } } },
          u: { id: 'u', parent: earlierMissing ? 'earlier' : null, message: { author: { role: 'user' } } },
          a: { id: 'a', parent: 'u', message: { id: noMessageId ? undefined : 'a', author: { role: 'assistant' }, channel: 'final',
            status: 'finished_successfully', content: { content_type: 'text', parts: [savedText] } } },
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
        const items = [{type:'user-message'}, {type:'chatgpt-reasoning-group',completed:true,items:Array.from({length:${reasoningSteps}},()=>({type:'reasoning',completed:true}))}];
        if (${toolReasoning}) items[1].items.push({type:'assistant-message',completed:true},{type:'mcp-tool-call',completed:false});
        if(restored && !${remainBroken}) { items.push({type:'assistant-message'}); document.getElementById('answer').textContent = 'Saved answer'; }
        turn.__reactFiber$fixture = {memoizedProps:{entry:{turn:{status:'complete',items}}}};
        if (${earlierMissing}) {
          const earlier = document.createElement('div');
          earlier.dataset.turnKey = 'earlier';
          earlier.__reactFiber$fixture = {memoizedProps:{entry:{turn:{status:'complete',items:[{type:'user-message'},{type:'chatgpt-reasoning-group',completed:true,items:[]}]}}}};
          turn.before(earlier);
        }
        document.querySelector('[data-app-action-timeline-scroll]').scrollTop = restored ? 0 : 180;
      </script>` });
  });
  await p.goto('https://recovery.test/c/test');
  return { p, errors, loads: () => loads, reads: () => reads, release,
    setSavedText: text => { savedText = text; } };
}

async function settle(p) {
  await p.clock.runFor(2_000);
  // Allow mocked HTTP requests and any resulting navigation to finish.
  await p.waitForTimeout(150);
}

test('restores a saved answer in place and preserves the viewport', async () => {
  const f = await fixture();
  await settle(f.p);
  await f.p.waitForFunction(() => document.querySelector('[data-ghrc-recovered-answer]')?.textContent === 'Saved answer');
  await f.p.clock.runFor(1_000);
  assert.equal(f.loads(), 1);
  assert.equal(await f.p.locator('[data-app-action-timeline-scroll]').evaluate(e => e.scrollTop), 180);
  await settle(f.p);
  assert.equal(f.loads(), 1);
  assert.deepEqual(f.errors, []);
  await f.p.close();
});

test('recovers completed reasoning despite an earlier turn with no saved answer', async () => {
  const f = await fixture({ reasoningSteps: 4, earlierMissing: true });
  await settle(f.p);
  await f.p.waitForFunction(() => document.querySelector('[data-ghrc-recovered-answer]')?.textContent === 'Saved answer');
  assert.equal(f.loads(), 1);
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.errors, []);
  await f.p.close();
});

test('recovers a completed tool turn while preserving the draft', async () => {
  const f = await fixture({ toolReasoning: true, draft: 'Keep my draft' });
  await settle(f.p);
  await f.p.waitForFunction(() => document.querySelector('[data-ghrc-recovered-answer]')?.textContent === 'Saved answer');
  assert.equal(await f.p.locator('textarea').inputValue(), 'Keep my draft');
  assert.equal(f.loads(), 1);
  assert.deepEqual(f.errors, []);
  await f.p.close();
});

test('drafts, active responses and queued prompts allow recovery without reloading', async () => {
  for (const options of [{ draft: 'Keep my draft' }, { active: true }, { queued: true }]) {
    const f = await fixture(options);
    await settle(f.p);
    assert.equal(f.reads(), 1);
    assert.equal(await f.p.locator('[data-ghrc-recovered-answer]').textContent(), 'Saved answer');
    assert.equal(f.loads(), 1);
    assert.equal(await f.p.locator('textarea').inputValue(), options.draft || '');
    await f.p.close();
  }
});

test('a draft typed during the saved-answer request survives recovery', async () => {
  const f = await fixture({ delayed: true });
  await settle(f.p);
  assert.equal(f.reads(), 1);
  await f.p.locator('textarea').fill('New draft');
  f.release();
  await f.p.waitForTimeout(150);
  assert.equal(f.loads(), 1);
  assert.equal(await f.p.locator('textarea').inputValue(), 'New draft');
  assert.equal(await f.p.locator('[data-ghrc-recovered-answer]').textContent(), 'Saved answer');
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

test('a removed recovery is restored without navigation or another request', async () => {
  const f = await fixture({ remainBroken: true });
  await settle(f.p);
  await f.p.locator('[data-ghrc-recovered-answer]').evaluate(e => e.remove());
  await f.p.clock.runFor(2_000);
  assert.equal(await f.p.locator('[data-ghrc-recovered-answer]').textContent(), 'Saved answer');
  assert.equal(f.loads(), 1);
  assert.deepEqual(f.errors, []);
  await f.p.close();
});

test('refreshes an incomplete saved final even when its message ID stays the same', async () => {
  const f = await fixture({ savedText: 'Closing paragraph', draft: 'Keep my draft', active: true });
  await settle(f.p);
  assert.equal(await f.p.locator('[data-ghrc-recovered-answer]').textContent(), 'Closing paragraph');
  f.setSavedText('Opening paragraph\n\nClosing paragraph');
  await f.p.clock.runFor(16_000);
  await f.p.waitForFunction(() => document.querySelector('[data-ghrc-recovered-answer]')?.textContent.includes('Opening paragraph'));
  assert.equal(f.reads(), 2);
  assert.equal(f.loads(), 1);
  assert.equal(await f.p.locator('textarea').inputValue(), 'Keep my draft');
  assert.equal(await f.p.locator('[aria-label="Stop"]').count(), 1);
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

test('a native answer replaces recovered text without duplication', async () => {
  const f = await fixture();
  await settle(f.p);
  await f.p.evaluate(() => {
    document.querySelector('[data-turn-key]').__reactFiber$fixture.memoizedProps.entry.turn.items.push({type:'assistant-message'});
    document.getElementById('answer').textContent = 'Native answer';
  });
  await f.p.clock.runFor(2_000);
  assert.equal(await f.p.locator('[data-ghrc-recovered-answer]').count(), 0);
  assert.equal(await f.p.locator('#answer').textContent(), 'Native answer');
  await f.p.close();
});

test('restores full saved text safely when only the mapping node has an ID', async () => {
  const text = '# Heading\n\n<script>throw new Error("unsafe")</script>\n\n    indented code';
  const f = await fixture({ savedText: text, noMessageId: true, active: true, queued: true, draft: 'Keep this' });
  await settle(f.p);
  assert.equal(await f.p.locator('[data-ghrc-recovered-answer] h1').textContent(), 'Heading');
  assert.equal(await f.p.locator('[data-ghrc-recovered-answer] pre code').textContent(), 'indented code\n');
  assert.equal(await f.p.locator('[data-ghrc-recovered-answer] script').count(), 0);
  await f.p.clock.runFor(60_000);
  assert.equal(f.reads(), 4);
  assert.equal(f.loads(), 1);
  assert.deepEqual(f.errors, []);
  await f.p.close();
});

test('navigation during a saved-answer read cancels insertion', async () => {
  const f = await fixture({ delayed: true });
  await settle(f.p);
  await f.p.evaluate(() => history.pushState({}, '', '/c/other'));
  f.release();
  await f.p.waitForTimeout(150);
  assert.equal(await f.p.locator('[data-ghrc-recovered-answer]').count(), 0);
  await f.p.close();
});

test('idle recovery stops after fifteen minutes and wakes on a new composer edit', async () => {
  const f = await fixture();
  await settle(f.p);
  assert.equal(await f.p.locator('[data-ghrc-recovered-answer]').textContent(), 'Saved answer');
  await f.p.clock.fastForward(15 * 60_000 + 2_000);
  // The inactivity cutoff clears the cached conversation and cancels polling.
  await f.p.locator('[data-ghrc-recovered-answer]').evaluate(node => node.remove());
  const reads = f.reads();
  await f.p.locator('#answer').click();
  await f.p.clock.runFor(8_000);
  assert.equal(await f.p.locator('[data-ghrc-recovered-answer]').count(), 0,
    'unrelated UI interactions cannot restart an idle recovery scan');
  assert.equal(f.reads(), reads, 'no further API reads in a settled chat');

  await f.p.locator('textarea').fill('A new user prompt');
  await f.p.clock.runFor(2_000);
  await f.p.waitForFunction(() => document.querySelector('[data-ghrc-recovered-answer]')?.textContent === 'Saved answer');
  assert.equal(f.reads(), reads + 1, 'new prompt activity restarts the scanner and its cache');
  assert.equal(await f.p.locator('textarea').inputValue(), 'A new user prompt');
  assert.deepEqual(f.errors, []);
  await f.p.close();
});

test('navigation pauses recovery until a prompt in the new conversation', async () => {
  const f = await fixture();
  await settle(f.p);
  assert.equal(await f.p.locator('[data-ghrc-recovered-answer]').textContent(), 'Saved answer');
  await f.p.evaluate(() => history.pushState({}, '', '/c/different'));
  await f.p.locator('[data-ghrc-recovered-answer]').evaluate(node => node.remove());
  const reads = f.reads();
  await f.p.clock.runFor(8_000);
  assert.equal(f.reads(), reads);
  assert.equal(await f.p.locator('[data-ghrc-recovered-answer]').count(), 0);

  await f.p.locator('textarea').fill('Continue this conversation');
  await f.p.clock.runFor(2_000);
  await f.p.waitForFunction(() => document.querySelector('[data-ghrc-recovered-answer]')?.textContent === 'Saved answer');
  assert.equal(f.reads(), reads + 1, 'a new prompt in the destination chat restarts recovery');
  assert.deepEqual(f.errors, []);
  await f.p.close();
});

test('a cancelled recovery request cannot delay the next conversation', async () => {
  const f = await fixture({ delayed: true });
  await settle(f.p);
  assert.equal(f.reads(), 1, 'the first conversation began a saved-answer read');
  await f.p.evaluate(() => history.pushState({}, '', '/c/fresh'));
  f.release();
  await f.p.waitForTimeout(150);
  assert.equal(await f.p.locator('[data-ghrc-recovered-answer]').count(), 0,
    'aborted results from the previous conversation must not be inserted');
  await f.p.locator('textarea').fill('A new prompt after navigation');
  await f.p.clock.runFor(2_000);
  await f.p.waitForFunction(() => document.querySelector('[data-ghrc-recovered-answer]')?.textContent === 'Saved answer');
  assert.equal(f.reads(), 2,
    'a stale request must not impose a minute-long retry cooldown on the new conversation');
  assert.deepEqual(f.errors, []);
  await f.p.close();
});

test('sending from a new chat keeps recovery awake across creation of its conversation', async () => {
  const f = await fixture();
  await settle(f.p);
  await f.p.evaluate(() => {
    history.pushState({}, '', '/');
    const send = document.createElement('button');
    send.type = 'button';
    send.dataset.testid = 'send-button';
    send.textContent = 'Send';
    document.querySelector('form').append(send);
  });
  await f.p.locator('[data-ghrc-recovered-answer]').evaluate(node => node.remove());
  await f.p.locator('textarea').fill('Ask a fresh question');
  await f.p.getByRole('button', { name: 'Send', exact: true }).click();
  await f.p.evaluate(() => history.pushState({}, '', '/c/new-conversation'));
  const reads = f.reads();
  await f.p.clock.runFor(2_000);
  await f.p.waitForFunction(() => document.querySelector('[data-ghrc-recovered-answer]')?.textContent === 'Saved answer');
  assert.equal(f.reads(), reads + 1, 'the just-submitted prompt must not be paused by URL creation');
  assert.deepEqual(f.errors, []);
  await f.p.close();
});

test('renders headings, links, lists, tables, checkboxes and fenced code as safe Markdown', async () => {
  const text = [
    '## Formatted reply',
    '',
    '**Bold**, *italic*, ~~removed~~, and [source](https://example.com/filing).',
    '',
    '- First item',
    '- [x] Completed item',
    '',
    '| Item | Value |',
    '| --- | --- |',
    '| Shares | 10 |',
    '',
    '~~~js',
    '<script>window.__ghrcUnsafe = true</script>',
    '~~~',
    '',
    '[unsafe](javascript:alert(1))',
    '<img src="x" onerror="window.__ghrcUnsafe = true">',
  ].join('\n');
  const f = await fixture({ savedText: text });
  await settle(f.p);
  const root = f.p.locator('[data-ghrc-recovered-answer]');
  assert.equal(await root.locator('h2').textContent(), 'Formatted reply');
  assert.equal(await root.locator('strong').textContent(), 'Bold');
  assert.equal(await root.locator('em').textContent(), 'italic');
  assert.equal(await root.locator('del').textContent(), 'removed');
  assert.equal(await root.locator('a[href="https://example.com/filing"]').textContent(), 'source');
  assert.equal(await root.locator('li').count(), 2);
  assert.equal(await root.locator('input[type="checkbox"]:disabled:checked').count(), 1);
  assert.equal(await root.locator('table tbody tr td').first().textContent(), 'Shares');
  assert.match(await root.locator('pre code').textContent(), /<script>window\.__ghrcUnsafe = true<\/script>/);
  assert.equal(await root.locator('a').last().getAttribute('href'), null);
  assert.equal(await root.locator('img').count(), 0);
  assert.equal(await root.locator('script').count(), 0);
  assert.equal(await f.p.evaluate(() => window.__ghrcUnsafe), undefined);
  assert.deepEqual(f.errors, []);
  await f.p.close();
});
