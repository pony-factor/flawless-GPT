const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/force-high-thinking.js'), 'utf8');

class Element {
  constructor(text = '', attrs = {}) { this.textContent = text; this.attrs = attrs; this.isConnected = true; this.clicks = 0; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return name in this.attrs; }
  setAttribute(name, value) { this.attrs[name] = value; }
  removeAttribute(name) { delete this.attrs[name]; }
  getClientRects() { return [{}]; }
  click() { this.clicks++; }
  dispatchEvent() { return true; }
  closest() { return this; }
}
function fixture() {
  const elements = new Map();
  const storageWrites = [];
  const timers = [];
  let controls = [];
  const context = {
    HTMLElement: Element,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    KeyboardEvent: class { constructor(type, args) { this.type = type; Object.assign(this, args); } },
    window: { setTimeout(callback, delay) { timers.push({ callback, delay }); } }, requestAnimationFrame() {},
    chrome: { runtime: { id: "fixture" }, storage: { local: { set(value) { storageWrites.push(value); return Promise.resolve(); } } } },
    document: {
      getElementById: (id) => elements.get(id),
      createElement: () => new Element(),
      documentElement: { append: (element) => elements.set(element.id, element) },
      querySelectorAll: (selector) => selector.includes('[role="menu"]') ? [] : controls,
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/extension-context.js"), "utf8"), context);
  vm.runInContext(source.slice(0, source.indexOf('  chrome.storage.onChanged')) + `
    globalThis.api = { effortLevel, ensureStyle, selectMaximum, controlCacheKey, scanControls, finishSelection,
      begin(selector, state, initialLevel, focusedComposer) { pending = { selector, state, initialLevel, focusedComposer }; },
      clearPending() { pending = null; },
      seedState(selector, target) { states.set(selector, { attempts: 0, adjustments: 0, target }); },
      setEnabledForTest(value) { enabled = value; },
      setConfirmedTargets(value) { confirmedTargets = value; },
    };
  })();`, context);
  const selector = new Element('Standard', { 'aria-controls': 'menu' });
  const state = { adjustments: 0, target: '' };
  const menu = new Element();
  menu.querySelector = () => null;
  menu.querySelectorAll = () => [];
  elements.set('menu', menu);
  context.api.begin(selector, state, 'standard');
  return {
    api: context.api, elements, selector, state, menu, storageWrites, document: context.document,
    setControls(value) { controls = value; },
    runTimer(delay) {
      const index = timers.findIndex((timer) => timer.delay === delay);
      assert.notEqual(index, -1);
      timers.splice(index, 1)[0].callback();
    },
  };
}

test('visible level is recognized when accessibility label omits it', () => {
  const f = fixture();
  assert.equal(f.api.effortLevel(new Element('High', { 'aria-label': 'Thinking effort' })), 'high');
  assert.equal(f.api.effortLevel(new Element('Extended')), 'extended');
  assert.equal(f.api.effortLevel(new Element('Thinking')), 'thinking');
  assert.equal(f.api.effortLevel(new Element('Maximum')), 'maximum');
  assert.equal(f.api.effortLevel(new Element('High priority issue')), '');
});
test('hidden sizing text does not obscure the displayed effort level', () => {
  const f = fixture();
  const selector = new Element('Thinking effortHigh', { 'aria-label': 'Select ChatGPT model' });
  selector.innerText = 'High';
  assert.equal(f.api.effortLevel(selector), 'high');
});
test('hiding CSS matches the empty marker attribute', () => {
  const f = fixture();
  f.api.ensureStyle();
  assert.match(f.elements.get('ghrc-force-high-thinking-style').textContent, /\[data-ghrc-high-thinking-selector\] \{ display: none !important; \}/);
  assert.match(f.elements.get('ghrc-force-high-thinking-style').textContent, /\[data-ghrc-thinking-menu\] \{ opacity: 0 !important; pointer-events: none !important; \}/);
});

test('confirmed visible level is cached when the control is hidden', () => {
  const f = fixture();
  const selector = new Element('High', { 'aria-label': 'Thinking effort' });
  f.api.clearPending();
  f.api.setEnabledForTest(true);
  f.api.setConfirmedTargets({});
  f.api.seedState(selector, 'high');
  f.setControls([selector]);
  f.api.scanControls();
  assert.equal(selector.hasAttribute('data-ghrc-high-thinking-selector'), true);
  assert.equal(JSON.stringify(f.storageWrites), JSON.stringify([{ forceHighThinkingConfirmedTargets: { 'thinking effort': 'high' } }]));
});
test('cached confirmed level skips reopening the selector in a new page', () => {
  const f = fixture();
  const selector = new Element('High', { 'aria-label': 'Thinking effort' });
  const keys = [];
  selector.dispatchEvent = (event) => { keys.push(event.key); return true; };
  f.api.clearPending();
  f.api.setEnabledForTest(true);
  f.api.setConfirmedTargets({ 'thinking effort': 'high' });
  f.setControls([selector]);
  f.api.scanControls();
  assert.equal(selector.hasAttribute('data-ghrc-high-thinking-selector'), true);
  assert.deepEqual(keys, []);
  assert.deepEqual(f.storageWrites, []);
});
test('cached level mismatch still rechecks the selector', () => {
  const f = fixture();
  const selector = new Element('Standard', { 'aria-label': 'Thinking effort' });
  const keys = [];
  selector.dispatchEvent = (event) => { keys.push(event.key); return true; };
  f.api.clearPending();
  f.api.setEnabledForTest(true);
  f.api.setConfirmedTargets({ 'thinking effort': 'high' });
  f.setControls([selector]);
  f.api.scanControls();
  assert.equal(selector.hasAttribute('data-ghrc-high-thinking-selector'), false);
  assert.ok(keys.includes('ArrowDown'));
});
test('click opens the menu when the trigger ignores the keyboard action', () => {
  const f = fixture();
  f.elements.delete('menu');
  f.api.clearPending();
  f.api.setEnabledForTest(true);
  f.setControls([f.selector]);
  f.api.scanControls();
  assert.equal(f.selector.clicks, 0);
  f.runTimer(50);
  assert.equal(f.selector.clicks, 1);
});
test('click fallback leaves an already opened menu open', () => {
  const f = fixture();
  f.elements.delete('menu');
  f.api.clearPending();
  f.api.setEnabledForTest(true);
  f.setControls([f.selector]);
  f.api.scanControls();
  f.elements.set('menu', f.menu);
  f.runTimer(50);
  assert.equal(f.selector.clicks, 0);
});
test('canceling a selection prevents its delayed click', () => {
  const f = fixture();
  f.elements.delete('menu');
  f.api.clearPending();
  f.api.setEnabledForTest(true);
  f.setControls([f.selector]);
  f.api.scanControls();
  f.api.clearPending();
  f.runTimer(50);
  assert.equal(f.selector.clicks, 0);
});
test('automatic menu selection returns focus to the previously focused composer', () => {
  const f = fixture();
  const composer = new Element();
  let focusCalls = 0;
  composer.focus = () => { focusCalls += 1; };
  f.document.activeElement = f.selector;
  f.api.begin(f.selector, f.state, 'standard', composer);
  f.api.finishSelection('high', true);
  f.runTimer(50);
  assert.equal(focusCalls, 1);
});
test('automatic menu selection preserves focus when the user moves elsewhere', () => {
  const f = fixture();
  const composer = new Element();
  let focusCalls = 0;
  composer.focus = () => { focusCalls += 1; };
  f.menu.contains = () => false;
  f.document.activeElement = new Element();
  f.api.begin(f.selector, f.state, 'standard', composer);
  f.api.finishSelection('high', true);
  f.runTimer(50);
  assert.equal(focusCalls, 0);
});
for (const [levels, maximum] of [
  [['Standard', 'Extended'], 'Extended'],
  [['Light', 'Standard', 'Extended', 'Heavy'], 'Heavy'],
  [['Low', 'Medium', 'High', 'Extra high'], 'Extra high'],
]) {
  test(`selects ${maximum} from available menu levels`, () => {
    const f = fixture();
    const options = levels.map((level) => new Element(level));
    f.menu.querySelectorAll = () => options;
    assert.equal(f.api.selectMaximum(), true);
    assert.equal(f.state.target, maximum.toLowerCase());
    assert.equal(options.find((o) => o.textContent === maximum).clicks, 1);
    assert.equal(options.filter((o) => o.textContent !== maximum).reduce((sum, o) => sum + o.clicks, 0), 0);
  });
}
test('unavailable Heavy option does not prevent selecting Extended', () => {
  const f = fixture();
  const extended = new Element('Extended');
  f.menu.querySelectorAll = () => [extended, new Element('Heavy', { 'aria-disabled': 'true' })];
  f.api.selectMaximum();
  assert.equal(extended.clicks, 1);
});
test('power slider is raised to its reported maximum before confirmation', () => {
  const f = fixture();
  const slider = new Element('', { 'aria-valuenow': '1', 'aria-valuemax': '2' });
  slider.dispatchEvent = (event) => {
    if (event.type === 'keydown' && event.key === 'ArrowRight') slider.attrs['aria-valuenow'] = '2';
  };
  f.menu.querySelector = (selector) => selector.includes('slider') ? slider : new Element('High');
  f.api.selectMaximum();
  assert.equal(f.state.target, '');
  assert.equal(slider.getAttribute('aria-valuenow'), '2');
  f.api.selectMaximum();
  assert.equal(f.state.target, 'high');
});

test('hidden unified reasoning trigger reads its explicit level and reuses the confirmed target', () => {
  const f = fixture();
  const selector = new Element('Thinking effortHigh', {
    'aria-label': 'Select ChatGPT model',
    'data-codex-intelligence-trigger': 'true',
    'data-composer-navigation-target': 'reasoning',
    'data-selected-reasoning-effort': 'high',
  });
  assert.equal(f.api.effortLevel(selector), 'high');
  assert.equal(f.api.controlCacheKey(selector), 'composer reasoning effort');
  const keys = [];
  selector.dispatchEvent = event => { keys.push(event.key); return true; };
  f.api.clearPending();
  f.api.setEnabledForTest(true);
  f.api.setConfirmedTargets({ 'composer reasoning effort': 'high' });
  f.setControls([selector]);
  f.api.scanControls();
  assert.equal(selector.hasAttribute('data-ghrc-high-thinking-selector'), true);
  assert.deepEqual(keys, []);
});
