const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../js/hide-background-completion-notifications.js'),
  'utf8'
);

class FakeLink {
  constructor(href) { this.href = href; }
  getAttribute(name) { return name === 'href' ? this.href : null; }
}

class FakeToast {
  constructor(textContent, hrefs = []) {
    this.textContent = textContent;
    this.links = hrefs.map((href) => new FakeLink(href));
  }
  querySelectorAll(selector) {
    return selector === 'a[href]' ? this.links : [];
  }
}

function api(pathname = '/c/current-chat') {
  const testApi = {};
  const context = {
    __GHRC_TEST__: testApi,
    location: { pathname, origin: 'https://chatgpt.com' },
    URL,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return testApi;
}

test('matches explicit completion notices for another chat', () => {
  const a = api();
  assert.equal(
    a.isBackgroundCompletionNotice(new FakeToast('Another chat has finished')),
    true
  );
});

test('keeps unrelated alerts visible', () => {
  const a = api();
  assert.equal(
    a.isBackgroundCompletionNotice(new FakeToast('Another chat could not be loaded')),
    false
  );
});

test('matches ready notices linking to a different conversation', () => {
  const a = api();
  assert.equal(
    a.isBackgroundCompletionNotice(
      new FakeToast('Your response is ready', ['/c/other-chat'])
    ),
    true
  );
});

test('matches chat completion notices even when they point at the current conversation', () => {
  const a = api();
  assert.equal(
    a.isBackgroundCompletionNotice(
      new FakeToast('Your response is ready', ['/c/current-chat'])
    ),
    true
  );
});

test('ignores non-ChatGPT and non-conversation links on generic ready alerts', () => {
  const a = api();
  assert.equal(
    a.isBackgroundCompletionNotice(
      new FakeToast('Your download is ready', ['https://example.com/c/other-chat', '/settings'])
    ),
    false
  );
});

test('recognizes thinking session completion without a link or cross-chat wording', () => {
  const a = api();
  for (const message of [
    'Your thinking session finished',
    'Your thinking session has finished',
    'Your other session finished',
    'Thinking is complete',
    'Your research task is done',
    'Your response is ready',
    'Session completed',
  ]) {
    assert.equal(a.isBackgroundCompletionNotice(new FakeToast(message)), true, message);
  }
});

test('does not hide non-chat toasts or incomplete and failed session alerts', () => {
  const a = api();
  for (const message of [
    'Your file is ready',
    'Your login session expired',
    'Your thinking session failed',
    'Session is still running',
    'Your settings are ready',
  ]) {
    assert.equal(a.isBackgroundCompletionNotice(new FakeToast(message)), false, message);
  }
});

test('finds an existing toast when a descendant text node changes', () => {
  const toast = { textContent: 'Your thinking session finished' };
  class FakeElement {
    constructor(ancestor) { this.ancestor = ancestor; }
    closest() { return this.ancestor; }
    matches() { return false; }
    querySelectorAll() { return []; }
  }
  const testApi = {};
  const context = {
    __GHRC_TEST__: testApi,
    location: { pathname: '/c/current-chat', origin: 'https://chatgpt.com' },
    URL,
    Element: FakeElement,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const changedTextNode = { parentElement: new FakeElement(toast) };
  assert.deepEqual(Array.from(testApi.candidateToasts(changedTextNode)), [toast]);
});

test('hides a toast when its text changes after insertion', () => {
  let observer;
  const toast = {
    textContent: 'Thinking...',
    attributes: new Set(),
    hasAttribute(name) { return this.attributes.has(name); },
    setAttribute(name) { this.attributes.add(name); },
    querySelectorAll() { return []; },
  };
  class FakeElement {
    constructor(ancestor = null) { this.ancestor = ancestor; }
    closest() { return this.ancestor; }
    matches() { return false; }
    querySelectorAll() { return []; }
    append() {}
  }
  const documentElement = new FakeElement();
  const context = {
    Element: FakeElement,
    location: { pathname: '/c/current-chat', origin: 'https://chatgpt.com' },
    URL,
    document: {
      documentElement,
      getElementById() { return null; },
      createElement() { return {}; },
    },
    MutationObserver: class {
      constructor(callback) { observer = { callback }; }
      observe(_target, options) { observer.options = options; }
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.equal(observer.options.characterData, true);

  const textNode = { parentElement: new FakeElement(toast) };
  toast.textContent = 'Your thinking session has finished';
  observer.callback([{ type: 'characterData', target: textNode }]);
  assert.equal(toast.hasAttribute('data-ghrc-hidden-background-completion'), true);
  assert.equal(toast.hasAttribute('aria-hidden'), true);
});
