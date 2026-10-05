(() => {
  const ROUTE_CHANGE_EVENT = "ghrc:route-change";
  const INSTALL_MARKER = "__ghrcRouteEventsInstalled";

  if (window[INSTALL_MARKER]) return;
  window[INSTALL_MARKER] = true;

  let lastHref = location.href;

  function notifyIfChanged() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
  }

  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    if (typeof original !== "function") continue;

    history[method] = function routeAwareHistory(...args) {
      const result = Reflect.apply(original, this, args);
      queueMicrotask(notifyIfChanged);
      return result;
    };
  }

  window.addEventListener("popstate", notifyIfChanged);
  window.addEventListener("hashchange", notifyIfChanged);
})();
