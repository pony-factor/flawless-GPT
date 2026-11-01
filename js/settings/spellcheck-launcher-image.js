(() => {
  const IMAGE_KEY = "spellcheckLauncherImage";
  const MAX_BYTES = 1024 * 1024;
  const MAX_LENGTH = Math.ceil(MAX_BYTES / 3) * 4 + 64;
  const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  const DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
  const preview = document.getElementById("spellcheck-launcher-image-preview");
  const picker = document.getElementById("spellcheck-launcher-image-file");
  const reset = document.getElementById("reset-spellcheck-launcher-image");
  const status = document.getElementById("spellcheck-launcher-image-status");
  if (!preview || !picker || !reset || !status) return;

  const defaultImage = chrome.runtime.getURL("artwork/spellcheck-only.jpg");
  let currentImage = null;
  let busy = false;
  const valid = (value) => typeof value === "string" && value.length <= MAX_LENGTH && DATA_URL.test(value);
  function render(value) {
    currentImage = valid(value) ? value : null;
    preview.src = currentImage || defaultImage;
    reset.disabled = busy || !currentImage;
  }
  function read(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read the selected file."));
      reader.readAsDataURL(file);
    });
  }
  function decode(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = resolve;
      image.onerror = () => reject(new Error("The selected file is not a readable image."));
      image.src = src;
    });
  }
  preview.addEventListener("error", () => {
    if (preview.src !== defaultImage) preview.src = defaultImage;
  });
  picker.addEventListener("change", async (event) => {
    // Do not trigger a save of unrelated settings for a file selection.
    event.stopPropagation();
    const file = picker.files?.[0];
    picker.value = "";
    if (!file || busy) return;
    if (!TYPES.has(file.type) || file.size < 1 || file.size > MAX_BYTES) {
      status.textContent = "Choose a PNG, JPEG, WebP or GIF image up to 1 MB.";
      return;
    }
    busy = true;
    picker.disabled = true;
    render(currentImage);
    try {
      const data = await read(file);
      if (!valid(data)) throw new Error("Invalid image data.");
      await decode(data);
      await chrome.storage.local.set({ [IMAGE_KEY]: data });
      render(data);
      status.textContent = "Custom image saved locally in this browser.";
    } catch (error) {
      status.textContent = `Image not saved: ${error.message}`;
    } finally {
      busy = false;
      picker.disabled = false;
      render(currentImage);
    }
  });
  reset.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    render(currentImage);
    try {
      await chrome.storage.local.remove(IMAGE_KEY);
      render(null);
      status.textContent = "Default image restored.";
    } catch (error) {
      status.textContent = `Could not restore image: ${error.message}`;
    } finally {
      busy = false;
      render(currentImage);
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[IMAGE_KEY]) render(changes[IMAGE_KEY].newValue);
  });
  void chrome.storage.local.get({ [IMAGE_KEY]: null })
    .then((settings) => render(settings[IMAGE_KEY]))
    .catch((error) => { status.textContent = `Could not load image: ${error.message}`; });
})();
