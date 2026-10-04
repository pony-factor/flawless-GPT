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
  const USAGE_ATTRIBUTE = 'data-ghrc-deep-research-usage';
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

  function serverText() {
    if (!serverQuota) return null;
    const stale = Date.now() - serverQuota.observedAt > 10 * 60_000
      || (serverQuota.resetAt !== null && serverQuota.resetAt <= Date.now());
    const count = stale ? `${serverQuota.remaining} last checked · Refresh allowance`
      : `${serverQuota.remaining} reports remaining`;
    const remainingMs = serverQuota.resetAt === null ? null : serverQuota.resetAt - Date.now();
    let reset = 'Reset unknown';
    if (remainingMs !== null) {
      if (remainingMs <= 0) reset = 'Reset due';
      else {
        const hours = remainingMs >= 60 * 60_000;
        const value = Math.max(1, Math.round(remainingMs / (hours ? 60 * 60_000 : 60_000)));
        const unit = hours ? 'hour' : 'minute';
        reset = `Resets in ${value} ${unit}${value === 1 ? '' : 's'}`;
      }
    }
    return `Deep Research · ${count} · ${reset}`;
  }

  function visible(element) {
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  }

  function readAllowance() {
    // Read only native controls, never messages or report contents.
    const controls = document.querySelectorAll('[role="menuitem"], [role="option"], button');
    for (const control of controls) {
      if (control.closest(`#${ID}`) || !visible(control)) continue;
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

  function update() {
    pending = false;
    if (!context.active()) return;
    readServerQuota();
    readAllowance();
    const prompt = [...document.querySelectorAll('#prompt-textarea, [data-composer-markdown][contenteditable="true"]')].find(visible);
    const composer = prompt?.closest('form, [data-type="unified-composer"]');
    if (!composer?.parentElement) return;
    let widget = document.getElementById(ID);
    if (!widget) {
      widget = document.createElement('button');
      widget.id = ID;
      widget.type = 'button';
      widget.addEventListener('click', checkAllowance);
    }
    if (widget.nextElementSibling !== composer) composer.before(widget);
    // An old observation is not a live balance; require another native check.
    const fresh = Date.now() - observedAt < 5 * 60_000;
    const count = fresh && allowance.remaining !== null
      ? `${allowance.full ? 'Full reports' : 'Reports (type unspecified)'}: ${allowance.remaining} remaining`
      : 'Check allowance';
    const reset = fresh && allowance.reset ? allowance.reset : 'Reset unknown';
    const text = serverText() || `Deep Research · ${count} · ${reset}`;
    if (widget.textContent !== text) widget.textContent = text;
    widget.title = serverQuota
      ? 'ChatGPT’s Deep Research report allowance. Click to refresh. Lightweight allowances are excluded. Reset countdown uses hours, then minutes during the final hour.'
      : 'Waiting for ChatGPT’s research allowance. Click to check again or open the native tools menu.';
  }

  function schedule() {
    if (pending || !context.active()) return;
    pending = true;
    requestAnimationFrame(update);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-describedby', 'aria-label', 'data-state', USAGE_ATTRIBUTE] });
  document.addEventListener('pointerover', schedule);
  document.addEventListener('focusin', schedule);
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible' && serverQuota && Date.now() - serverQuota.observedAt > 5 * 60_000) {
      window.dispatchEvent(new Event('ghrc-refresh-deep-research-usage'));
    }
    schedule();
  }, 30_000);
  context.onStop(() => {
    observer.disconnect();
    clearInterval(timer);
    document.removeEventListener('pointerover', schedule);
    document.removeEventListener('focusin', schedule);
    document.getElementById(ID)?.remove();
  });
  schedule();
})();
