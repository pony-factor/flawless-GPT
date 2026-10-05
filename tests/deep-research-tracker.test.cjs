const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAllowance } = require('../js/deep-research-tracker.js');
const { quotaFromResponse } = require('../js/deep-research-usage.js');

test('reads the server report bucket and timestamp while excluding lightweight reports', () => {
  assert.deepEqual(quotaFromResponse({ limits_progress: [
    { feature_name: 'deep_research_mini', remaining: 99, reset_after: '2026-11-01T00:00:00Z' },
    { feature_name: 'deep_research', remaining: 13, reset_after: '2026-10-21T17:43:43.591330+00:00' },
  ] }, 1000), { remaining: 13, resetAt: Date.parse('2026-10-21T17:43:43.591Z'), observedAt: 1000 });
});

test('missing or malformed server quotas remain unknown; zero is valid', () => {
  for (const remaining of [-1, null, '13', 1.5]) {
    assert.equal(quotaFromResponse({ limits_progress: [{ feature_name: 'deep_research', remaining }] }), null);
  }
  assert.equal(quotaFromResponse({ limits_progress: [] }), null);
  assert.equal(quotaFromResponse({ limits_progress: [{ feature_name: 'deep_research', remaining: 0 }] }).remaining, 0);
});

test('keeps full and lightweight report allowances distinct, including zero', () => {
  assert.deepEqual(parseAllowance('Deep research\n0 full reports remaining\n15 lightweight reports remaining\nResets on October 20'), {
    remaining: 0, full: true, reset: 'Resets on October 20',
  });
  assert.equal(parseAllowance('15 lightweight reports remaining').remaining, null);
});

test('does not claim unspecified reports are full reports', () => {
  assert.deepEqual(parseAllowance('Deep research\n23 remaining\nResets in 12 days'), {
    remaining: 23, full: false, reset: 'Resets in 12 days',
  });
});

test('missing and unrelated values remain unknown', () => {
  assert.deepEqual(parseAllowance('Deep research\nResearch 42 companies'), { remaining: null, full: false, reset: '' });
});

test('prefers the explicit full allowance over an unspecified allowance', () => {
  assert.equal(parseAllowance('3 full reports left\n18 reports available').remaining, 3);
});

test('handles tooltip text laid out on a single line', () => {
  assert.deepEqual(parseAllowance('Deep research 0 full reports remaining 10 lightweight reports remaining Resets on October 20'), {
    remaining: 0, full: true, reset: 'Resets on October 20',
  });
});
