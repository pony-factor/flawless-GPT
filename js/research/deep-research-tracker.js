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

  // ChatGPT doesn't always expose a quota maximum. Accept an explicit user
  // preference or a server-provided total; otherwise approximate common
  // 25/250 report allowances from the observed remaining count.
  function usagePieTotal(remaining, reportedTotal = null, preferredTotal = null) {
    if (!Number.isSafeInteger(remaining) || remaining < 0) return null;
    if (Number.isSafeInteger(preferredTotal) && preferredTotal > 0)
      return remaining <= preferredTotal ? preferredTotal : null;
    if (Number.isSafeInteger(reportedTotal) && reportedTotal > 0)
      return remaining <= reportedTotal ? reportedTotal : null;
    if (remaining <= 25) return 25;
    if (remaining <= 250) return 250;
    return null;
  }

  function usagePiePercent(remaining, total) {
    if (!Number.isSafeInteger(remaining) || remaining < 0 ||
        !Number.isSafeInteger(total) || total <= 0 || remaining > total) return null;
    return Math.round(remaining * 100 / total);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseAllowance, usagePieTotal, usagePiePercent };
    return;
  }
  const context = globalThis.__ghrcExtensionContext;
  if (!context?.active()) return;
  const ID = 'ghrc-deep-research-tracker';
  const DASHBOARD_ID = 'ghrc-deep-research-dashboard';
  const COMPOSER_ID = `${ID}-composer`;
  const USAGE_ATTRIBUTE = 'data-ghrc-deep-research-usage';
  const DAY_MS = 24 * 60 * 60_000;
  const SETTINGS_DEFAULTS = Object.freeze({
    showDeepResearchTracker: true,
    showDeepResearchHomepage: true,
    showDeepResearchComposer: true,
    showDeepResearchHomepageCount: true,
    showDeepResearchHomepageReset: true,
    showDeepResearchComposerCount: true,
    showDeepResearchComposerReset: true,
    showDeepResearchUsagePie: false,
    deepResearchUsagePieTotal: null,
    deepResearchHomepageVisibility: 'near-reset',
    deepResearchHomepageWindowDays: 5,
  });
  let preferences = { ...SETTINGS_DEFAULTS };
  let enabled = !globalThis.chrome?.storage?.local;
  let allowance = { remaining: null, full: false, reset: '' };
  let observedAt = 0;
  let pending = false;
  let serverQuota = null;

  function readServerQuota() {
    try {
      const value = JSON.parse(document.documentElement.getAttribute(USAGE_ATTRIBUTE));
      serverQuota = value && Number.isSafeInteger(value.remaining) && value.remaining >= 0
        && Number.isFinite(value.observedAt) && value.observedAt <= Date.now()
        && (value.resetAt === null || Number.isFinite(value.resetAt)) ? value : null;
    } catch { serverQuota = null; }
  }

  function withinResetWindow() {
    if (!serverQuota || serverQuota.resetAt === null) return false;
    const remainingMs = serverQuota.resetAt - Date.now();
    return remainingMs >= 0 && remainingMs <= preferences.deepResearchHomepageWindowDays * DAY_MS;
  }

  function dashboardVisible() {
    return preferences.deepResearchHomepageVisibility === 'always' || withinResetWindow();
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
      const pie = document.createElement('span');
      pie.className = 'ghrc-research-usage-pie';
      pie.setAttribute('aria-hidden', 'true');
      pie.hidden = true;
      const label = document.createElement('span');
      label.className = 'ghrc-research-allowance';
      widget.append(icon, pie, label);
      widget.addEventListener('click', checkAllowance);
    }
    // An old observation is not a live balance; require another native check.
    const fresh = Date.now() - observedAt < 5 * 60_000;
    const count = fresh && allowance.remaining !== null
      ? `${allowance.remaining} left`
      : 'Check allowance';
    const reset = fresh && allowance.reset ? allowance.reset : 'Reset unknown';
    const homepage = id === ID;
    const nearReset = homepage && withinResetWindow();
    if (widget.classList.contains('ghrc-research-near-reset') !== nearReset) {
      widget.classList.toggle('ghrc-research-near-reset', nearReset);
    }
    const includeCount = homepage
      ? preferences.showDeepResearchHomepageCount !== false
      : preferences.showDeepResearchComposerCount !== false;
    const includeReset = homepage
      ? preferences.showDeepResearchHomepageReset !== false
      : preferences.showDeepResearchComposerReset !== false;
    const text = serverText(includeCount, includeReset)
      || ['Deep Research', ...(includeCount ? [count] : []), ...(includeReset ? [reset] : [])].join(' · ');
    const pie = widget.querySelector('.ghrc-research-usage-pie');
    const freshServer = serverQuota && Date.now() - serverQuota.observedAt <= 10 * 60_000
      && (serverQuota.resetAt === null || serverQuota.resetAt > Date.now());
    const pieRemaining = serverQuota ? (freshServer ? serverQuota.remaining : null)
      : (fresh ? allowance.remaining : null);
    const preferredTotal = preferences.deepResearchUsagePieTotal;
    const reportedTotal = freshServer ? serverQuota.total : null;
    const total = usagePieTotal(pieRemaining, reportedTotal, preferredTotal);
    const percent = preferences.showDeepResearchUsagePie && includeCount
      ? usagePiePercent(pieRemaining, total) : null;
    const showPie = percent !== null;
    if (pie.hidden !== !showPie) pie.hidden = !showPie;
    if (showPie) {
      // The existing Chat bar color preferences update root variables live;
      // CSS variable resolution handles them without remounting the widget.
      const regular = 'var(--ghrc-research-pie-color, var(--ghrc-composer-toolbar-icon, var(--ghrc-composer-text, currentColor)))';
      const warning = 'var(--ghrc-research-pie-accent, var(--ghrc-composer-send-hover, var(--ghrc-composer-focus-ring, var(--theme-submit-btn-bg, #ffb900))))';
      const foreground = percent <= 10 ? warning : regular;
      const degrees = (100 - percent) * 3.6;
      // Retain Sweetiebot's 12 o'clock origin and muted consumed segment.
      const background = `conic-gradient(from 0deg, color-mix(in srgb, ${regular} 20%, transparent) 0 ${degrees}deg, ${foreground} ${degrees}deg 360deg)`;
      if (pie.dataset.pieBackground !== background) {
        pie.style.background = background;
        pie.dataset.pieBackground = background;
      }
    }
    // Keep the exact remaining count in the button's accessible label. Only
    // replace the visible number when a valid scale can be determined.
    const visibleParts = text.split(' · ').slice(1);
    if (showPie) visibleParts.shift();
    const visibleText = visibleParts.join(' · ');
    const label = widget.querySelector('.ghrc-research-allowance');
    if (label.textContent !== visibleText) label.textContent = visibleText;
    if (widget.getAttribute('aria-label') !== text) widget.setAttribute('aria-label', text);
    const autoEstimate = showPie && preferredTotal == null && reportedTotal == null;
    widget.title = showPie
      ? `Deep Research: ${pieRemaining} of ${total} full reports remaining${autoEstimate ? ' (estimated allowance)' : ''}. Click to refresh. Lightweight allowances are excluded.`
      : 'Deep Research allowance. Click to refresh or open the native tools menu. Lightweight allowances are excluded.';
    return widget;
  }

  function update() {
    pending = false;
    if (!context.active()) return;
    readServerQuota();
    readAllowance();
    const repositories = document.getElementById('github-repositories-for-chatgpt');
    const footer = repositories?.querySelector('.ghrc-dashboard-footer');
    const homepageRowVisible = enabled && preferences.showDeepResearchHomepage !== false
      && footer && visible(repositories) && dashboardVisible();
    if (homepageRowVisible) {
      let row = document.getElementById(DASHBOARD_ID);
      if (!row) {
        row = document.createElement('div');
        row.id = DASHBOARD_ID;
        row.append(renderWidget(ID));
      } else renderWidget(ID);
      let actions = footer.querySelector('.ghrc-2048-footer-left');
      if (!actions) {
        actions = document.createElement('div');
        actions.className = 'ghrc-2048-footer-left';
        footer.append(actions);
      }
      if (row.parentElement !== actions || actions.firstElementChild !== row) actions.prepend(row);
    } else document.getElementById(DASHBOARD_ID)?.remove();

    const prompts = [...document.querySelectorAll('#prompt-textarea, [data-composer-markdown][contenteditable="true"]')].filter(visible);
    const researchPrompt = prompts.find(prompt => prompt.querySelector([
      '[data-prompt-link-href="app://connector_openai_deep_research"]',
      '[data-prompt-link-href="app://connector_openai_deep_research_work"]',
      '[data-prompt-link-label="$deep-research"]',
    ].join(',')));
    const composer = researchPrompt?.closest('form, [data-type="unified-composer"]');
    // Avoid a duplicate composer counter when the homepage row shows at least
    // one allowance field. Otherwise the composer remains a useful fallback.
    const homepageShowsAllowance = homepageRowVisible
      && (preferences.showDeepResearchHomepageCount !== false
        || preferences.showDeepResearchHomepageReset !== false);
    if (enabled && preferences.showDeepResearchComposer !== false && composer?.parentElement
      && !homepageShowsAllowance) {
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
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-describedby', 'aria-label', 'data-state', 'data-prompt-link-href', 'data-prompt-link-label', 'data-ghrc-hide-repository-dashboard', 'style', USAGE_ATTRIBUTE] });
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
    const selectedTotal = preferences.deepResearchUsagePieTotal;
    preferences.deepResearchUsagePieTotal =
      Number.isSafeInteger(selectedTotal) && selectedTotal > 0 && selectedTotal <= 10000
        ? selectedTotal : null;
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
  });
  schedule();
})();
