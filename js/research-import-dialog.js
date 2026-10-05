(() => {
  function styles(doc) {
    if (doc.getElementById('ghrc-folder-style')) return;
    const style = doc.createElement('style');
    style.id = 'ghrc-folder-style';
    style.textContent = '.ghrc-report-import{position:fixed;inset:0;margin:auto;max-height:calc(100dvh - 32px);overflow:auto}.ghrc-report-import .ghrc-folder-browser{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}.ghrc-folder-list,.ghrc-folder-preview{max-height:220px;overflow:auto;border:1px solid #8886;border-radius:6px;padding:6px;min-width:0}.ghrc-folder-list button{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;overflow-wrap:anywhere}.ghrc-folder-list button:hover,.ghrc-folder-list button:focus-visible{background:#8883}.ghrc-folder-preview{font-size:12px;line-height:1.8;overflow-wrap:anywhere}.ghrc-folder-preview strong{display:block}.ghrc-report-import .ghrc-folder-actions{display:flex;justify-content:space-between;gap:8px;margin:8px 0}.ghrc-report-status a,.ghrc-research-launch-status a,#ghrc-research-run-status a{pointer-events:auto;display:block;text-decoration:underline;overflow-wrap:anywhere}';
    (doc.head || doc.documentElement).append(style);
  }
  globalThis.__ghrcResearchImportStatus = (node, result) => {
    styles(node.ownerDocument);
    const text = `${result.unchanged ? 'Already up to date' : 'Imported'}: ${result.repository} / ${result.path} (${result.branch}).`;
    if (node.dataset.importConfirmation === text + (result.url || '')
      && node.textContent === text + (result.url || '')) return;
    node.dataset.importConfirmation = text + (result.url || '');
    node.textContent = text;
    if (typeof result.url === 'string') {
      try {
        const url = new URL(result.url);
        if (url.protocol !== 'https:') return;
        const link = node.ownerDocument.createElement('a');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = url.href;
        link.addEventListener('click', async event => {
          const view = node.ownerDocument.defaultView;
          if (!event.isTrusted || !view || view === view.top) return;
          event.preventDefault();
          try {
            const opened = await chrome.runtime.sendMessage({ type: 'open-research-link', url: url.href });
            if (!opened?.ok) throw new Error(opened?.error || 'Could not open imported report.');
          } catch (error) { link.title = error.message; }
        });
        node.append(link);
      } catch { /* A malformed bridge URL cannot become a clickable link. */ }
    }
  };
  globalThis.__ghrcChooseResearchCategory = (doc, connection, launch = false) => new Promise(resolve => {
    styles(doc);
    const dialog = doc.createElement('dialog');
    dialog.className = 'ghrc-report-import';
    dialog.innerHTML = '<form method="dialog"><h2></h2><p class="destination"></p><label>Category <input name="category" placeholder="Choose or create a category" maxlength="240" autocomplete="off"></label><div class="ghrc-folder-actions"><button type="button" class="up">Up one folder</button><button type="button" class="root">Repository root</button></div><div class="ghrc-folder-browser"><nav class="ghrc-folder-list" aria-label="Repository folders"></nav><div class="ghrc-folder-preview" aria-label="Folder contents" aria-live="polite"></div></div><p>Hover or focus a folder to preview its contents. Click to select and browse it. Use / to create nested categories.</p><div><button value="cancel">Cancel</button><button value="import"></button></div></form>';
    dialog.querySelector('h2').textContent = launch ? 'Research and import' : 'Import Deep Research';
    dialog.querySelector('[value="import"]').textContent = launch ? 'Start research' : 'Import report';
    dialog.querySelector('.destination').textContent = `${connection.repository} (${connection.branch})`;
    const input = dialog.querySelector('input');
    const list = dialog.querySelector('.ghrc-folder-list');
    const preview = dialog.querySelector('.ghrc-folder-preview');
    const categories = new Set(connection.categories || []);
    // Include implicit parents so older bridges and nested-only lists still browse correctly.
    for (const path of [...categories]) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) categories.add(parts.slice(0, i).join('/'));
    }
    const children = path => [...categories].filter(item => item.startsWith(path ? path + '/' : '') && !item.slice(path ? path.length + 1 : 0).includes('/')).sort((a, b) => a.localeCompare(b));
    function showContents(path) {
      preview.replaceChildren();
      const title = doc.createElement('strong');
      title.textContent = path || 'Repository root';
      preview.append(title);
      const entries = [...children(path).map(item => '📁 ' + item.split('/').pop()), ...(connection.contents?.[path] || []).map(name => '📄 ' + name)];
      for (const name of entries) {
        const entry = doc.createElement('div');
        entry.textContent = name;
        preview.append(entry);
      }
      if (!entries.length) preview.append(connection.contents ? 'Empty folder' : 'File preview requires an updated repository bridge.');
    }
    let current = '';
    function browse(path) {
      current = path;
      input.value = path;
      list.replaceChildren();
      dialog.querySelector('.up').disabled = !path;
      for (const folder of children(path)) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.textContent = '📁 ' + folder.split('/').pop();
        button.addEventListener('mouseenter', () => showContents(folder));
        button.addEventListener('focus', () => showContents(folder));
        button.addEventListener('click', () => browse(folder));
        list.append(button);
      }
      if (!list.children.length) list.textContent = 'No subfolders';
      showContents(path);
    }
    dialog.querySelector('.up').addEventListener('click', () => browse(current.split('/').slice(0, -1).join('/')));
    dialog.querySelector('.root').addEventListener('click', () => browse(''));
    input.addEventListener('input', () => { if (!input.value || categories.has(input.value)) browse(input.value); });
    browse('');
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'import' ? input.value.trim() : null);
      dialog.remove();
    }, { once: true });
    doc.body.append(dialog);
    dialog.showModal();
  });
})();
