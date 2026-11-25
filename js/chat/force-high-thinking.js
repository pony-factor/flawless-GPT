(() => {
  "use strict";
  const HIGH = "high", EXTRA = "extra high";
  const BUTTON_ID = "ghrc-extra-high-send-button";
  const AUTO_MENU = "data-ghrc-thinking-menu";
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const effort = value => {
    const match = /(?:^|\s)(extra high|xhigh|high|medium|standard|low|light|instant|thinking)(?:$|\s)/i.exec(normalize(value));
    return match ? (match[1].toLowerCase() === "xhigh" ? EXTRA : match[1].toLowerCase()) : "";
  };
  const version = value => {
    const match = /^(?:GPT[- ]?)?(\d+)(?:\.(\d+))?(?:\s*(?:instant|thinking|light|low|standard|medium|high|extra high|xhigh))?$/i.exec(normalize(value));
    return match ? [Number(match[1]), Number(match[2] || 0)] : null;
  };
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1];
  const newest = choices => choices.filter(choice => choice.enabled && choice.version)
    .sort((a, b) => compare(b.version, a.version))[0] || null;
  const desired = (choices, target) => choices.find(choice => choice.enabled && choice.effort === target) || null;
  const matches = (actual, expected) => Boolean(actual && expected && compare(actual, expected) === 0);
  const sliderDirection = (current, target) => {
    const ranks = { instant: 0, light: 1, low: 1, medium: 2, standard: 2, thinking: 2, high: 3, "extra high": 4 };
    if (!Object.hasOwn(ranks, current) || !Object.hasOwn(ranks, target)) return 0;
    return Math.sign(ranks[target] - ranks[current]);
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { version, compare, newest, desired, matches, effort, sliderDirection };
    return;
  }

  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const SETTING = "forceHighThinking", EXTRA_SETTING = "showExtraHighSendButton";
  const MENU_QUERY = '[role="menu"], [role="listbox"]';
  const OPTION_QUERY = '[role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"]';
  const CONTROL_QUERY = 'button[aria-haspopup], [role="button"][aria-haspopup], [role="combobox"], [data-codex-intelligence-trigger]';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length
    && getComputedStyle(node).visibility !== "hidden" && !node.closest("[inert], [hidden]"));
  const enabled = node => Boolean(node && !node.disabled && !node.closest('[aria-disabled="true"], [data-disabled], [inert]'));
  const label = node => normalize(node?.getAttribute("aria-label") || node?.getAttribute("title") || node?.textContent);
  function visibleText(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    clone.querySelectorAll('[aria-hidden="true"]').forEach(child => child.remove());
    return normalize(clone.textContent);
  }
  const modelLabel = node => /^(select chatgpt model|select model)$/i.test(label(node));
  const modelValue = node => version(visibleText(node)) || version(node?.getAttribute("data-selected-model"));
  function level(node) {
    if (!node) return "";
    const explicit = normalize(node.getAttribute("data-selected-reasoning-effort")).replace(/[_-]/g, " ").toLowerCase();
    if (explicit) return effort(explicit);
    const value = visibleText(node);
    const combined = /^(?:GPT[- ]?)?\d+(?:\.\d+)?\s*(extra high|xhigh|high|medium|low|instant|thinking)$/i.exec(value);
    return effort(combined?.[1]) || effort(value) || effort(label(node));
  }
  function usableControl(node) {
    // The extension deliberately hides native model controls with display:none.
    if (!enabled(node) || !node.isConnected) return false;
    if (visible(node)) return true;
    if (!modelLabel(node) && !/thinking|reasoning|effort/i.test(label(node))) return false;
    let parent = node.parentElement;
    while (parent && getComputedStyle(parent).display === "contents") parent = parent.parentElement;
    return visible(parent);
  }
  const controls = () => [...document.querySelectorAll(CONTROL_QUERY)].filter(usableControl);
  const modelControl = () => controls().find(modelLabel);
  const effortControl = () => controls().find(node => !modelLabel(node) && /thinking|reasoning|effort/i.test(label(node)) && level(node))
    || modelControl();
  const queue = () => globalThis.__ghrcMessageQueue;
  const composer = () => queue()?.findComposerInput?.() || [...document.querySelectorAll('#prompt-textarea, [data-composer-markdown][contenteditable="true"]')].filter(visible).at(-1);
  const form = input => input?.closest("form, [data-type='unified-composer']");
  const nativeSend = input => queue()?.findNativeSend?.(input) || [...(form(input)?.querySelectorAll('button[data-testid="send-button"], button[data-testid="composer-submit-button"], button#composer-submit-button, button[aria-label^="Send" i], button[type="submit"]') || [])]
    .find(node => visible(node) && !node.id.startsWith("ghrc-") && !/stop|voice|search|steer/i.test(label(node)));
  const readySend = input => {
    const button = nativeSend(input);
    return visible(button) && enabled(button) ? button : null;
  };
  const readDraft = input => typeof input?.value === "string" ? input.value : input?.innerHTML || "";
  const userTurns = () => queue()?.getDispatcherLifecycle?.()?.userTurns
    ?? [...document.querySelectorAll('[data-message-author-role="user"], [data-content-search-unit-key$=":user"]')].length;
  const route = () => location.href;
  const action = input => queue()?.findActionButton?.(input) || nativeSend(input);

  let force = false, extraButton = false, loaded = false, epoch = 0, restoreRequired = false;
  let active = null, permit = null, internalClick = false, menuSession = null;
  let extraAvailable = false, warmControl = null, warmRoute = "", mountScheduled = false;
  let status = "", draftRevision = 0;
  const on = () => force || extraButton || restoreRequired;
  function report(message) {
    status = message;
    scheduleMount();
  }
  function key(node, value) {
    for (const type of ["keydown", "keyup"]) node?.dispatchEvent(new KeyboardEvent(type, { key: value, code: value, bubbles: true, cancelable: true }));
  }
  const menus = () => [...document.querySelectorAll(MENU_QUERY)].filter(visible);
  function ownedMenus(session) {
    if (!session) return [];
    const controlled = document.getElementById(session.trigger.getAttribute("aria-controls"));
    const own = menus().filter(menu => !session.before.has(menu) || menu === controlled);
    own.forEach(menu => {
      session.owned.add(menu);
      menu.setAttribute(AUTO_MENU, "");
    });
    return own;
  }
  function choices(session) {
    return [...new Set(ownedMenus(session).flatMap(menu => [...menu.querySelectorAll(OPTION_QUERY)]))]
      .filter(node => visible(node) && enabled(node));
  }
  async function waitFor(check, valid, timeout = 1500) {
    const deadline = Date.now() + timeout;
    while (valid() && Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await sleep(35);
    }
    return null;
  }
  async function withMenu(trigger, valid, callback) {
    if (!trigger || !valid() || menuSession || trigger.getAttribute("aria-expanded") === "true") return null;
    const focused = document.activeElement;
    const session = { trigger, before: new Set(menus()), owned: new Set() };
    menuSession = session;
    try {
      key(trigger, "ArrowDown");
      await sleep(80);
      if (!valid()) return null;
      if (!ownedMenus(session).length && trigger.getAttribute("aria-expanded") !== "true") trigger.click();
      if (!await waitFor(() => ownedMenus(session).length, valid)) return null;
      return await callback(session);
    } finally {
      for (const menu of [...session.owned].reverse()) {
        if (visible(menu)) key(menu, "Escape");
      }
      if (trigger.isConnected && trigger.getAttribute("aria-expanded") === "true") key(trigger, "Escape");
      await sleep(80);
      if (trigger.isConnected && trigger.getAttribute("aria-expanded") === "true") trigger.click();
      await waitFor(() => ![...session.owned].some(visible), () => context.active(), 500);
      for (const menu of session.owned) menu.removeAttribute(AUTO_MENU);
      if (menuSession === session) menuSession = null;
      if (focused?.isConnected && (document.activeElement === document.body || document.activeElement === trigger
        || [...session.owned].some(menu => menu.contains(document.activeElement)))) focused.focus({ preventScroll: true });
    }
  }

  async function withModelChoices(valid, callback) {
    const trigger = modelControl();
    return withMenu(trigger, valid, async session => {
      let nested = null;
      const models = await waitFor(() => {
        const options = choices(session);
        const numbered = options.map(node => ({
          node, enabled: true, version: version(visibleText(node)) || version(label(node)),
        })).filter(choice => choice.version);
        if (numbered.length) return numbered;
        const submenu = options.find(node => /^select model$/i.test(label(node)) || /^select model$/i.test(visibleText(node)));
        if (submenu && nested !== submenu && submenu.getAttribute("aria-expanded") !== "true") {
          nested = submenu;
          submenu.click();
        }
        return null;
      }, valid, 3000);
      return models && callback(models);
    });
  }

  function checkedModel(choice) {
    return choice.node.getAttribute("aria-checked") === "true"
      || choice.node.getAttribute("aria-selected") === "true";
  }

  async function selectModel(valid) {
    return withModelChoices(valid, async models => {
      const candidate = newest(models);
      const current = modelValue(modelControl());
      if (matches(current, candidate.version) || checkedModel(candidate)) return candidate.version;
      candidate.node.click();
      // On compact composers, selection can close the only UI that shows the model version.
      if (current) await waitFor(() => matches(modelValue(modelControl()), candidate.version), valid);
      return candidate.version;
    });
  }

  async function confirmModel(expected, valid) {
    const control = modelControl();
    const current = modelValue(control);
    if (!control || !valid()) return null;
    const selected = current ? matches(current, expected) : await withModelChoices(valid, models =>
      models.some(choice => matches(choice.version, expected) && checkedModel(choice)));
    return selected && valid() && modelControl() === control ? { version: expected, control } : null;
  }

  async function selectEffort(target, valid, probe) {
    const trigger = effortControl();
    if (!trigger) return false;
    if (level(trigger) === target && !probe) return true;
    const result = await withMenu(trigger, valid, async session => {
      const menu = await waitFor(() => {
        const own = ownedMenus(session);
        return own.find(node => node.querySelector('[role="slider"][aria-valuemax][aria-valuenow]'))
          || (choices(session).some(node => effort(visibleText(node)) || effort(label(node))) && own.at(-1));
      }, valid);
      if (!menu) return false;
      const options = choices(session).map(node => ({ node, enabled: true, effort: effort(visibleText(node)) || effort(label(node)) }));
      const slider = menu.querySelector('[role="slider"][aria-valuemax][aria-valuenow]');
      if (!slider) {
        extraAvailable = Boolean(desired(options, EXTRA));
        const option = desired(options, target);
        if (level(effortControl()) === target) return true;
        if (!option) return false;
        option.node.click();
        return Boolean(await waitFor(() => level(effortControl()) === target, valid));
      }
      // Never drive a slider to its maximum blindly: High may be below Extra High.
      for (let steps = 0; steps < 12 && valid(); steps++) {
        const current = level(effortControl()) || effort(slider.getAttribute("aria-valuetext"));
        const now = Number(slider.getAttribute("aria-valuenow"));
        const max = Number(slider.getAttribute("aria-valuemax"));
        const min = Number(slider.getAttribute("aria-valuemin") || 0);
        if (current === HIGH) extraAvailable = Number.isFinite(max) && max > now;
        if (current === EXTRA) extraAvailable = true;
        if (current === target) return true;
        const direction = sliderDirection(current, target);
        if (!direction || !Number.isFinite(now) || !Number.isFinite(max) || !Number.isFinite(min)
          || (direction > 0 ? now >= max : now <= min)) return false;
        key(slider.closest('[role="menuitem"]') || slider, direction > 0 ? "ArrowRight" : "ArrowLeft");
        if (!await waitFor(() => level(effortControl()) !== current || Number(slider.getAttribute("aria-valuenow")) !== now, valid, 500)) return false;
      }
      return false;
    });
    return Boolean(result && level(effortControl()) === target);
  }

  async function select(target, valid, probe = false) {
    if (!valid()) return null;
    extraAvailable = false;
    const model = await selectModel(valid);
    if (!model || !valid()) return null;
    const beforeEffort = await confirmModel(model, valid);
    if (!beforeEffort || !await selectEffort(target, valid, probe)) return null;
    const confirmedModel = await confirmModel(model, valid);
    return confirmedModel && confirmed(target, confirmedModel) ? confirmedModel : null;
  }
  function begin(kind, operation) {
    if (active) return null;
    const generation = epoch;
    const token = { kind, valid: () => context.active() && epoch === generation };
    active = token;
    token.promise = Promise.resolve().then(() => operation(token.valid)).catch(error => {
      context.handleError(error);
      return false;
    }).finally(() => {
      if (active === token) active = null;
      scheduleMount();
      window.dispatchEvent(new Event("ghrc:reasoning-selection-complete"));
    });
    scheduleMount();
    return token.promise;
  }
  function confirmed(target, model) {
    const control = modelControl();
    const current = modelValue(control);
    return Boolean(control && (current ? matches(current, model.version) : control === model.control)
      && level(effortControl()) === target);
  }
  async function prepareHigh(input = composer()) {
    if (!loaded) return false;
    if (!on()) return !active;
    if (active?.kind === "warm") await active.promise;
    if (active || !input || input !== composer()) return false;
    const startRoute = route();
    const operation = begin("high", async valid => {
      permit = null;
      const model = await select(HIGH, () => valid() && startRoute === route() && input === composer(), extraButton);
      if (!model) {
        report("Could not confirm the newest GPT at High. Message not sent.");
        return false;
      }
      restoreRequired = false;
      permit = { input, route: startRoute, model, expires: Date.now() + 1500 };
      report("");
      return true;
    });
    return Boolean(await operation);
  }
  function consumeHigh(button) {
    const input = composer();
    if (!loaded || active || button !== readySend(input)) return false;
    if (!on()) return true;
    const prepared = permit;
    permit = null;
    return Boolean(prepared && prepared.input === input && prepared.route === route()
      && Date.now() <= prepared.expires && confirmed(HIGH, prepared.model));
  }
  function clickHigh(button) {
    if (!consumeHigh(button)) return false;
    internalClick = true;
    try { button.click(); }
    finally { internalClick = false; }
    return true;
  }

  function idleForExtra(input) {
    const state = queue()?.getDispatcherLifecycle?.();
    return Boolean(input && readySend(input) && (!state || (!state.responseActive && !state.submissionPending
      && !state.queueLength && state.stateReady)));
  }
  function idleForManual(input) {
    const state = queue()?.getDispatcherLifecycle?.();
    return Boolean(readySend(input) && (!state || (!state.responseActive && !state.submissionPending && !state.queueLength)));
  }
  function attachmentSignature(input) {
    const container = form(input);
    if (!container) return "";
    const files = [...container.querySelectorAll('input[type="file"]')].flatMap(field => [...(field.files || [])])
      .map(file => [file.name, file.size, file.lastModified]);
    const chips = [...container.querySelectorAll('button[aria-label^="Remove file" i], button[aria-label^="Remove attachment" i], button[aria-label^="Remove selected text" i], [data-composer-quote], [data-testid*="file-preview" i]')]
      .map(node => [node.getAttribute("aria-label"), node.textContent]);
    return JSON.stringify([files, chips]);
  }
  function draftSnapshot(input) {
    return { input, route: route(), revision: draftRevision, text: readDraft(input), turns: userTurns(), attachments: attachmentSignature(input) };
  }
  function unchanged(snapshot) {
    return snapshot.input === composer() && snapshot.route === route() && snapshot.revision === draftRevision
      && snapshot.text === readDraft(snapshot.input) && snapshot.turns === userTurns()
      && snapshot.attachments === attachmentSignature(snapshot.input);
  }
  async function manualHigh(input) {
    const snapshot = draftSnapshot(input);
    if (!await prepareHigh(input)) return;
    if (!unchanged(snapshot) || !idleForManual(input)) {
      permit = null;
      report("The draft or conversation changed. Try Send again.");
      return;
    }
    if (!clickHigh(readySend(input))) report("High could not be reconfirmed. Nothing sent.");
  }
  async function sendExtra(input) {
    if (!extraButton || !extraAvailable || active || !idleForExtra(input)) return false;
    const snapshot = draftSnapshot(input);
    return begin("extra", async valid => {
      permit = null;
      let submitted = false;
      restoreRequired = true;
      try {
        const model = await select(EXTRA, () => valid() && unchanged(snapshot), false);
        const button = readySend(input);
        if (!model || !valid() || !unchanged(snapshot) || !idleForExtra(input) || !confirmed(EXTRA, model) || !button) {
          report("Extra High could not be confirmed. Nothing sent.");
          return false;
        }
        internalClick = true;
        try { button.click(); }
        finally { internalClick = false; }
        // The next visible user turn is acknowledgement. Never enqueue an Extra High draft.
        submitted = Boolean(await waitFor(() => userTurns() > snapshot.turns, () => context.active(), 10000));
        report(submitted ? "" : "Extra High submission was not confirmed. Check the conversation before retrying.");
        return submitted;
      } finally {
        // Even an unacknowledged or cancelled attempt must not leave Extra High armed.
        const restored = await select(HIGH, () => context.active(), extraButton);
        if (restored) restoreRequired = false;
        else report("High could not be restored. Normal sends are blocked until confirmed.");
      }
    });
  }

  function deferEnter(event, input) {
    if (loaded && !on() && !active) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!active || active.kind === "warm") void context.run(() => manualHigh(input));
    return true;
  }
  function captureClick(event) {
    if (internalClick || (loaded && !on() && !active)) return;
    const input = composer();
    const button = event.target?.closest?.("button");
    if (!button || button !== nativeSend(input)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.isTrusted && (!active || active.kind === "warm")) void context.run(() => manualHigh(input));
    else report("Waiting for confirmed High reasoning. Message not sent.");
  }
  function captureSubmit(event) {
    if (internalClick || (loaded && !on() && !active)) return;
    const input = composer();
    if (event.target !== form(input)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.isTrusted && (!active || active.kind === "warm")) void context.run(() => manualHigh(input));
  }

  function mount() {
    mountScheduled = false;
    if (!context.active()) return;
    const input = composer();
    const anchor = action(input);
    let button = document.getElementById(BUTTON_ID);
    if (!extraButton || !anchor?.parentElement) button?.remove();
    else {
      if (!button) {
        button = document.createElement("button");
        button.id = BUTTON_ID;
        button.type = "button";
        button.setAttribute("aria-label", "Send once with Extra High");
        button.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V6m-6 6 6-6 6 6"/><path d="M19 2v4m-2-2h4"/></svg>';
        button.addEventListener("click", () => void context.run(() => sendExtra(composer())));
      }
      if (button.parentElement !== anchor.parentElement || button.nextElementSibling !== anchor) anchor.before(button);
      const disabled = Boolean(active || !extraAvailable || !idleForExtra(input));
      if (button.disabled !== disabled) button.disabled = disabled;
      const title = !extraAvailable ? "Extra High is not confirmed available" : "Send once with Extra High (returns to High afterward)";
      if (button.title !== title) button.title = title;
    }
    let notice = document.getElementById("ghrc-reasoning-status");
    if (!status || !form(input)) notice?.remove();
    else {
      if (!notice) {
        notice = document.createElement("div");
        notice.id = "ghrc-reasoning-status";
        notice.setAttribute("role", "status");
        form(input).before(notice);
      }
      if (notice.textContent !== status) notice.textContent = status;
    }
    const control = modelControl();
    if (loaded && on() && !active && control && (warmControl !== control || warmRoute !== route())) {
      warmControl = control;
      warmRoute = route();
      void begin("warm", async valid => {
        const start = route();
        const selected = await select(HIGH, () => valid() && route() === start, extraButton);
        if (selected) { restoreRequired = false; report(""); }
        return Boolean(selected);
      });
    }
  }
  function scheduleMount() {
    if (!mountScheduled && context.active()) {
      mountScheduled = true;
      requestAnimationFrame(mount);
    }
  }
  function apply(settings) {
    epoch++;
    permit = null;
    warmControl = null;
    extraAvailable = false;
    force = Boolean(settings[SETTING]);
    extraButton = Boolean(settings[EXTRA_SETTING]);
    loaded = true;
    report("");
    scheduleMount();
  }
  const style = document.createElement("style");
  style.textContent = '[data-ghrc-thinking-menu] { opacity: 0 !important; pointer-events: none !important; }'
    + '#ghrc-extra-high-send-button { display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; flex:none; border-radius:50%; border:1px solid var(--border-medium, currentColor); color:var(--text-primary, currentColor); background:transparent; cursor:pointer; }'
    + '#ghrc-extra-high-send-button:disabled { opacity:.35; cursor:default; } #ghrc-extra-high-send-button:not(:disabled):hover { background:var(--surface-hover, rgba(127,127,127,.15)); }'
    + '#ghrc-reasoning-status { font-size:12px; color:var(--text-secondary, currentColor); margin:4px 12px; }';
  (document.documentElement || document).append(style);
  globalThis.__ghrcReasoningPolicy = { prepareHigh, clickHigh, deferEnter, isSelecting: () => Boolean(active) };
  window.addEventListener("click", captureClick, true);
  window.addEventListener("submit", captureSubmit, true);
  document.addEventListener("input", event => {
    if (event.target === composer() || form(composer())?.contains(event.target)) draftRevision++;
    scheduleMount();
  }, true);
  window.addEventListener("ghrc:route-change", scheduleMount);
  const observer = new MutationObserver(() => {
    if (menuSession) ownedMenus(menuSession);
    scheduleMount();
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["aria-expanded", "aria-disabled", "aria-selected", "aria-checked", "aria-valuenow", "data-selected-reasoning-effort", "disabled", "hidden", "data-state"] });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes[SETTING] || changes[EXTRA_SETTING])) {
      apply({ [SETTING]: changes[SETTING] ? changes[SETTING].newValue : force,
        [EXTRA_SETTING]: changes[EXTRA_SETTING] ? changes[EXTRA_SETTING].newValue : extraButton });
    }
  });
  context.onStop(() => {
    epoch++;
    observer.disconnect();
    window.removeEventListener("click", captureClick, true);
    window.removeEventListener("submit", captureSubmit, true);
    document.getElementById(BUTTON_ID)?.remove();
    document.getElementById("ghrc-reasoning-status")?.remove();
    for (const menu of menuSession?.owned || []) {
      key(menu, "Escape");
      menu.removeAttribute(AUTO_MENU);
    }
    style.remove();
    delete globalThis.__ghrcReasoningPolicy;
  });
  void context.run(async () => apply(await chrome.storage.local.get({ [SETTING]: false, [EXTRA_SETTING]: false })));
})();
