(() => {
  const CONNECTION_KEY = 'researchPublisherConnection';
  const checkbox = document.getElementById('research-publisher-enabled');
  const controls = document.getElementById('research-publisher-controls');
  const launch = document.getElementById('check-research-publisher');
  const status = document.getElementById('research-publisher-status');
  let busy = false;
  let checkGeneration = 0;

  const render = (enabled) => {
    checkbox.checked = enabled;
    controls.hidden = !enabled;
    launch.disabled = !enabled || busy;
  };

  const renderConnection = (connection) => {
    if (!checkbox.checked) {
      status.textContent = '';
      return;
    }
    status.textContent = connection?.ok
      ? `Linked to ${connection.repository} (${connection.branch}). Add to repo is available on completed reports.`
      : 'Repository connection is not confirmed. Use Check connection before publishing.';
  };

  async function checkConnection() {
    const generation = ++checkGeneration;
    busy = true;
    launch.disabled = true;
    status.textContent = 'Checking repository connection…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'research-publisher-status' });
      if (generation !== checkGeneration || !checkbox.checked) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not connect to the repository.');
      renderConnection({ ok: true, repository: result.repository, branch: result.branch });
    } catch (error) {
      if (generation === checkGeneration && checkbox.checked) {
        status.textContent = error?.message || 'Connection unavailable. Reload the extension and try again.';
      }
    } finally {
      if (generation === checkGeneration) {
        busy = false;
        launch.disabled = !checkbox.checked;
      }
    }
  }

  checkbox.disabled = true;
  chrome.storage.local.get({
    researchPublisherEnabled: false,
    [CONNECTION_KEY]: null,
  }).then((settings) => {
    render(Boolean(settings.researchPublisherEnabled));
    renderConnection(settings[CONNECTION_KEY]);
    checkbox.disabled = false;
  }).catch(() => {
    status.textContent = 'Could not load publisher settings. Reopen settings to retry.';
  });

  checkbox.addEventListener('change', async () => {
    const enabled = checkbox.checked;
    checkbox.disabled = true;
    checkGeneration += 1;
    busy = false;
    try {
      await chrome.storage.local.set({ researchPublisherEnabled: enabled });
      render(enabled);
      if (enabled) await checkConnection();
      else status.textContent = '';
    } catch {
      render(!enabled);
      status.textContent = 'Could not save publisher settings. Try again.';
    } finally { checkbox.disabled = false; }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.researchPublisherEnabled) {
      render(Boolean(changes.researchPublisherEnabled.newValue));
    }
    if (changes[CONNECTION_KEY] && !busy) {
      renderConnection(changes[CONNECTION_KEY].newValue);
    }
  });

  launch.addEventListener('click', () => checkConnection());
})();
