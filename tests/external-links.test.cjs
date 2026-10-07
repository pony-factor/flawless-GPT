const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../js/external-links.js'), 'utf8');

class Element {
  closest() { return null; }
}
class HTMLAnchorElement extends Element {
  constructor(href, closest = null) {
    super();
    this.href = href;
    this.closestResult = closest;
  }
  closest() { return this.closestResult; }
  hasAttribute() { return false; }
}

function fixture({ enabled = true, newTabs = false } = {}) {
  const navigations = [];
  const openedTabs = [];
  const context = {
    Element,
    HTMLAnchorElement,
    URL,
    WeakSet,
    window: {
      open: (...args) => openedTabs.push(args),
      location: {
        href: 'https://chatgpt.com/c/example',
        origin: 'https://chatgpt.com',
        assign: (href) => navigations.push(href),
      },
    },
  };
  vm.createContext(context);
  const boundary = source.indexOf('  function preserveNativeScroll');
  const prefix = source.slice(0, boundary);
  vm.runInContext(prefix + `
    externalWarningEnabled = ${enabled ? 'true' : 'false'};
    newTabsEnabled = ${newTabs ? 'true' : 'false'};
    globalThis.api = { isPlainPrimaryActivation, openExternalLink };
  })();`, context);

  const event = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
  return { api: context.api, event, navigations, openedTabs };
}

test('plain external clicks reuse the current ChatGPT tab', () => {
  const f = fixture();
  const link = new HTMLAnchorElement('https://www.sec.gov/comments/example.pdf');
  assert.equal(f.api.openExternalLink(f.event, link), true);
  assert.deepEqual(f.navigations, ['https://www.sec.gov/comments/example.pdf']);
  assert.equal(f.event.prevented, true);
  assert.equal(f.event.stopped, true);
});

test('modifier clicks keep native new-tab behavior', () => {
  const f = fixture();
  f.event.metaKey = true;
  const link = new HTMLAnchorElement('https://www.sec.gov/comments/example.pdf');
  assert.equal(f.api.openExternalLink(f.event, link), false);
  assert.deepEqual(f.navigations, []);
});

test('internal ChatGPT links are not intercepted', () => {
  const f = fixture();
  const link = new HTMLAnchorElement('https://chatgpt.com/c/another-chat');
  assert.equal(f.api.openExternalLink(f.event, link), false);
  assert.deepEqual(f.navigations, []);
});

test('extension dashboard links keep their existing behavior', () => {
  const f = fixture();
  const link = new HTMLAnchorElement('https://github.com/JFWooten4', {});
  assert.equal(f.api.openExternalLink(f.event, link), false);
  assert.deepEqual(f.navigations, []);
});

test('disabling external-warning bypass leaves link handling untouched', () => {
  const f = fixture({ enabled: false });
  const link = new HTMLAnchorElement('https://www.sec.gov/comments/example.pdf');
  assert.equal(f.api.openExternalLink(f.event, link), false);
  assert.deepEqual(f.navigations, []);
});


function historyModalFixture() {
  let clicks = 0;
  let hides = 0;
  const dismissControl = {
    textContent: 'Got it',
    click() { clicks += 1; },
  };
  const modal = {
    style: {
      setProperty(name, value) {
        if (name === 'display' && value === 'none') hides += 1;
      },
    },
    querySelectorAll(selector) {
      return selector === 'button, a[href], [role="button"]' ? [dismissControl] : [];
    },
  };
  const pageElement = {
    style: { setProperty() {} },
    removeAttribute() {},
  };
  const context = {
    document: {
      documentElement: pageElement,
      body: pageElement,
      getElementById: () => modal,
      querySelectorAll: () => [],
    },
    getComputedStyle: () => ({ pointerEvents: 'auto' }),
  };
  vm.createContext(context);
  const boundary = source.indexOf('  function stripTrackingFromLink');
  vm.runInContext(source.slice(0, boundary) + `
    historyModalEnabled = true;
    globalThis.historyApi = { suppressHistoryRateLimitModal };
  })();`, context);

  return {
    suppress: context.historyApi.suppressHistoryRateLimitModal,
    clicks: () => clicks,
    hides: () => hides,
  };
}

test('history rate-limit modal uses ChatGPT native dismissal before fallback hiding', () => {
  const f = historyModalFixture();
  f.suppress();
  assert.equal(f.clicks(), 1);
  assert.equal(f.hides(), 1);

  f.suppress();
  assert.equal(f.clicks(), 1);
  assert.equal(f.hides(), 2);
});

test('new tabs work independently of warning bypass', () => {
  const f = fixture({ enabled: false, newTabs: true });
  assert.equal(f.api.openExternalLink(f.event, new HTMLAnchorElement('https://example.org/source')), true);
  assert.deepEqual(f.navigations, []);
  assert.deepEqual(f.openedTabs, [['https://example.org/source', '_blank', 'noopener,noreferrer']]);
});

test('downloads and non-web URLs are left to the browser', () => {
  const f = fixture({ newTabs: true });
  const download = new HTMLAnchorElement('https://example.org/file.pdf');
  download.hasAttribute = () => true;
  assert.equal(f.api.openExternalLink(f.event, download), false);
  assert.equal(f.api.openExternalLink(f.event, new HTMLAnchorElement('mailto:hello@example.org')), false);
  assert.deepEqual(f.openedTabs, []);
});


test('history modal suppression is event driven instead of polled', () => {
  assert.equal(source.includes('setInterval(suppressHistoryRateLimitModal'), false);
});
