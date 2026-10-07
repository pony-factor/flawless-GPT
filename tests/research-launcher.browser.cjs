const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
});
after(async () => { await browser.close(); });

async function fixture({ handoff = false, draft = '' } = {}) {
  const page = await browser.newPage();
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
  await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: `
    <style>[contenteditable]{min-height:40px}</style><main><section data-oai-writing-block-surface data-markdown-copy-text="">
      <header><button aria-label="Add to Library">Exact research wording</button><div class="actions">
        <span class="contents"><button aria-label="Copy">Copy</button></span>
        <button aria-label="Open editor">Editor</button></div></header><div>Visible preview only</div>
    </section><div class="unrelated"><button aria-label="Copy">Copy response</button></div></main>
    <form><div data-composer-markdown contenteditable="true"><p></p></div><button type="button" aria-label="Send">Send</button></form>
  ` }));
  await page.goto('https://chatgpt.com/');
  await page.evaluate(({ handoff, draft }) => {
    window.calls = [];
    window.sent = [];
    window.job = handoff ? { id: 'test', state: 'pending', tabId: 3, windowId: 4, title: 'Prompt', category: 'Markets' } : null;
    window.prompt = '# Exact wording\n\nInvestigate A & B; preserve every line.';
    document.querySelector('[data-oai-writing-block-surface]').setAttribute('data-markdown-copy-text', window.prompt);
    const editor = document.querySelector('[data-composer-markdown]');
    editor.querySelector('p').textContent = draft;
    editor.addEventListener('paste', event => {
      event.preventDefault();
      document.execCommand('insertHTML', false, event.clipboardData.getData('text/html'));
    });
    document.querySelector('button[aria-label="Send"]').addEventListener('click', () => {
      sent.push({ text: [...editor.children].map(node => node.textContent).join('\n').trimEnd(), apps: [...editor.querySelectorAll('[app-mention-path]')].map(node => node.getAttribute('app-mention-path')) });
      editor.innerHTML = '<p><br></p>';
      const turn = document.createElement('div');
      turn.setAttribute('data-message-author-role', 'user');
      document.querySelector('main').append(turn);
    });
    chrome.runtime = {
      id: 'fixture',
      getURL: path => 'https://chatgpt.com/' + path,
      onMessage: { addListener() {} },
      async sendMessage(message) {
        calls.push(message);
        if (message.type === 'research-publisher-status') return { ok: true, repository: 'research', branch: 'main', categories: ['Markets'] };
        if (message.type === 'research-launch-job') return { ok: true, job };
        if (message.type === 'claim-research-launch') { job.state = 'preparing'; return { ok: true, job: { ...job, prompt } }; }
        if (message.type === 'research-launch-sending') job.state = 'sending';
        if (message.type === 'research-launch-submitted') job.state = 'submitted';
        if (message.type === 'research-launch-error') { job.state = 'error'; job.error = message.error; }
        if (message.type === 'start-research-launch') return { ok: true, job: { id: 'source-run', tabId: 3, state: 'pending' } };
        if (message.type === 'research-launch-status') return { ok: true, job: { id: 'source-run', tabId: 3, state: 'submitted' } };
        return { ok: true };
      },
    };
    chrome.storage = { local: {} };
  }, { handoff, draft });
  for (const file of ['js/extension-context.js', 'js/research-import-dialog.js', 'js/research-launcher.js'])
    await page.addScriptTag({ content: fs.readFileSync(file, 'utf8') });
  await page.getByRole('button', { name: 'Research and import', exact: true }).waitFor();
  return page;
}

