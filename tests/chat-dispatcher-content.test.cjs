const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = readFileSync(path.join(__dirname, '../js/composer/chat-dispatcher.js'), 'utf8');
function fixture() {
  const dom = new JSDOM('<main aria-label="Conversation"><article><div data-message-author-role="user">Task: opener-0059</div></article><article id="assistant-turn"><div data-message-author-role="assistant"><p>Finished.</p><button aria-label="Copy">Copy</button></div></article></main><form><textarea id="prompt-textarea"></textarea><button type="submit" data-testid="send-button" aria-label="Send">Send</button></form>', { url: 'https://chatgpt.com/c/test-thread', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window: w } = dom;
  let now = 10000;
  w.Date.now = () => now;
  w.Element.prototype.getClientRects = function () { return this.hidden || this.style.display === 'none' ? [] : [{ width: 100, height: 30 }]; };
  w.chrome = { runtime: { id: 'test', onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() } };
  w.eval(source);
  const adapter = w.__ghrcChatDispatcherAdapter;
  adapter.snapshot(); now += 1600;
  return { dom, w, adapter, advance: amount => { now += amount; } };
}

test('a missing Stop button does not imply completion while thinking', () => {
  const { dom, w, adapter } = fixture();
  const thinking = w.document.createElement('span'); thinking.setAttribute('aria-label', 'Thinking');
  w.document.querySelector('#assistant-turn').append(thinking);
  assert.equal(adapter.snapshot().active, true);
  assert.equal(adapter.idle(adapter.snapshot()), false);
  dom.window.close();
});

test('a user Copy message control cannot complete an unanswered turn', () => {
  const { dom, w, adapter } = fixture();
  w.document.querySelector('[data-message-author-role="assistant"] button').remove();
  const copy = w.document.createElement('button'); copy.setAttribute('aria-label', 'Copy message');
  w.document.querySelector('[data-message-author-role="user"]').append(copy);
  assert.equal(adapter.snapshot().assistantComplete, false);
  dom.window.close();
});

test('existing drafts and attachments are never overwritten', async () => {
  const { dom, w, adapter } = fixture();
  const input = w.document.querySelector('textarea'); input.value = 'My draft';
  const response = await adapter.prepare({ nonce: 'n', signature: adapter.snapshot().signature, prompt: 'Next task' });
  assert.equal(response.ok, false); assert.equal(input.value, 'My draft');
  input.value = '';
  const attachment = w.document.createElement('button'); attachment.setAttribute('aria-label', 'Remove file'); input.closest('form').append(attachment);
  assert.equal((await adapter.prepare({ nonce: 'n', signature: adapter.snapshot().signature, prompt: 'Next task' })).ok, false);
  assert.equal(input.value, ''); dom.window.close();
});

test('Stop appearing after draft preparation prevents submission', async () => {
  const { dom, w, adapter } = fixture();
  let clicks = 0; const send = w.document.querySelector('[data-testid="send-button"]'); send.addEventListener('click', e => { e.preventDefault(); clicks++; });
  const ready = await adapter.prepare({ nonce: 'n', signature: adapter.snapshot().signature, prompt: 'Next task' });
  assert.equal(ready.ok, true);
  const stop = w.document.createElement('button'); stop.setAttribute('aria-label', 'Stop'); w.document.querySelector('form').append(stop);
  assert.equal((await adapter.commit({ nonce: 'n' })).ok, false);
  assert.equal(clicks, 0); dom.window.close();
});

test('Send morphing into Stop is never clicked', async () => {
  const { dom, w, adapter } = fixture(); let clicks = 0;
  const send = w.document.querySelector('[data-testid="send-button"]'); send.addEventListener('click', e => { e.preventDefault(); clicks++; });
  assert.equal((await adapter.prepare({ nonce: 'n', signature: adapter.snapshot().signature, prompt: 'Next task' })).ok, true);
  send.setAttribute('aria-label', 'Stop'); send.setAttribute('data-testid', 'stop-button');
  assert.equal((await adapter.commit({ nonce: 'n' })).ok, false);
  assert.equal(clicks, 0); dom.window.close();
});

test('interrupt hats are rejected even when they look like Send', () => {
  const { dom, w, adapter } = fixture();
  const send = w.document.querySelector('[data-testid="send-button"]'); send.id = 'ghrc-message-interrupt-button';
  assert.equal(adapter.nativeSend(w.document.querySelector('textarea')), undefined); dom.window.close();
});

test('changed conversations and edited drafts invalidate a prepared send', async () => {
  const { dom, w, adapter } = fixture(); let clicks = 0;
  w.document.querySelector('[data-testid="send-button"]').addEventListener('click', e => { e.preventDefault(); clicks++; });
  assert.equal((await adapter.prepare({ nonce: 'n', signature: adapter.snapshot().signature, prompt: 'Next task' })).ok, true);
  w.document.querySelector('textarea').value = 'User changed this';
  assert.equal((await adapter.commit({ nonce: 'n' })).ok, false); assert.equal(clicks, 0);
  assert.equal(w.document.querySelector('textarea').value, 'User changed this'); dom.window.close();
});

test('a real native send is correlated with its new user turn', async () => {
  const { dom, w, adapter } = fixture();
  const nonce = 'unique-reference'; const prompt = `Next task\nDispatch reference: ${nonce}`;
  const send = w.document.querySelector('[data-testid="send-button"]'); let clicks = 0;
  send.addEventListener('click', e => {
    e.preventDefault(); clicks++;
    const article = w.document.createElement('article'); const user = w.document.createElement('div');
    user.dataset.messageAuthorRole = 'user'; user.textContent = prompt; article.append(user); w.document.querySelector('main').append(article);
    w.document.querySelector('textarea').value = '';
  });
  assert.equal((await adapter.prepare({ nonce, signature: adapter.snapshot().signature, prompt })).ok, true);
  assert.equal((await adapter.commit({ nonce })).ok, true); assert.equal(clicks, 1); dom.window.close();
});

test('unconfirmed sends stay blocked and cannot replay automatically', async () => {
  const { dom, w, adapter, advance } = fixture(); let clicks = 0;
  w.document.querySelector('[data-testid="send-button"]').addEventListener('click', e => { e.preventDefault(); clicks++; });
  const nonce = 'uncertain';
  assert.equal((await adapter.prepare({ nonce, signature: adapter.snapshot().signature, prompt: `Next task\nDispatch reference: ${nonce}` })).ok, true);
  const timeout = w.setTimeout.bind(w);
  w.setTimeout = (callback, ms) => { advance(ms); return timeout(callback, 0); };
  const result = await adapter.commit({ nonce });
  assert.equal(result.ok, false); assert.equal(result.uncertain, true);
  assert.equal(adapter.snapshot().submissionPending, true);
  assert.equal((await adapter.prepare({ nonce: 'retry', signature: adapter.snapshot().signature, prompt: 'Retry' })).ok, false);
  assert.equal(adapter.review({ nonce, decision: 'not-sent' }).ok, true);
  assert.equal(adapter.snapshot().submissionPending, false);
  assert.match(w.document.querySelector('textarea').value, /Next task/, 'review must preserve the unsent draft');
  assert.equal(clicks, 1); dom.window.close();
});

test('Flawless lifecycle state blocks a visually idle chat until its own state is ready', async () => {
  const { dom, w, adapter } = fixture();
  w.__ghrcMessageQueue = { getDispatcherLifecycle: () => ({ stateReady: false, roleStateKnown: true, latestAssistantComplete: true, latestUserAnswered: true }) };
  const s = adapter.snapshot();
  assert.equal(s.known, false);
  assert.equal((await adapter.prepare({ nonce: 'n', signature: s.signature, prompt: 'Next' })).ok, false);
  assert.equal(w.document.querySelector('textarea').value, '');
  dom.window.close();
});

test('Flawless pending submissions and composer context are honored without enqueueing', () => {
  const { dom, w, adapter } = fixture();
  w.__ghrcMessageQueue = { getDispatcherLifecycle: () => ({ stateReady: true, roleStateKnown: true, latestAssistantComplete: true, latestUserAnswered: true, submissionPending: true, hasContext: true, queueLength: 0 }) };
  const s = adapter.snapshot();
  assert.equal(s.submissionPending, true); assert.equal(s.draftPresent, true); assert.equal(adapter.idle(s), false);
  dom.window.close();
});

test('a hidden native Send returned by a shared helper is rejected', () => {
  const { dom, w, adapter } = fixture();
  const send = w.document.querySelector('[data-testid="send-button"]'); send.hidden = true;
  w.__ghrcMessageQueue = { findNativeSend: () => send };
  assert.equal(adapter.nativeSend(w.document.querySelector('textarea')), undefined);
  dom.window.close();
});


test('fresh root chat can send its first task and bind the resulting conversation', async () => {
  const { dom, w, adapter, advance } = fixture();
  dom.reconfigure({ url: 'https://chatgpt.com/' });
  w.document.querySelector('main').replaceChildren();
  adapter.snapshot(); advance(1600);
  assert.equal(adapter.snapshot().fresh, true);
  const nonce = 'fresh-reference'; const prompt = `Task: opener-0060\nDispatch reference: ${nonce}`;
  w.document.querySelector('[data-testid="send-button"]').addEventListener('click', event => {
    event.preventDefault();
    dom.reconfigure({ url: 'https://chatgpt.com/c/new-thread?from=new-chat' });
    const user = w.document.createElement('div'); user.dataset.messageAuthorRole = 'user'; user.textContent = prompt;
    w.document.querySelector('main').append(user);
  });
  assert.equal((await adapter.prepare({ nonce, signature: adapter.snapshot().signature, prompt })).ok, true);
  const sent = await adapter.commit({ nonce });
  assert.equal(sent.ok, true); assert.equal(sent.pendingIdentity, true);
  dom.window.close();
});

test('an empty existing conversation is never treated as a fresh chat', () => {
  const { dom, w, adapter, advance } = fixture();
  w.document.querySelector('main').replaceChildren();
  adapter.snapshot(); advance(1600);
  assert.equal(adapter.snapshot().fresh, false);
  assert.equal(adapter.idle(adapter.snapshot()), false);
  dom.window.close();
});


test('collapsed user prompts still prove submission without clicking or sending', () => {
  const { dom, w, adapter } = fixture();
  const user = w.document.querySelector('[data-message-author-role="user"]');
  user.textContent = 'Task: opener-0059 Dispatch reference: collapsed-reference';
  user.hidden = true;
  const result = adapter.review({ decision: 'sent', nonce: 'collapsed-reference' });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://chatgpt.com/c/test-thread');
  dom.window.close();
});


test('Work replies without a rendered user prompt require assistant completion', () => {
  const { dom, w, adapter, advance } = fixture();
  w.document.querySelector('[data-message-author-role="user"]').remove();
  const assistant = w.document.querySelector('[data-message-author-role="assistant"]');
  assistant.removeAttribute('data-message-author-role');
  assistant.setAttribute('data-content-search-unit-key', 'fallback-turn-0:1:assistant');
  adapter.snapshot(); advance(1600);
  assert.equal(adapter.idle(adapter.snapshot()), true);
  assistant.querySelector('button').remove();
  assert.equal(adapter.idle(adapter.snapshot()), false);
  dom.window.close();
});
