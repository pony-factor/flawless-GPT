(() => {
  const SETTING_KEY = "stripUtmTracking";
  const ENABLED_ATTR = "data-ghrc-strip-utm-tracking";

  function applySetting(value) {
    const apply = () => {
      if (!document.documentElement) {
        requestAnimationFrame(apply);
        return;
      }
      document.documentElement.setAttribute(ENABLED_ATTR, value ? "true" : "false");
    };
    apply();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[SETTING_KEY]) return;
    applySetting(Boolean(changes[SETTING_KEY].newValue));
  });

  void chrome.storage.local.get({ [SETTING_KEY]: true }).then((settings) => {
    applySetting(Boolean(settings[SETTING_KEY]));
  });
})();
