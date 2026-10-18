(() => {
  const browser = document.getElementById("publisher-browser");
  function render() {
    document.getElementById("publisher-install-command").textContent =
      `python3 native/install.py --extension-id ${chrome.runtime.id} --browser ${browser.value}`;
  }
  browser.addEventListener("change", render);
  render();
})();
