(() => {
  const INSTALL_MARKER = "__ghrcSidebarTabStateInstalled";
  if (window[INSTALL_MARKER]) return;

  const COOKIE_NAME = "codex_sidebar_state";
  const SESSION_KEY = "ghrc:sidebar-state";
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  if (!cookie?.get || !cookie?.set) return;

  // ChatGPT reads this preference again on window focus. Keep its value local
  // to this tab so both hover reveals and manual toggles stay independent.
  let state = "collapsed";
  try {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved === "expanded" || saved === "collapsed") state = saved;
  } catch {}

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
      try { sessionStorage.setItem(SESSION_KEY, state); } catch {}
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
