(() => {
  const OWNER_GROUPS_PER_ROW_KEY = "ownerGroupsPerRow";
  const HIDE_REPOSITORY_DASHBOARD_KEY = "hideRepositoryDashboard";
  const DEFAULT_GROUPS_PER_ROW = 3;
  const input = document.getElementById("owner-groups-per-row");
  const repositorySearchPreference = document
    .getElementById("show-repository-search")
    ?.closest(".preference");

  let hideRepositoryDashboardInput = null;
  if (repositorySearchPreference) {
    const preference = document.createElement("label");
    preference.className = "preference";
    preference.innerHTML = `
      <input id="hide-repository-dashboard" type="checkbox" />
      <span>
        <strong>Hide repository dashboard</strong>
        <small>Hides the full repository dashboard, including repository search, wooten.link search, repository lists, pagination, and dashboard controls.</small>
      </span>
    `;
    repositorySearchPreference.before(preference);
    hideRepositoryDashboardInput = preference.querySelector("input");
  }

  function normalizedGroupsPerRow(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_GROUPS_PER_ROW;
    return Math.min(8, Math.max(1, parsed));
  }

  async function loadSettings() {
    const settings = await chrome.storage.local.get({
      [OWNER_GROUPS_PER_ROW_KEY]: DEFAULT_GROUPS_PER_ROW,
      [HIDE_REPOSITORY_DASHBOARD_KEY]: false,
    });
    input.value = normalizedGroupsPerRow(settings[OWNER_GROUPS_PER_ROW_KEY]);
    if (hideRepositoryDashboardInput) {
      hideRepositoryDashboardInput.checked = Boolean(
        settings[HIDE_REPOSITORY_DASHBOARD_KEY],
      );
    }
  }

  input.addEventListener("change", async () => {
    const ownerGroupsPerRow = normalizedGroupsPerRow(input.value);
    input.value = ownerGroupsPerRow;
    await chrome.storage.local.set({ [OWNER_GROUPS_PER_ROW_KEY]: ownerGroupsPerRow });
  });

  hideRepositoryDashboardInput?.addEventListener("change", async () => {
    await chrome.storage.local.set({
      [HIDE_REPOSITORY_DASHBOARD_KEY]: hideRepositoryDashboardInput.checked,
    });
  });

  void loadSettings();
})();