test('telescope precedes writing-block Copy, cancellation does not launch, and full wording reaches launch', async () => {
  const p = await fixture();
  const button = p.getByRole('button', { name: 'Research and import', exact: true });
  assert.equal(await p.locator('.ghrc-research-writing-block').count(), 1);
  assert.equal(await button.evaluate(node => node.nextElementSibling.querySelector('button').getAttribute('aria-label')), 'Copy');
  await button.click();
  await p.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await p.evaluate(() => calls.filter(message => message.type === 'start-research-launch').length), 0);
  await button.click();
  await p.getByRole('textbox', { name: 'Category' }).fill('Markets');
  await p.getByRole('button', { name: 'Start research', exact: true }).click();
  await p.waitForFunction(() => calls.some(message => message.type === 'start-research-launch'));
  const start = await p.evaluate(() => calls.find(message => message.type === 'start-research-launch'));
  assert.equal(start.prompt, '# Exact wording\n\nInvestigate A & B; preserve every line.');
  assert.equal(start.category, 'Markets');
  assert.equal(start.title, 'Exact research wording');
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('popup inserts a real app mention and full prompt, submits once, and acknowledges the send', async () => {
  const p = await fixture({ handoff: true });
  await p.waitForFunction(() => ['submitted', 'error'].includes(job.state));
  assert.equal(await p.evaluate(() => job.state), 'submitted', JSON.stringify(await p.evaluate(() => ({ job, calls, html: document.querySelector('[data-composer-markdown]').innerHTML }))));
  const sent = await p.evaluate(() => window.sent);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].apps, ['app://connector_openai_deep_research']);
  assert.ok(sent[0].text.endsWith('# Exact wording\n\nInvestigate A & B; preserve every line.'));
  await p.waitForTimeout(1200);
  assert.equal(await p.evaluate(() => window.sent.length), 1);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('popup preserves an existing draft and does not submit it', async () => {
  const p = await fixture({ handoff: true, draft: 'Preserve this draft' });
  await p.waitForFunction(() => job.state === 'error');
  assert.equal(await p.locator('[data-composer-markdown]').innerText(), 'Preserve this draft');
  assert.equal(await p.evaluate(() => sent.length), 0);
  assert.deepEqual(p.errors, []);
  await p.close();
});

test('stable completed report auto-imports once while busy and ordinary reports remain manual', async () => {
  const p = await browser.newPage();
  await p.route('https://mcp-app-abc123.web-sandbox.oaiusercontent.com/**', route => route.fulfill({ contentType: 'text/html', body:
    '<section><div><button aria-label="Export">Export</button><button aria-label="Expand">Expand</button></div><article class="_reportPage_fixture" aria-busy="true"><h1>Report</h1><p>Evidence</p></article></section>' }));
  await p.goto('https://mcp-app-abc123.web-sandbox.oaiusercontent.com/');
  await p.evaluate(() => {
    window.calls = [];
    window.run = { id: 'automatic', state: 'submitted', category: 'Markets' };
    window.chrome = { storage: { local: { get: async defaults => ({ ...defaults, researchPublisherEnabled: true }) }, onChanged: { addListener() {} } },
      runtime: { async sendMessage(message) {
        calls.push(message);
        if (message.type === 'research-launch-job') return { ok: true, job: window.run };
        if (message.type === 'publish-research-report') { window.run.state = 'complete'; return { ok: true, repository: 'research', branch: 'main', path: 'Markets/report.md' }; }
        return { ok: true };
      } } };
  });
  for (const file of ['vendor/turndown.js', 'vendor/turndown-plugin-gfm.js', 'js/research-import-dialog.js', 'js/research-publisher.js'])
    await p.addScriptTag({ content: fs.readFileSync(file, 'utf8') });
  await p.waitForTimeout(1200);
  assert.equal(await p.evaluate(() => calls.filter(message => message.type === 'publish-research-report').length), 0);
  await p.locator('article').evaluate(node => node.removeAttribute('aria-busy'));
  await p.waitForFunction(() => calls.some(message => message.type === 'publish-research-report'), { timeout: 10000 });
  const payload = await p.evaluate(() => calls.find(message => message.type === 'publish-research-report'));
  assert.equal(payload.automationJobId, 'automatic');
  assert.match(payload.markdown, /# Report/);
  await p.waitForTimeout(1200);
  assert.equal(await p.evaluate(() => calls.filter(message => message.type === 'publish-research-report').length), 1);
  await p.evaluate(() => { window.run = null; document.querySelector('article p').textContent = 'Ordinary report'; });
  await p.waitForTimeout(1200);
  assert.equal(await p.evaluate(() => calls.filter(message => message.type === 'publish-research-report').length), 1);
  await p.close();
});


test('a recovered popup retries automatically and restores completion without a category dialog', async () => {
  const p = await browser.newPage();
  await p.setContent('<section><div><button aria-label="Export">Export</button><button aria-label="Expand">Expand</button></div><article class="_reportPage_fixture"><h1>Recovered report</h1><p>Evidence</p></article></section>');
  await p.evaluate(() => {
    window.attempts = 0;
    window.run = { id: 'recovered', state: 'submitted', category: '' };
    window.chrome = { storage: { local: { get: async defaults => ({ ...defaults, researchPublisherEnabled: true }) }, onChanged: { addListener() {} } },
      runtime: { async sendMessage(message) {
        if (message.type === 'research-launch-job') return { ok: true, job: window.run };
        if (message.type === 'publish-research-report') {
          attempts++;
          if (attempts === 1) {
            window.run = { ...run, state: 'import-retry', retryAt: Date.now() + 1500 };
            return { ok: false, error: 'Another report is being added.' };
          }
          const result = { ok: true, repository: 'research', branch: 'main', path: 'report.md', unchanged: true };
          window.run = { ...run, state: 'complete', result };
          return result;
        }
        return { ok: true };
      } } };
  });
  for (const file of ['vendor/turndown.js', 'vendor/turndown-plugin-gfm.js', 'js/research-import-dialog.js', 'js/research-publisher.js'])
    await p.addScriptTag({ content: fs.readFileSync(file, 'utf8') });
  await p.waitForFunction(() => run.state === 'complete', { timeout: 15000 });
  assert.equal(await p.evaluate(() => attempts), 2);
  assert.equal(await p.getByRole('dialog').count(), 0);
  await p.getByRole('button', { name: 'Report added to repo', exact: true }).waitFor();
  await p.locator('.ghrc-report-status').evaluate(node => { node.textContent = ''; });
  await p.waitForFunction(() => document.querySelector('.ghrc-report-status').textContent.includes('Already up to date'));
  assert.equal(await p.evaluate(() => attempts), 2);
  await p.close();
});
