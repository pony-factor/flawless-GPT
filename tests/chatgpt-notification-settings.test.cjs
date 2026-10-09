const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '../js/chatgpt-notification-settings.js'),
  'utf8'
);

function harness({ enabled = true, available = true } = {}) {
  const events = {};
  const operations = [];
  let setting = enabled;
  const listeners = (name) => ({
    addListener(callback) { events[name] = callback; },
  });
  const chrome = {
    storage: {
      local: {
        async get() { return { blockChatgptDesktopNotifications: setting }; },
      },
      onChanged: listeners('change'),
    },
    runtime: {
      onInstalled: listeners('installed'),
      onStartup: listeners('startup'),
    },
    ...(available ? {
      contentSettings: {
        notifications: {
          async set(details) { operations.push({ method: 'set', ...details }); },
          async clear(details) { operations.push({ method: 'clear', ...details }); },
        },
      },
    } : {}),
  };
  vm.runInNewContext(source, { chrome, console });
  return {
    events,
    operations,
    async tick() { await new Promise((resolve) => setImmediate(resolve)); },
    async change(enabled) {
      setting = enabled;
      events.change({ blockChatgptDesktopNotifications: { newValue: enabled } }, 'local');
      await this.tick();
    },
  };
}

test('blocks only chatgpt.com desktop notifications by default', async () => {
  const app = harness();
  await app.tick();
  assert.deepEqual(app.operations, [{
    method: 'set',
    primaryPattern: 'https://chatgpt.com/*',
    setting: 'block',
    scope: 'regular',
  }]);
});

test('opt-out clears extension rule to restore the browser site preference', async () => {
  const app = harness({ enabled: false });
  await app.tick();
  assert.deepEqual(app.operations, [{ method: 'clear', scope: 'regular' }]);
  await app.change(true);
  assert.equal(app.operations.at(-1).setting, 'block');
  await app.change(false);
  assert.deepEqual(app.operations.at(-1), { method: 'clear', scope: 'regular' });
});

test('ignores unrelated changes and refreshes on startup/install', async () => {
  const app = harness();
  await app.tick();
  app.events.change({ otherPreference: { newValue: false } }, 'local');
  app.events.change({ blockChatgptDesktopNotifications: { newValue: false } }, 'sync');
  await app.tick();
  assert.equal(app.operations.length, 1);
  app.events.startup();
  app.events.installed({ reason: 'update' });
  await app.tick();
  assert.equal(app.operations.length, 3);
  assert(app.operations.every((entry) => entry.setting === 'block'));
});

test('does not crash when contentSettings is unavailable', async () => {
  const app = harness({ available: false });
  await app.tick();
  await app.change(false);
  assert.deepEqual(app.operations, []);
});
