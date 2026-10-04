(() => {
  globalThis.__ghrcChooseResearchCategory = (doc, connection, launch = false) => new Promise(resolve => {
    const dialog = doc.createElement("dialog");
    dialog.className = "ghrc-report-import";
    dialog.innerHTML = '<form method="dialog"><h2></h2><p class="destination"></p><label>Category <input name="category" list="ghrc-launch-categories" placeholder="Choose or create a category" maxlength="240" autocomplete="off"></label><datalist id="ghrc-launch-categories"></datalist><p>Leave empty to use the repository root. Use / for nested categories.</p><div><button value="cancel">Cancel</button><button value="import"></button></div></form>';
    dialog.querySelector("h2").textContent = launch ? "Research and import" : "Import Deep Research";
    dialog.querySelector('[value="import"]').textContent = launch ? "Start research" : "Import report";
    dialog.querySelector(".destination").textContent = `${connection.repository} (${connection.branch})`;
    for (const category of connection.categories || []) {
      const option = doc.createElement("option");
      option.value = category;
      dialog.querySelector("datalist").append(option);
    }
    dialog.addEventListener("close", () => {
      const category = dialog.querySelector("input").value.trim();
      resolve(dialog.returnValue === "import" ? category : null);
      dialog.remove();
    }, { once: true });
    doc.body.append(dialog);
    dialog.showModal();
  });
})();
