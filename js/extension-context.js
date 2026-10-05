(() => {
  // Reloading an unpacked extension leaves its old content scripts in open tabs.
  let stopped = false;
  const cleanups = new Set();
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
  }
  function active() {
    if (!stopped && (!globalThis.chrome?.runtime?.id || !globalThis.chrome?.storage?.local)) stop();
    return !stopped;
  }
  function handleError(error) {
    if (/extension context invalidated/i.test(error?.message || "") || !active()) {
      stop();
      return;
    }
    console.warn("Flawless ChatGPT action failed:", error);
  }
  async function run(action) {
    if (!active()) return;
    try { return await action(); }
    catch (error) { handleError(error); }
  }
  globalThis.__ghrcExtensionContext = {
    active, run, handleError,
    onStop(cleanup) { if (stopped) cleanup(); else cleanups.add(cleanup); },
  };
})();
