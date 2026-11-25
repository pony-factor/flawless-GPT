(() => {
  "use strict";

  let stopped = false;
  const main = document.querySelector("main");

  function stop() {
    if (stopped) return;
    stopped = true;
    const notice = document.createElement("p");
    notice.id = "settings-context-notice";
    notice.setAttribute("role", "alert");
    notice.textContent = "Flawless ChatGPT settings are unavailable. Close this page and reopen settings from the extension menu. If needed, reload the extension first.";
    if (main) {
      main.inert = true;
      main.before(notice);
    } else {
      document.body.prepend(notice);
    }
  }

  function active() {
    if (!stopped && (!globalThis.chrome?.runtime?.id
      || !globalThis.chrome?.storage?.local
      || !globalThis.chrome?.storage?.onChanged)) stop();
    return !stopped;
  }

  function report(error) {
    if (/extension context invalidated/i.test(error?.message || "") || !active()) {
      stop();
      return;
    }
    console.error("Flawless ChatGPT settings action failed:", error);
  }

  globalThis.__ghrcSettingsContext = { active, report };

  // An already-open settings page can outlive an extension reload.
  window.addEventListener("focus", active);
  document.addEventListener("visibilitychange", active);
  for (const type of ["click", "keydown", "input", "change", "submit"]) {
    document.addEventListener(type, (event) => {
      if (active()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }
  active();
})();
