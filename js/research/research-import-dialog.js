(() => {
  function styles(doc) {
    if (doc.getElementById('ghrc-folder-style')) return;
    const style = doc.createElement('style');
    style.id = 'ghrc-folder-style';
    style.textContent = `
      .ghrc-report-import{position:fixed;inset:0;margin:auto;box-sizing:border-box;max-height:calc(100dvh - 24px);overflow:auto;font:14px/1.4 system-ui}
      .ghrc-report-import .destination{margin:0 0 16px;opacity:.7;overflow-wrap:anywhere}
      .ghrc-report-import .ghrc-folder-actions{display:flex;align-items:center;justify-content:flex-start;gap:6px;margin:12px 0 6px}
      .ghrc-report-import .ghrc-folder-actions button{padding:4px 8px;font-size:12px;border:1px solid #8884;border-radius:6px;background:transparent;color:inherit}
      .ghrc-folder-path{min-width:0;overflow-wrap:anywhere;font-size:12px}
      .ghrc-report-import .ghrc-folder-browser{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;margin:6px 0 12px}
      .ghrc-folder-list,.ghrc-folder-preview{height:140px;overflow:auto;border:1px solid #8884;border-radius:8px;padding:6px;min-width:0;box-sizing:border-box}
      .ghrc-folder-list button{display:block;width:100%;text-align:left;border:0;border-radius:4px;background:transparent;color:inherit;overflow-wrap:anywhere}
      .ghrc-report-import .ghrc-folder-list button{padding:7px 8px;font-size:13px}
      .ghrc-folder-list button:hover,.ghrc-folder-list button:focus-visible{background:#8883}
      .ghrc-folder-preview{font-size:11px;line-height:1.7;overflow-wrap:anywhere;opacity:.8}
      .ghrc-folder-preview strong{display:block;margin-bottom:4px}
      .ghrc-report-import .ghrc-folder-help{font-size:12px;margin:8px 0;opacity:.7}
      .ghrc-report-import .ghrc-folder-footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;margin:16px 0 0}
      .ghrc-report-import .ghrc-folder-footer button{border:1px solid #8885;border-radius:7px;background:transparent;color:inherit;padding:7px 10px;font-size:13px}
      .ghrc-report-import .ghrc-folder-footer .root{margin-right:auto;font-size:12px;padding:5px 8px}
      .ghrc-report-import .ghrc-folder-footer [value="import"]{background:light-dark(#222,#eee);color:light-dark(#fff,#111);border-color:transparent}
      .ghrc-report-status a,.ghrc-research-launch-status a,#ghrc-research-run-status a{pointer-events:auto;display:block;text-decoration:underline;overflow-wrap:anywhere}
    `;
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
    dialog.innerHTML = '<form method="dialog"><h2></h2><p class="destination"></p><label>Category <input name="category" placeholder="Repository root, or choose a folder below" maxlength="240" autocomplete="off"></label><div class="ghrc-folder-actions"><button type="button" class="home" aria-label="Browse repository root">⌂</button><button type="button" class="up" aria-label="Up one folder">↑</button><span class="ghrc-folder-path" aria-live="polite"></span></div><div class="ghrc-folder-browser"><nav class="ghrc-folder-list" aria-label="Repository folders"></nav><div class="ghrc-folder-preview" aria-label="Folder contents" aria-live="polite"></div></div><p class="ghrc-folder-help">Click a folder to open it. Type a new category to create it.</p><div class="ghrc-folder-footer"><button type="button" class="root"></button><button value="cancel">Cancel</button><button value="import"></button></div></form>';
    dialog.querySelector('h2').textContent = launch ? 'Research and import' : 'Import Deep Research';
    dialog.querySelector('[value="import"]').textContent = launch ? 'Start research' : 'Import report';
    dialog.querySelector('.root').textContent = launch ? 'Start at root' : 'Import to root';
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
      dialog.querySelector('.ghrc-folder-path').textContent = path ? '/ ' + path.split('/').join(' / ') : 'Repository root';
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
    dialog.querySelector('.home').addEventListener('click', () => browse(''));
    dialog.querySelector('.root').addEventListener('click', () => {
      input.value = '';
      dialog.close('import');
    });
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
