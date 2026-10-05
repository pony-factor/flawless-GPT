(() => {
  "use strict";

  const STORAGE_KEY = "highlightedPages";
  const MAX_PAGES = 20;
  const root = document.getElementById("highlighted-pages-settings");
  if (!root) return;

  const list = document.getElementById("highlighted-pages-list");
  const template = document.getElementById("highlighted-page-template");
  const urlInput = document.getElementById("highlighted-page-url");
  const addButton = document.getElementById("add-highlighted-page");
  const status = document.getElementById("highlighted-pages-status");
  let pages = [];
  let draggedRow = null;
  let busy = false;

  function showStatus(message, state = "") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function normalizedUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("Enter a webpage URL first.");
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Highlighted webpages must use http or https.");
    }
    return url.toString();
  }

  function originPattern(urlValue) {
    const url = new URL(urlValue);
    return `${url.protocol}//${url.host}/*`;
  }

  function normalizedPages(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).filter((page) => {
      if (!page || typeof page.url !== "string") return false;
      const key = page.url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_PAGES);
  }

  function previewImage(page) {
    return page.imageDataUrl || page.faviconDataUrl || "";
  }

  async function save() {
    await chrome.storage.local.set({ [STORAGE_KEY]: pages });
  }

  function updateControls() {
    const rows = [...list.querySelectorAll(".highlighted-page-setting")];
    rows.forEach((row, index) => {
      row.querySelector(".move-highlight-up").disabled = index === 0;
      row.querySelector(".move-highlight-down").disabled = index === rows.length - 1;
    });
  }

  function reorderFromDom() {
    const order = [...list.querySelectorAll(".highlighted-page-setting")]
      .map((row) => row.dataset.id);
    const byId = new Map(pages.map((page) => [page.id, page]));
    pages = order.map((id) => byId.get(id)).filter(Boolean);
  }

  function moveRow(row, direction) {
    const sibling = direction < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling?.classList.contains("highlighted-page-setting")) return;
    if (direction < 0) list.insertBefore(row, sibling);
    else list.insertBefore(sibling, row);
    reorderFromDom();
    updateControls();
    void save();
  }

  async function fetchPreview(urlValue) {
    const url = normalizedUrl(urlValue);
    const access = { origins: [originPattern(url)] };
    const granted = await chrome.permissions.contains(access) || await chrome.permissions.request(access);
    if (!granted) {
      throw new Error("Page access was not granted, so the preview could not be cached.");
    }

    const response = await chrome.runtime.sendMessage({
      type: "load-highlighted-page-preview",
      url,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "The webpage preview could not be loaded.");
    }
    const preview = response.preview;
    if (preview.documentType === "pdf") {
      showStatus("Rendering PDF first page…");
      const { renderPdfPreview } = await import("./pdf-preview.mjs");
      preview.imageDataUrl = await renderPdfPreview(preview.url);
    }
    return preview;
  }

  async function refreshPage(page, row) {
    if (busy) return;
    busy = true;
    const button = row.querySelector(".refresh-highlight");
    button.disabled = true;
    showStatus(`Refreshing ${page.customTitle || page.title || page.url}…`);
    try {
      const preview = await fetchPreview(page.url);
      const index = pages.findIndex((entry) => entry.id === page.id);
      if (index >= 0) pages[index] = { ...preview, id: page.id, customTitle: pages[index].customTitle || "" };
      await save();
      render();
      showStatus("Cached preview refreshed.", "success");
    } catch (error) {
      showStatus(error.message, "error");
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  function createRow(page) {
    const row = template.content.firstElementChild.cloneNode(true);
    row.dataset.id = page.id;
    const image = previewImage(page);
    if (page.documentType === "pdf") row.classList.add("highlighted-page-setting-pdf");
    if (image) {
      row.querySelector(".highlighted-page-setting-preview").style.backgroundImage = `url("${image}")`;
    }
    row.querySelector(".highlighted-page-setting-copy strong").textContent = page.customTitle || page.title || page.url;
    row.querySelector(".highlighted-page-setting-copy small").textContent =
      page.hostname || new URL(page.url).hostname;
    row.querySelector(".move-highlight-up").addEventListener("click", () => moveRow(row, -1));
    row.querySelector(".move-highlight-down").addEventListener("click", () => moveRow(row, 1));
    row.querySelector(".rename-highlight").addEventListener("click", async () => {
      const name = window.prompt("Highlight name (leave blank to use the original title):", page.customTitle || page.title || "");
      if (name === null) return;
      const current = pages.find((entry) => entry.id === page.id);
      if (!current) return;
      const previous = current.customTitle;
      current.customTitle = name.trim();
      try {
        await save();
        render();
        showStatus(current.customTitle ? "Highlight renamed." : "Original highlight title restored.", "success");
      } catch (error) {
        current.customTitle = previous;
        showStatus(error.message, "error");
      }
    });
    row.querySelector(".refresh-highlight").addEventListener("click", () => void refreshPage(page, row));
    row.querySelector(".remove-highlight").addEventListener("click", async () => {
      pages = pages.filter((entry) => entry.id !== page.id);
      await save();
      render();
      showStatus("Highlighted webpage removed.", "success");
    });
    return row;
  }

  function render() {
    if (!pages.length) {
      const empty = document.createElement("p");
      empty.className = "highlighted-pages-settings-empty";
      empty.textContent = "No webpages highlighted yet.";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...pages.map(createRow));
    updateControls();
  }

  async function addPage() {
    if (busy) return;
    if (pages.length >= MAX_PAGES) {
      showStatus(`You can highlight up to ${MAX_PAGES} webpages.`, "error");
      return;
    }

    busy = true;
    addButton.disabled = true;
    try {
      const entered = normalizedUrl(urlInput.value);
      if (pages.some((page) => page.url.toLowerCase() === entered.toLowerCase())) {
        throw new Error("That webpage is already highlighted.");
      }

      showStatus("Caching webpage preview…");
      const preview = await fetchPreview(entered);
      if (pages.some((page) => page.url.toLowerCase() === preview.url.toLowerCase())) {
        throw new Error("That webpage is already highlighted.");
      }

      pages.push({
        ...preview,
        id: crypto.randomUUID?.()
          || `page-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      });
      await save();
      urlInput.value = "";
      render();
      showStatus("Highlighted webpage added and cached.", "success");
    } catch (error) {
      showStatus(error.message, "error");
    } finally {
      busy = false;
      addButton.disabled = false;
    }
  }

  list.addEventListener("dragstart", (event) => {
    const row = event.target.closest(".highlighted-page-setting");
    if (!row) return;
    draggedRow = row;
    row.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", row.dataset.id);
  });

  list.addEventListener("dragover", (event) => {
    const target = event.target.closest(".highlighted-page-setting");
    if (!draggedRow || !target || target === draggedRow) return;
    event.preventDefault();
    const bounds = target.getBoundingClientRect();
    const insertAfter = event.clientY > bounds.top + (bounds.height / 2);
    list.insertBefore(draggedRow, insertAfter ? target.nextSibling : target);
  });

  list.addEventListener("drop", (event) => event.preventDefault());
  list.addEventListener("dragend", () => {
    draggedRow?.classList.remove("dragging");
    draggedRow = null;
    reorderFromDom();
    updateControls();
    void save();
  });

  addButton.addEventListener("click", () => void addPage());
  urlInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void addPage();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) return;
    pages = normalizedPages(changes[STORAGE_KEY].newValue);
    render();
  });

  chrome.storage.local.get({ [STORAGE_KEY]: [] }).then((stored) => {
    pages = normalizedPages(stored[STORAGE_KEY]);
    render();
  });
})();
