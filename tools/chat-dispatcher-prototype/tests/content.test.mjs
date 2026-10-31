import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
function fixture() {
  const dom = new JSDOM('<main aria-label="Conversation"><article><div data-message-author-role="user">Task: opener-0059</div></article><article id="assistant-turn"><div data-message-author-role="assistant"><p>Finished.</p><button aria-label="Copy">Copy</button></div></article></main><form><textarea id="prompt-textarea"></textarea><button type="submit" data-testid="send-button" aria-label="Send">Send</button></form>', { url: 'https://chatgpt.com/c/test-thread', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window: w } = dom;
  let now = 10000;
  w.Date.now = () => now;
  w.Element.prototype.getClientRects = function () { return this.hidden || this.style.display === 'none' ? [] : [{ width: 100, height: 30 }]; };
  w.chrome = { runtime: { id: 'test', onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() } };
  w.eval(source);
  const adapter = w.StudioChatAdapter;
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
