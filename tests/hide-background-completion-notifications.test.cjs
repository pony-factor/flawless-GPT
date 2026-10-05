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

test('keeps ready notices that point at the current conversation', () => {
  const a = api();
  assert.equal(
    a.isBackgroundCompletionNotice(
      new FakeToast('Your response is ready', ['/c/current-chat'])
    ),
    false
  );
});

test('ignores non-ChatGPT and non-conversation links', () => {
  const a = api();
  assert.equal(
    a.isBackgroundCompletionNotice(
      new FakeToast('Your response is ready', ['https://example.com/c/other-chat', '/settings'])
    ),
    false
  );
});
