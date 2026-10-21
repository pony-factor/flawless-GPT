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
  assert.equal(spent(expired, 'late', 1400).quota.remaining, 0, 'an unconfirmed reset does not block research');
  assert.equal(spent(initial, 'zero', 1200).quota.remaining, 0);
});

test('unknown quotas are never invented or decremented', () => {
  const empty = { quota: null, spent: [], lastRefreshAttempt: 0 };
  assert.equal(spent(empty, 'no-quota', 1200), empty);
  assert.equal(observed(empty, { remaining: -1, observedAt: 1100, resetAt: null }, true, 1200), empty);
});

const { NEAR_RESET_MS, LIVE_REFRESH_MS, nearReset, refreshInterval } = require('../js/research/deep-research-cache-background.js');

test('eight-hour caching stops exactly 24 hours before the expected reset', () => {
  const now = 60 * 24 * 60 * 60_000;
  const sample = { remaining: 7, observedAt: now - 60_000, resetAt: now + NEAR_RESET_MS + 1 };
  assert.equal(nearReset(sample, now), false);
  assert.equal(refreshInterval(sample, now), TTL_MS);
  assert.equal(fresh(sample, now), true);
  sample.resetAt = now + NEAR_RESET_MS;
  assert.equal(nearReset(sample, now), true);
  assert.equal(refreshInterval(sample, now), LIVE_REFRESH_MS);
  assert.equal(fresh(sample, now), false);
  assert.equal(claimRefresh({ quota: sample, spent: [], lastRefreshAttempt: 0 }, now)[1], false);
  sample.observedAt = now - LIVE_REFRESH_MS;
  assert.equal(claimRefresh({ quota: sample, spent: [], lastRefreshAttempt: 0 }, now)[1], true);
});

test('during last day, accept native decreases without restoring local spends prematurely', () => {
  const now = 70 * 24 * 60 * 60_000;
  const resetAt = now + 60 * 60_000;
  const original = { quota: { remaining: 5, resetAt, observedAt: now - 10_000 },
    spent: [], lastRefreshAttempt: now - 20_000 };
  const local = spent(original, 'research-1', now);
  const duplicateServer = { remaining: 5, resetAt, observedAt: now + 1 };
  const held = observed(local, duplicateServer, false, now + 1);
  assert.equal(held.quota.remaining, 4);
  assert.deepEqual(held.spent, ['research-1']);
  assert.equal(held.lastRefreshAttempt, original.lastRefreshAttempt, 'preserve polling backoff');
  const reduced = observed(held, { remaining: 3, resetAt, observedAt: now + 2 }, false, now + 2);
  assert.equal(reduced.quota.remaining, 3);
  const earlier = observed(reduced, { remaining: 5, resetAt, observedAt: now + 1 }, false, now + 3);
  assert.equal(earlier, reduced, 'late responses cannot restore credits');
  const manual = observed(reduced, { remaining: 5, resetAt, observedAt: now + 4 }, true, now + 4);
  assert.equal(manual.quota.remaining, 5, 'user-forced refresh is authoritative');
});

test('passing the estimated reset time never manufactures a refill or blocks spends', () => {
  const now = 80 * 24 * 60 * 60_000;
  const oldReset = now - 30_000;
  const initial = { quota: { remaining: 2, observedAt: now - LIVE_REFRESH_MS, resetAt: oldReset },
    spent: [], lastRefreshAttempt: 0 };
  assert.equal(nearReset(initial.quota, now), true);
  const [claimed, eligible] = claimRefresh(initial, now);
  assert.equal(eligible, true);
  assert.equal(claimRefresh(claimed, now + 1000)[1], false, 'no repeated fetch on every timer tick');
  const used = spent(initial, 'research-after-expected-time', now);
  assert.equal(used.quota.remaining, 1);
  const oldWindow = observed(used, { remaining: 7, observedAt: now + 1000, resetAt: oldReset }, false, now + 1000);
  assert.equal(oldWindow.quota.remaining, 1, 'same window is not a verified refill');
  const newWindow = observed(oldWindow, { remaining: 10, observedAt: now + 2000, resetAt: now + 30 * 24 * 60 * 60_000 }, false, now + 2000);
  assert.equal(newWindow.quota.remaining, 10, 'a new server reset window confirms renewal');
  assert.equal(nearReset(newWindow.quota, now + 2000), false);
});

test('apparent early renewal cannot raise credits before the old reset deadline', () => {
  const now = 90 * 24 * 60 * 60_000;
  const original = { quota: { remaining: 1, observedAt: now - 5_000, resetAt: now + 30 * 60_000 },
    spent: [], lastRefreshAttempt: 0 };
  const premature = { remaining: 10, observedAt: now + 1, resetAt: now + 30 * 24 * 60 * 60_000 };
  assert.equal(observed(original, premature, false, now + 1), original);
  assert.equal(observed(original, premature, true, now + 1).quota.remaining, 10,
    'explicit manual checks can trust the current server value');
  assert.equal(observed(original, { ...premature, observedAt: now + 30 * 60_000 },
    false, now + 30 * 60_000).quota.remaining, 10,
    'after the old deadline the new server window can confirm renewal');
});
