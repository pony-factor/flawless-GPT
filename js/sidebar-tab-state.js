(() => {
  const INSTALL_MARKER = "__ghrcSidebarTabStateInstalled";
  if (window[INSTALL_MARKER]) return;

  const COOKIE_NAME = "codex_sidebar_state";
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  if (!cookie?.get || !cookie?.set) return;

  // The server reads the real cookie before our scripts run. Keep it collapsed
  // so new documents arrive with a collapsed sidebar, rather than closing it
  // after hydration. Expanded state stays in this document only.
  Reflect.apply(cookie.set, document, [
    `${COOKIE_NAME}=collapsed; Path=/; Max-Age=31536000; SameSite=Lax`,
  ]);

  // ChatGPT reads this preference again on window focus. Keep its value local
  // to this tab so both hover reveals and manual toggles stay independent.
  let state = "collapsed";

  Object.defineProperty(document, "cookie", {
    configurable: true,
    enumerable: cookie.enumerable,
    get() {
      const cookies = Reflect.apply(cookie.get, this, []).split(/;\s*/)
        .filter(value => value && value.split("=", 1)[0] !== COOKIE_NAME);
      cookies.push(`${COOKIE_NAME}=${state}`);
      return cookies.join("; ");
    },
    set(value) {
      const text = String(value);
      const pair = text.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (pair.slice(0, separator).trim() !== COOKIE_NAME) {
        Reflect.apply(cookie.set, this, [text]);
        return;
      }

      const next = pair.slice(separator + 1).trim();
      state = next === "expanded" ? "expanded" : "collapsed";
    },
  });

  if (typeof BroadcastChannel === "function") {
    const postMessage = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function sidebarLocalMessage(message) {
      if (this.name === "codex:preference-cookies" && message === COOKIE_NAME) return;
      return Reflect.apply(postMessage, this, [message]);
    };
  }

  window[INSTALL_MARKER] = true;
})();
