(() => {
  // Serialize quota changes in one extension service worker so simultaneous tabs
  // cannot lose decrements through read/modify/write races.
  const KEY = 'deepResearchQuotaStateV1';
  const TTL_MS = 8 * 60 * 60_000;
  const NEAR_RESET_MS = 24 * 60 * 60_000;
  const LIVE_REFRESH_MS = 5 * 60_000;
  const RETRY_MS = 5 * 60_000;
  let writes = Promise.resolve();
  const serial = fn => {
    const next = writes.then(fn);
    writes = next.catch(() => {});
    return next;
  };

  function validQuota(value, now = Date.now()) {
    return value && Number.isSafeInteger(value.remaining) && value.remaining >= 0
      && Number.isFinite(value.observedAt) && value.observedAt >= 0 && value.observedAt <= now
      && (value.resetAt === null || (Number.isFinite(value.resetAt) && value.resetAt > 0));
  }
  function nearReset(quota, now = Date.now()) {
    // resetAt is the server's *expected* instant, not proof of replenishment.
    // Treat overdue estimates as near reset until native metadata confirms a new cycle.
    return validQuota(quota, now) && quota.resetAt !== null
      && quota.resetAt - now <= NEAR_RESET_MS;
  }
  function refreshInterval(quota, now = Date.now()) {
    return nearReset(quota, now) ? LIVE_REFRESH_MS : TTL_MS;
  }
  function fresh(quota, now = Date.now()) {
    // The eight-hour cache is never used within the final 24 hours.
    return validQuota(quota, now) && !nearReset(quota, now)
      && now - quota.observedAt < TTL_MS;
  }
  function snapshot(value) {
    return value ? { remaining: value.remaining, resetAt: value.resetAt, observedAt: value.observedAt } : null;
  }
  function observed(state, quota, force, now = Date.now()) {
    if (!validQuota(quota, now)) return state;
    // A native init request can repeat an older server balance after a local
    // spend. Accept it only at expiry or when the user explicitly refreshes.
    if (!force && fresh(state.quota, now)) return state;
    // Responses from earlier in-flight requests cannot roll the counter back.
    if (!force && validQuota(state.quota, now) && quota.observedAt < state.quota.observedAt) return state;
    const next = snapshot(quota);
    // The expected reset can drift across native responses. Do not assume
    // the next period has begun *before* the previously advertised deadline.
    // Preserve that deadline so a later observation can confirm the rollover.
    if (!force && validQuota(state.quota, now) && state.quota.resetAt !== null
      && now < state.quota.resetAt && next.resetAt !== null
      && next.resetAt > state.quota.resetAt && next.remaining > state.quota.remaining) return state;
    const samePeriod = validQuota(state.quota, now) && state.quota.resetAt === next.resetAt;
    // A lagging server snapshot must not restore locally spent credits, even
    // after the expected reset timestamp. Only a confirmed new reset window
    // (or the user's explicit Refresh) can increase the allowance.
    if (!force && samePeriod) next.remaining = Math.min(state.quota.remaining, next.remaining);
    return { ...state, quota: next,
      spent: !force && samePeriod ? state.spent : [],
      lastRefreshAttempt: state.lastRefreshAttempt };
  }
  function spent(state, id, now = Date.now()) {
    if (typeof id !== 'string' || !id || id.length > 128
      || !validQuota(state.quota, now) || state.spent?.includes(id)) return state;
    return { ...state,
      quota: { ...state.quota, remaining: Math.max(0, state.quota.remaining - 1) },
      spent: [...(state.spent || []), id].slice(-64) };
  }
  function claimRefresh(state, now = Date.now()) {
    // A near-reset observation uses a short polling window. An overdue reset
    // does not by itself trigger a new credit bucket or a rapid polling loop.
    if ((validQuota(state.quota, now) && now - state.quota.observedAt < refreshInterval(state.quota, now))
      || (state.lastRefreshAttempt > 0 && now - state.lastRefreshAttempt < RETRY_MS)) return [state, false];
    return [{ ...state, lastRefreshAttempt: now }, true];
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TTL_MS, NEAR_RESET_MS, LIVE_REFRESH_MS, validQuota, nearReset, refreshInterval, fresh, observed, spent, claimRefresh };
    return;
  }

  async function state() {
    const saved = (await chrome.storage.local.get(KEY))[KEY];
    return { quota: validQuota(saved?.quota) ? snapshot(saved.quota) : null,
      spent: Array.isArray(saved?.spent) ? saved.spent.filter(x => typeof x === 'string').slice(-64) : [],
      lastRefreshAttempt: Number.isFinite(saved?.lastRefreshAttempt) ? saved.lastRefreshAttempt : 0 };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['deep-research-quota-read', 'deep-research-quota-observed',
      'deep-research-quota-spent', 'deep-research-quota-refresh-claim'].includes(message?.type)) return false;
    // Only first-party extension scripts in a ChatGPT top-level tab may change
    // the allowance; never accept quota writes from arbitrary pages/frames.
    try {
      if (sender.id !== chrome.runtime.id || sender.frameId !== 0
        || new URL(sender.url).origin !== 'https://chatgpt.com') return false;
    } catch { return false; }
    serial(async () => {
      const oldState = await state();
      let next = oldState;
      let refresh = false;
      if (message.type === 'deep-research-quota-observed')
        next = observed(oldState, message.quota, message.force === true);
      else if (message.type === 'deep-research-quota-spent')
        next = spent(oldState, message.id);
      else if (message.type === 'deep-research-quota-refresh-claim')
        [next, refresh] = claimRefresh(oldState);
      if (next !== oldState) await chrome.storage.local.set({ [KEY]: next });
      return { ok: true, quota: next.quota, refresh };
    }).then(respond, () => respond({ ok: false }));
    return true;
  });
})();
