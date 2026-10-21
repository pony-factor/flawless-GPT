const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAllowance } = require('../js/research/deep-research-tracker.js');
const { quotaFromResponse } = require('../js/research/deep-research-usage.js');

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

const { TTL_MS, fresh, observed, spent, claimRefresh } = require('../js/research/deep-research-cache-background.js');
const quotaState = (remaining = 13) => ({ quota: { remaining, observedAt: 1000, resetAt: 1000 + 30 * 24 * 60 * 60_000 }, spent: [], lastRefreshAttempt: 0 });

test('eight-hour cache ignores repeated native initialization while keeping local spends', () => {
  const first = quotaState();
  const afterSpend = spent(first, 'tab-1:send-1', 1100);
  assert.equal(afterSpend.quota.remaining, 12);
  assert.equal(afterSpend.quota.observedAt, 1000, 'spending does not extend the refresh deadline');
  assert.equal(observed(afterSpend, { remaining: 13, resetAt: first.quota.resetAt, observedAt: 2000 }, false, 2000), afterSpend);
  assert.equal(spent(afterSpend, 'tab-1:send-1', 1200), afterSpend, 'duplicate sends are idempotent');
  assert.equal(spent(spent(afterSpend, 'tab-2:send-2', 1200), 'tab-3:send-3', 1300).quota.remaining, 10);
  assert.equal(observed(afterSpend, { remaining: 9, resetAt: first.quota.resetAt, observedAt: 3000 }, true, 3000).quota.remaining, 9);
  assert.equal(observed(afterSpend, { remaining: 9, resetAt: first.quota.resetAt, observedAt: TTL_MS + 1001 }, false, TTL_MS + 1001).quota.remaining, 9);
});

test('refresh after eight hours, throttle failed attempts, and invalidate expired reset', () => {
  const initial = quotaState(0);
  assert.equal(fresh(initial.quota, 1000 + TTL_MS - 1), true);
  assert.equal(fresh(initial.quota, 1000 + TTL_MS), false);
  assert.equal(claimRefresh(initial, 1100)[1], false);
  const [claimed, firstClaim] = claimRefresh(initial, 1000 + TTL_MS);
  assert.equal(firstClaim, true);
  assert.equal(claimRefresh(claimed, 1000 + TTL_MS + 1000)[1], false);
  assert.equal(claimRefresh(claimed, 1000 + TTL_MS + 5 * 60_000)[1], true);
  const expired = { ...initial, quota: { ...initial.quota, resetAt: 1400 } };
  assert.equal(fresh(expired.quota, 1400), false);
  assert.equal(spent(expired, 'late', 1400), expired);
  assert.equal(spent(initial, 'zero', 1200).quota.remaining, 0);
});

test('unknown quotas are never invented or decremented', () => {
  const empty = { quota: null, spent: [], lastRefreshAttempt: 0 };
  assert.equal(spent(empty, 'no-quota', 1200), empty);
  assert.equal(observed(empty, { remaining: -1, observedAt: 1100, resetAt: null }, true, 1200), empty);
});
