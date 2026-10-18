(() => {
  function parseAllowance(text) {
    const lines = String(text || '').split(/[\n.!?]|(?=\b\d+\s+(?:(?:full|standard|lightweight|mini)\s+)?(?:reports?|requests?|uses?|tasks?)\b)/i).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    let remaining = null;
    let full = false;
    let reset = '';
    for (const line of lines) {
      const resetMatch = line.match(/\b(?:resets?|renews?|refreshes?)\b.*$/i);
      if (resetMatch) reset = resetMatch[0];
      if (/\b(?:lightweight|mini)\b/i.test(line)) continue;
      const match = line.match(/\b(\d+)\s+(?:(?:full|standard|deep research)\s+)?(?:reports?|requests?|uses?|tasks?)?\s*(?:remaining|left|available)\b/i)
        || line.match(/\b(?:remaining|left|available)\s*:?\s*(\d+)\b/i);
      if (!match) continue;
      const explicitlyFull = /\b(?:full|standard)\b/i.test(line);
      if (remaining === null || explicitlyFull) {
        remaining = Number(match[1]);
        full = explicitlyFull;
      }
    }
    return { remaining, full, reset };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseAllowance };
    return;
  }
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const ID = 'ghrc-deep-research-tracker';
  const DASHBOARD_ID = 'ghrc-deep-research-dashboard';
  const COMPOSER_ID = `${ID}-composer`;
  const HOME_LAUNCHER_ID = 'ghrc-research-home-launcher';
  const RESEARCH_MENTION = '[app-mention-path="app://connector_openai_deep_research"], [app-mention-path="app://connector_openai_deep_research_work"]';
  const USAGE_ATTRIBUTE = 'data-ghrc-deep-research-usage';
  const DAY_MS = 24 * 60 * 60_000;
  const SETTINGS_DEFAULTS = Object.freeze({
    showResearchHomepageLauncher: true,
    showDeepResearchTracker: true,
    showDeepResearchHomepage: true,
    showDeepResearchComposer: true,
    showDeepResearchHomepageCount: true,
    showDeepResearchHomepageReset: true,
    showDeepResearchComposerCount: true,
    showDeepResearchComposerReset: true,
    deepResearchHomepageVisibility: 'near-reset',
    deepResearchHomepageWindowDays: 5,
  });
  let preferences = { ...SETTINGS_DEFAULTS };
  let enabled = !globalThis.chrome?.storage?.local;
  let allowance = { remaining: null, full: false, reset: '' };
  let observedAt = 0;
  let pending = false;
  let serverQuota = null;
  let launchingResearch = false;

  function readServerQuota() {
    try {
      const value = JSON.parse(document.documentElement.getAttribute(USAGE_ATTRIBUTE));
      serverQuota = value && Number.isSafeInteger(value.remaining) && value.remaining >= 0
        && Number.isFinite(value.observedAt) && value.observedAt <= Date.now()
        && (value.resetAt === null || Number.isFinite(value.resetAt)) ? value : null;
    } catch { serverQuota = null; }
  }

  function dashboardVisible() {
    if (preferences.deepResearchHomepageVisibility === 'always') return true;
    if (!serverQuota || serverQuota.resetAt === null) return false;
    const remainingMs = serverQuota.resetAt - Date.now();
    return remainingMs >= 0 && remainingMs <= preferences.deepResearchHomepageWindowDays * DAY_MS;
  }

  function serverText(includeCount, includeReset) {
    if (!serverQuota) return null;
    const stale = Date.now() - serverQuota.observedAt > 10 * 60_000
      || (serverQuota.resetAt !== null && serverQuota.resetAt <= Date.now());
    const count = stale ? `${serverQuota.remaining} last checked · Refresh allowance`
      : `${serverQuota.remaining} left`;
    const remainingMs = serverQuota.resetAt === null ? null : serverQuota.resetAt - Date.now();
    let reset = 'reset unknown';
    if (remainingMs !== null) {
      if (remainingMs <= 0) reset = 'reset due';
      else {
        const days = remainingMs > 36 * 60 * 60_000;
        const hours = remainingMs >= 60 * 60_000;
        const divisor = days ? 24 * 60 * 60_000 : hours ? 60 * 60_000 : 60_000;
        const value = Math.max(1, Math.round(remainingMs / divisor));
        const unit = days ? 'd' : hours ? 'h' : 'm';
        reset = `resets ${value}${unit}`;
      }
    }
    return ['Deep Research', ...(includeCount ? [count] : []), ...(includeReset ? [reset] : [])].join(' · ');
  }

  function visible(element) {
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  }

  function readAllowance() {
    // Read only native controls, never messages or report contents.
    const controls = document.querySelectorAll('[role="menuitem"], [role="option"], button');
    for (const control of controls) {
      if (control.closest('.ghrc-deep-research-tracker') || !visible(control)) continue;
      const label = `${control.innerText || ''} ${control.getAttribute('aria-label') || ''}`;
      if (!/\bdeep research\b/i.test(label)) continue;
      const texts = [label];
      for (const id of (control.getAttribute('aria-describedby') || '').split(/\s+/)) {
        const description = document.getElementById(id);
        if (description) texts.push(description.innerText);
      }
      // Tooltips often live in portals and omit the feature's name.
      // Only associate them while this specific research control is hovered/focused.
      if (control.matches(':hover') || control.contains(document.activeElement)) {
        for (const tooltip of document.querySelectorAll('[role="tooltip"]')) {
          if (visible(tooltip)) texts.push(tooltip.innerText);
        }
      }
      const next = parseAllowance(texts.join('\n'));
      if (next.remaining !== null || next.reset) {
        allowance = next;
        observedAt = Date.now();
      }
    }
  }

  function checkAllowance() {
    window.dispatchEvent(new Event('ghrc-refresh-deep-research-usage'));
    if (serverQuota) return;
    const research = [...document.querySelectorAll('[role="menuitem"], [role="option"], button[data-list-navigation-item]')]
      .find(element => visible(element) && /\bdeep research\b/i.test(element.innerText));
    if (research) {
      research.focus();
      research.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      research.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
      schedule();
      return;
    }
    const more = [...document.querySelectorAll('button[aria-label="Add files and more"]')].find(visible);
    more?.click();
    // No task is selected or submitted. The user can hover the native research entry.
  }


  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function prefillResearchMention() {
    const input = [...document.querySelectorAll('#prompt-textarea, [data-composer-markdown][contenteditable="true"]')]
      .find(visible);
    if (!input || !input.isContentEditable) throw new Error('The ChatGPT input is not ready.');
    const scope = input.closest('form, [data-type="unified-composer"]') || input;
    if (scope.querySelector(RESEARCH_MENTION)) { input.focus(); return; }

    // Insert an actual app mention at the beginning; never erase existing text.
    input.focus();
    const selection = window.getSelection();
    if (!selection) throw new Error('Could not select the chat input.');
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'Deep research ');
    transfer.setData('text/html', '<p><span app-mention-name="deep-research" app-mention-display-name="Deep research" app-mention-path="app://connector_openai_deep_research" app-mention-icon="/images/ecosystem/apps/deep_research_app/icon.png" data-prompt-link-href="app://connector_openai_deep_research" data-prompt-link-label="$deep-research" contenteditable="false">Deep research</span> </p>');
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    for (let i = 0; i < 30; i++) {
      if (scope.querySelector(RESEARCH_MENTION)) {
        (document.querySelector('#prompt-textarea, [data-composer-markdown][contenteditable="true"]') || input).focus();
        return;
      }
      await pause(100);
    }
    throw new Error('ChatGPT did not accept the Deep Research plugin.');
  }

  async function launchResearchWithSpellcheck() {
    if (launchingResearch || location.pathname !== '/') return;
    launchingResearch = true;
    const homeLauncher = document.getElementById(HOME_LAUNCHER_ID);
    const status = homeLauncher?.querySelector('.ghrc-research-home-status');
    if (status) status.textContent = 'Preparing Deep Research…';
    try {
      await prefillResearchMention();
      if (status) status.textContent = 'Opening Spellcheck Only…';
      const settings = await chrome.storage.local.get({ openExternalLinksInSplitViewOnLeft: false });
      const result = await chrome.runtime.sendMessage({
        type: 'open-research-spellcheck-split',
        onLeft: settings.openExternalLinksInSplitViewOnLeft === true,
      });
      if (!result?.ok) throw new Error(result?.error || 'Could not open Spellcheck Only.');
      if (status) status.textContent = result.split
        ? '' : 'Split view unavailable; Spellcheck Only opened in a separate tab.';
    } catch (error) {
      if (status) status.textContent = error?.message || 'Could not prepare Deep Research.';
    } finally {
      launchingResearch = false;
    }
  }

  function renderHomepageLauncher(composer) {
    let wrapper = document.getElementById(HOME_LAUNCHER_ID);
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = HOME_LAUNCHER_ID;
      const button = document.createElement('button');
      button.type = 'button';
      button.title = 'Prepare Deep Research and open Spellcheck Only in split view';
      button.setAttribute('aria-label', 'Prepare Deep Research with Spellcheck Only');
      const icon = document.createElement('img');
      icon.src = chrome.runtime.getURL('artwork/research-telescope.png');
      icon.alt = '';
      icon.setAttribute('aria-hidden', 'true');
      button.append(icon);
      button.addEventListener('click', () => { void context.run(launchResearchWithSpellcheck); });
      const status = document.createElement('span');
      status.className = 'ghrc-research-home-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      wrapper.append(button, status);
    }
    if (wrapper.nextElementSibling !== composer) composer.before(wrapper);
  }

  function renderWidget(id) {
    let widget = document.getElementById(id);
    if (!widget) {
      widget = document.createElement('button');
      widget.id = id;
      widget.className = 'ghrc-deep-research-tracker';
      widget.type = 'button';
      const icon = document.createElement('img');
      icon.className = 'ghrc-research-telescope';
      icon.src = globalThis.chrome?.runtime?.getURL?.('artwork/research-telescope.png') || 'artwork/research-telescope.png';
      icon.alt = '';
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'ghrc-research-allowance';
      widget.append(icon, label);
      widget.addEventListener('click', () => {
        if (id === ID && location.pathname === '/' && preferences.showResearchHomepageLauncher !== false) {
          void context.run(launchResearchWithSpellcheck);
        } else checkAllowance();
      });
    }
    // An old observation is not a live balance; require another native check.
    const fresh = Date.now() - observedAt < 5 * 60_000;
    const count = fresh && allowance.remaining !== null
      ? `${allowance.remaining} left`
      : 'Check allowance';
    const reset = fresh && allowance.reset ? allowance.reset : 'Reset unknown';
    const homepage = id === ID;
    const includeCount = homepage
      ? preferences.showDeepResearchHomepageCount !== false
      : preferences.showDeepResearchComposerCount !== false;
    const includeReset = homepage
      ? preferences.showDeepResearchHomepageReset !== false
      : preferences.showDeepResearchComposerReset !== false;
    const text = serverText(includeCount, includeReset)
      || ['Deep Research', ...(includeCount ? [count] : []), ...(includeReset ? [reset] : [])].join(' · ');
    const label = widget.querySelector('.ghrc-research-allowance');
    const visibleText = text === 'Deep Research' ? '' : text.replace(/^Deep Research · /, '');
    if (label.textContent !== visibleText) label.textContent = visibleText;
    if (widget.getAttribute('aria-label') !== text) widget.setAttribute('aria-label', text);
    widget.title = homepage && location.pathname === '/' && preferences.showResearchHomepageLauncher !== false
      ? 'Prepare Deep Research and open Spellcheck Only in split view'
      : 'Deep Research allowance. Click to refresh or open the native tools menu. Lightweight allowances are excluded.';
    return widget;
  }

  function update() {
    pending = false;
    if (!context.active()) return;
    readServerQuota();
    readAllowance();
    const homeComposer = [...document.querySelectorAll('#prompt-textarea, [data-composer-markdown][contenteditable="true"]')]
      .find(visible)?.closest('form, [data-type="unified-composer"]');
    if (preferences.showResearchHomepageLauncher !== false && location.pathname === '/' && homeComposer?.parentElement) {
      renderHomepageLauncher(homeComposer);
    } else document.getElementById(HOME_LAUNCHER_ID)?.remove();

    const repositories = document.getElementById('github-repositories-for-chatgpt');
    if (enabled && preferences.showDeepResearchHomepage !== false && repositories && visible(repositories) && dashboardVisible()) {
      let row = document.getElementById(DASHBOARD_ID);
      if (!row) {
        row = document.createElement('div');
        row.id = DASHBOARD_ID;
        row.append(renderWidget(ID));
      } else renderWidget(ID);
      for (const property of ['--ghrc-available-width', '--ghrc-center-offset']) {
        const value = repositories.style.getPropertyValue(property);
        if (row.style.getPropertyValue(property) === value) continue;
        if (value) row.style.setProperty(property, value);
        else row.style.removeProperty(property);
      }
      if (repositories.nextElementSibling !== row) repositories.after(row);
    } else document.getElementById(DASHBOARD_ID)?.remove();

    const prompts = [...document.querySelectorAll('#prompt-textarea, [data-composer-markdown][contenteditable="true"]')].filter(visible);
    const researchPrompt = prompts.find(prompt => prompt.querySelector([
      '[data-prompt-link-href="app://connector_openai_deep_research"]',
      '[data-prompt-link-href="app://connector_openai_deep_research_work"]',
      '[data-prompt-link-label="$deep-research"]',
    ].join(',')));
    const composer = researchPrompt?.closest('form, [data-type="unified-composer"]');
    if (enabled && preferences.showDeepResearchComposer !== false && composer?.parentElement) {
      const widget = renderWidget(COMPOSER_ID);
      if (widget.nextElementSibling !== composer) composer.before(widget);
    } else document.getElementById(COMPOSER_ID)?.remove();
  }

  function schedule() {
    if (pending || !context.active()) return;
    pending = true;
    requestAnimationFrame(update);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-describedby', 'aria-label', 'data-state', 'data-prompt-link-href', 'data-prompt-link-label', 'style', USAGE_ATTRIBUTE] });
  document.addEventListener('pointerover', schedule);
  document.addEventListener('focusin', schedule);
  window.addEventListener('resize', schedule);
  function applySettings(next) {
    preferences = { ...SETTINGS_DEFAULTS, ...next };
    if (preferences.deepResearchHomepageVisibility !== 'always') {
      preferences.deepResearchHomepageVisibility = 'near-reset';
    }
    const days = preferences.deepResearchHomepageWindowDays;
    preferences.deepResearchHomepageWindowDays =
      Number.isInteger(days) && days >= 1 && days <= 365 ? days : 5;
    enabled = preferences.showDeepResearchTracker !== false;
    schedule();
  }

  function settingsChanged(changes, area) {
    if (area !== 'local') return;
    const keys = Object.keys(SETTINGS_DEFAULTS).filter(key => changes[key]);
    if (!keys.length) return;
    const next = { ...preferences };
    for (const key of keys) next[key] = changes[key].newValue;
    applySettings(next);
  }
  globalThis.chrome?.storage?.onChanged?.addListener(settingsChanged);
  if (globalThis.chrome?.storage?.local) {
    void chrome.storage.local.get(SETTINGS_DEFAULTS).then(applySettings)
      .catch(error => context.handleError?.(error));
  }
  const timer = setInterval(() => {
    if (enabled && document.visibilityState === 'visible' && serverQuota && Date.now() - serverQuota.observedAt > 5 * 60_000) {
      window.dispatchEvent(new Event('ghrc-refresh-deep-research-usage'));
    }
    schedule();
  }, 30_000);
  context.onStop(() => {
    observer.disconnect();
    clearInterval(timer);
    document.removeEventListener('pointerover', schedule);
    document.removeEventListener('focusin', schedule);
    window.removeEventListener('resize', schedule);
    globalThis.chrome?.storage?.onChanged?.removeListener(settingsChanged);
    document.getElementById(DASHBOARD_ID)?.remove();
    document.getElementById(COMPOSER_ID)?.remove();
    document.getElementById(HOME_LAUNCHER_ID)?.remove();
  });
  schedule();
})();
