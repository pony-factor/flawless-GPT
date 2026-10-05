(() => {
  // ChatGPT supplies its research allowance in conversation initialization.
  // Keep credentials inside the page's own Request; expose only this quota.
  const ATTRIBUTE = 'data-ghrc-deep-research-usage';
  const REFRESH_EVENT = 'ghrc-refresh-deep-research-usage';
  let latestRequest = null;
  let generation = 0;
  let refreshing = false;
  let lastRefresh = 0;

  function quotaFromResponse(data, now = Date.now()) {
    const quota = data?.limits_progress?.find(item => item.feature_name === 'deep_research');
    if (!Number.isSafeInteger(quota?.remaining) || quota.remaining < 0) return null;
    const resetAt = typeof quota.reset_after === 'string' ? Date.parse(quota.reset_after) : NaN;
    return { remaining: quota.remaining, resetAt: Number.isFinite(resetAt) ? resetAt : null, observedAt: now };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { quotaFromResponse };
    return;
  }
  const nativeFetch = window.fetch;

  async function publish(response, requestGeneration) {
    if (!response.ok || generation !== requestGeneration) return;
    try {
      const quota = quotaFromResponse(await response.json());
      if (generation !== requestGeneration) return;
      if (quota) document.documentElement.setAttribute(ATTRIBUTE, JSON.stringify(quota));
      else document.documentElement.removeAttribute(ATTRIBUTE);
    } catch { /* Leave the native response and last successful observation alone. */ }
  }

  window.fetch = function(...args) {
    let request = null;
    try {
      const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
      if (url.origin === location.origin && url.pathname === '/backend-api/conversation/init') {
        request = new Request(args[0] instanceof Request ? args[0].clone() : url.href, args[1]);
      }
    } catch { /* Do not interfere with native fetch validation. */ }
    const result = nativeFetch.apply(this, args);
    if (request) {
      latestRequest = request;
      const currentGeneration = ++generation;
      result.then(response => publish(response.clone(), currentGeneration)).catch(() => {});
    }
    return result;
  };

  window.addEventListener(REFRESH_EVENT, async () => {
    if (!latestRequest || refreshing || Date.now() - lastRefresh < 30_000) return;
    refreshing = true;
    lastRefresh = Date.now();
    const currentGeneration = generation;
    try {
      // Initialization refreshes metadata; it never submits a prompt or starts research.
      const response = await nativeFetch.call(window, new Request(latestRequest.clone(), {
        signal: AbortSignal.timeout(10_000),
      }));
      await publish(response, currentGeneration);
    } catch { /* Failed refreshes must not become a fabricated balance. */ }
    finally { refreshing = false; }
  });
})();
