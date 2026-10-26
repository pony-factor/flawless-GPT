const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAllowance, selectedResearchQuota, selectedResearchPieTotal, usagePieTotal, usagePiePercent } = require('../js/research/deep-research-tracker.js');
const { quotaFromResponse } = require('../js/research/deep-research-usage.js');

test('usage pie accepts reported or custom totals and estimates common tiers', () => {
  assert.equal(usagePieTotal(25), 25);
  assert.equal(usagePieTotal(13), 25);
  assert.equal(usagePieTotal(200), 250);
  assert.equal(usagePieTotal(250), 250);
  assert.equal(usagePieTotal(251), null);
  assert.equal(usagePieTotal(13, 250), 250);
  assert.equal(usagePieTotal(90, 100), 100);
  assert.equal(usagePieTotal(200, null, 200), 200);
  assert.equal(usagePieTotal(13, null, 200), 200);
  assert.equal(usagePieTotal(201, null, 200), null);
  for (const remaining of [null, undefined, -1, 1.2, '13']) {
    assert.equal(usagePieTotal(remaining), null);
  }
  assert.equal(usagePiePercent(25, 25), 100);
  assert.equal(usagePiePercent(13, 25), 52);
  assert.equal(usagePiePercent(200, 250), 80);
  assert.equal(usagePiePercent(2, 25), 8);
  assert.equal(usagePiePercent(0, 250), 0);
  assert.equal(usagePiePercent(5, 0), null);
  assert.equal(usagePiePercent(201, 200), null);
});

test('both settings views default to full-only counter and share the same preference', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['options.html', 'popup.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(html, /id="deep-research-allowance-mode"/);
    assert.match(html, /<option value="full" selected>Full research only<\/option>/);
    assert.match(html, /<option value="all">Full \+ lightweight<\/option>/);
    assert.match(html, /The composer uses the same reports-remaining and reset-countdown choices/);
    assert.doesNotMatch(html, /id="show-deep-research-composer-(?:count|reset)"/);
  }
  const settings = fs.readFileSync(path.join(__dirname, '../js/settings/options.js'), 'utf8');
  assert.match(settings, /deepResearchAllowanceMode: "full"/);
  assert.match(settings, /deepResearchAllowanceMode: deepResearchAllowanceModeInput\.value/);
  assert.doesNotMatch(settings, /showDeepResearchComposer(?:Count|Reset)/);
  assert.match(settings, /deepResearchUsagePieTotals: \{ \.\.\.researchPieTotals \}/);
  assert.match(settings, /renderSelectedResearchPieTotal\(\)/);
});

test('custom pie totals stay mode-specific and old totals migrate to their prior mode', () => {
  const settings = { deepResearchAllowanceMode: 'full', deepResearchUsagePieTotal: 250,
    deepResearchUsagePieTotals: { full: 20, all: 200 } };
  assert.equal(selectedResearchPieTotal(settings, 'full'), 20);
  assert.equal(selectedResearchPieTotal(settings, 'all'), 200);
  assert.equal(usagePiePercent(13, usagePieTotal(13, null, selectedResearchPieTotal(settings, 'full'))), 65);
  assert.equal(usagePiePercent(100, usagePieTotal(100, null, selectedResearchPieTotal(settings, 'all'))), 50);
  assert.equal(selectedResearchPieTotal({ ...settings, deepResearchUsagePieTotals: { full: null, all: 200 } }, 'full'), null);
  assert.equal(selectedResearchPieTotal({ deepResearchAllowanceMode: 'full', deepResearchUsagePieTotal: 20 }, 'full'), 20);
  assert.equal(selectedResearchPieTotal({ deepResearchAllowanceMode: 'full', deepResearchUsagePieTotal: 20 }, 'all'), null);
  assert.equal(selectedResearchPieTotal({ deepResearchAllowanceMode: 'all', deepResearchUsagePieTotal: 200 }, 'all'), 200);
  assert.equal(selectedResearchPieTotal({ deepResearchAllowanceMode: 'all', deepResearchUsagePieTotal: 200 }, 'full'), null);
  assert.equal(selectedResearchPieTotal({ deepResearchUsagePieTotals: { full: 10001, all: -1 } }, 'full'), null);
  assert.equal(selectedResearchPieTotal({ deepResearchUsagePieTotals: { full: 10001, all: -1 } }, 'all'), null);
});

