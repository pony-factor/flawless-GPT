(() => {
  const OWNER_GROUPS_PER_ROW_KEY = "ownerGroupsPerRow";
  const HIDE_REPOSITORY_DASHBOARD_KEY = "hideRepositoryDashboard";
  const PERSONAL_REPOSITORY_COLUMN_TITLE_KEY = "personalRepositoryColumnTitle";
  const DEFAULT_GROUPS_PER_ROW = 3;
  const DEFAULT_PERSONAL_REPOSITORY_COLUMN_TITLE = "Personal Repos";
  const input = document.getElementById("owner-groups-per-row");
  const repositorySearchPreference = document
    .getElementById("show-repository-search")
    ?.closest(".preference");
  const repositoryTotalPreference = document
    .getElementById("show-repository-total")
    ?.closest(".preference");

  let hideRepositoryDashboardInput = null;
  let personalRepositoryColumnTitleInput = null;
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

  if (repositoryTotalPreference) {
    const label = document.createElement("label");
    label.htmlFor = "personal-repository-column-title";
    label.textContent = "Personal repository column title";

    const help = document.createElement("p");
    help.className = "help";
    help.textContent = "Use a custom heading for personal GitHub-account columns. Leave blank to use the account’s GitHub display name.";

    const input = document.createElement("input");
    input.id = "personal-repository-column-title";
    input.name = "personal-repository-column-title";
    input.type = "text";
    input.placeholder = DEFAULT_PERSONAL_REPOSITORY_COLUMN_TITLE;
    input.autocomplete = "off";

    repositoryTotalPreference.after(label, help, input);
    personalRepositoryColumnTitleInput = input;
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
      [PERSONAL_REPOSITORY_COLUMN_TITLE_KEY]: DEFAULT_PERSONAL_REPOSITORY_COLUMN_TITLE,
    });
    input.value = normalizedGroupsPerRow(settings[OWNER_GROUPS_PER_ROW_KEY]);
    if (personalRepositoryColumnTitleInput) {
      personalRepositoryColumnTitleInput.value = typeof settings[PERSONAL_REPOSITORY_COLUMN_TITLE_KEY] === "string"
        ? settings[PERSONAL_REPOSITORY_COLUMN_TITLE_KEY]
        : DEFAULT_PERSONAL_REPOSITORY_COLUMN_TITLE;
    }
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

  personalRepositoryColumnTitleInput?.addEventListener("change", async () => {
    const title = personalRepositoryColumnTitleInput.value.trim();
    personalRepositoryColumnTitleInput.value = title;
    await chrome.storage.local.set({
      [PERSONAL_REPOSITORY_COLUMN_TITLE_KEY]: title,
    });
  });

  void loadSettings();
})();
