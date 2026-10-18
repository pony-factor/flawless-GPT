(() => {
  const SETTINGS = [
    {
      key: "stripUtmTracking",
      attribute: "data-ghrc-strip-utm-tracking",
      defaultValue: true,
    },
    {
      key: "stripCopiedBold",
      attribute: "data-ghrc-strip-copied-bold",
      defaultValue: true,
    },
    {
      key: "normalizeCopiedQuotes",
      attribute: "data-ghrc-normalize-copied-quotes",
      defaultValue: true,
    },
    {
      key: "underscoreCopiedItalics",
      attribute: "data-ghrc-underscore-copied-italics",
      defaultValue: true,
    },
  ];

  function applySetting(attribute, value) {
    const apply = () => {
      if (!document.documentElement) {
        requestAnimationFrame(apply);
        return;
      }
      document.documentElement.setAttribute(attribute, value ? "true" : "false");
    };
    apply();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    for (const setting of SETTINGS) {
      if (!changes[setting.key]) continue;
      applySetting(setting.attribute, Boolean(changes[setting.key].newValue));
    }
  });

  const defaults = Object.fromEntries(
    SETTINGS.map((setting) => [setting.key, setting.defaultValue]),
  );
  void chrome.storage.local.get(defaults).then((settings) => {
    for (const setting of SETTINGS) {
      applySetting(setting.attribute, settings[setting.key] !== false);
    }
  });
})();