test('full-only default and combined selection keep research pools distinct', () => {
  const buckets = { remaining: 6, total: 10, miniRemaining: 13, miniTotal: 15 };
  assert.deepEqual(selectedResearchQuota(buckets), { remaining: 6, total: 10 });
  assert.deepEqual(selectedResearchQuota(buckets, 'full'), { remaining: 6, total: 10 });
  assert.deepEqual(selectedResearchQuota(buckets, 'all'), { remaining: 19, total: 25 });
  assert.deepEqual(selectedResearchQuota({ remaining: 6 }, 'all'), { remaining: null, total: null });
  assert.deepEqual(selectedResearchQuota({ remaining: 0, miniRemaining: 0 }, 'all'),
    { remaining: 0, total: null });
  assert.equal(usagePiePercent(6, selectedResearchQuota(buckets).total), 60);
  assert.equal(usagePiePercent(19, selectedResearchQuota(buckets, 'all').total), 76);
});

test('reads separate full and lightweight quota fields without combining them', () => {
  assert.deepEqual(quotaFromResponse({ limits_progress: [
    { feature_name: 'deep_research', remaining: 6, total: 10, reset_after: '2026-11-01T00:00:00Z' },
    { feature_name: 'deep_research_mini', remaining: 13, total: 15 },
  ] }, 1000), {
    remaining: 6, total: 10, miniRemaining: 13, miniTotal: 15,
    resetAt: Date.parse('2026-11-01T00:00:00Z'), observedAt: 1000,
  });
  assert.equal(quotaFromResponse({ limits_progress: [
    { feature_name: 'deep_research', remaining: 8 },
    { feature_name: 'deep_research_mini', remaining: -4 },
  ] }).miniRemaining, undefined);
});

test('reads the server report bucket and timestamp while excluding lightweight reports', () => {
  assert.deepEqual(quotaFromResponse({ limits_progress: [
    { feature_name: 'deep_research_mini', remaining: 99, reset_after: '2026-11-01T00:00:00Z' },
    { feature_name: 'deep_research', remaining: 13, reset_after: '2026-10-21T17:43:43.591330+00:00' },
  ] }, 1000), { remaining: 13, resetAt: Date.parse('2026-10-21T17:43:43.591Z'), observedAt: 1000 });
});

test('uses the full-research quota total if the server reports one', () => {
  assert.deepEqual(quotaFromResponse({ limits_progress: [
    { feature_name: 'deep_research_mini', remaining: 17, total: 1000 },
    { feature_name: 'deep_research', remaining: 200, total: 250 },
  ] }, 1000), { remaining: 200, resetAt: null, observedAt: 1000, total: 250 });
  assert.equal(quotaFromResponse({ limits_progress: [
    { feature_name: 'deep_research', remaining: 20, limit: 200 },
  ] }).total, 200);
  assert.equal(quotaFromResponse({ limits_progress: [
    { feature_name: 'deep_research', remaining: 20, total: 10 },
  ] }).total, undefined);
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

test('cache preserves the separate lightweight bucket and spends full reports first', () => {
  const now = 100_000_000;
  const resetAt = now + 60 * 60_000;
  const original = observed({ quota: null, spent: [], lastRefreshAttempt: 0 },
    { remaining: 1, total: 10, miniRemaining: 3, miniTotal: 15, resetAt, observedAt: now },
    false, now);
  const first = spent(original, 'full-send', now + 1);
  assert.equal(first.quota.remaining, 0);
  assert.equal(first.quota.miniRemaining, 3);
  const second = spent(first, 'lightweight-send', now + 2);
  assert.equal(second.quota.remaining, 0);
  assert.equal(second.quota.miniRemaining, 2);
  assert.equal(spent(second, 'lightweight-send', now + 3), second);
  const sameWindow = observed(second,
    { remaining: 1, resetAt, observedAt: now + 5 }, false, now + 5);
  assert.equal(sameWindow.quota.remaining, 0);
  assert.equal(sameWindow.quota.miniRemaining, 2);
  assert.equal(sameWindow.quota.miniTotal, 15);
  assert.equal(selectedResearchQuota(sameWindow.quota, 'all').remaining, 2);
});

// Integration: a reported account maximum must survive the shared quota cache.
test('full report allowance total survives cache observations and local spending', () => {
  const now = 100_000_000;
  const resetAt = now + 60 * 60_000;
  const start = { quota: null, spent: [], lastRefreshAttempt: 0 };
  const first = observed(start, { remaining: 180, total: 200, resetAt, observedAt: now }, false, now);
  assert.equal(first.quota.total, 200);
  const used = spent(first, 'research-pie-spend', now + 1);
  assert.equal(used.quota.remaining, 179);
  assert.equal(used.quota.total, 200);
  const next = observed(used, { remaining: 178, resetAt, observedAt: now + 2 }, false, now + 2);
  assert.equal(next.quota.total, 200, 'same-window observations must not lose the reported maximum');
});
