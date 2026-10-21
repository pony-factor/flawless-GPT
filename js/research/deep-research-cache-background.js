(() => {
  // Serialize quota changes in one extension service worker so simultaneous tabs
  // cannot lose decrements through read/modify/write races.
  const KEY = 'deepResearchQuotaStateV1';
  const TTL_MS = 8 * 60 * 60_000;
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
  function fresh(quota, now = Date.now()) {
    return validQuota(quota, now) && now - quota.observedAt < TTL_MS
      && (quota.resetAt === null || now < quota.resetAt);
  }
  function snapshot(value) {
    return value ? { remaining: value.remaining, resetAt: value.resetAt, observedAt: value.observedAt } : null;
  }
  function observed(state, quota, force, now = Date.now()) {
    if (!validQuota(quota, now)) return state;
    // A native init request can repeat an older server balance after a local
    // spend. Accept it only at expiry or when the user explicitly refreshes.
    if (fresh(state.quota, now) && !force) return state;
    return { ...state, quota: snapshot(quota), spent: [], lastRefreshAttempt: 0 };
  }
  function spent(state, id, now = Date.now()) {
    if (typeof id !== 'string' || !id || id.length > 128
      || !validQuota(state.quota, now) || (state.quota.resetAt !== null && now >= state.quota.resetAt)
      || state.spent?.includes(id)) return state;
    return { ...state,
      quota: { ...state.quota, remaining: Math.max(0, state.quota.remaining - 1) },
      spent: [...(state.spent || []), id].slice(-64) };
  }
  function claimRefresh(state, now = Date.now()) {
    if (fresh(state.quota, now) || (state.lastRefreshAttempt > 0
      && now - state.lastRefreshAttempt < RETRY_MS)) return [state, false];
    return [{ ...state, lastRefreshAttempt: now }, true];
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TTL_MS, validQuota, fresh, observed, spent, claimRefresh };
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
