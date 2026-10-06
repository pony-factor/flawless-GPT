// GitHub blocks framing. Read its API rather than embedding the website.
function githubPreviewRoute(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname)
      || url.username || url.password || url.port) {
    throw new Error("Unsupported GitHub preview URL.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (!parts.length || parts.some(part => !/^[\w.-]+$/.test(part) || part === "." || part === "..")) {
    throw new Error("Open this GitHub page in a new tab.");
  }
  const [owner, repo, type, id] = parts;
  if (parts.length === 1) return { endpoint: `/users/${owner}`, kind: "profile" };
  const base = `/repos/${owner}/${repo}`;
  if (parts.length === 2) return { endpoint: base, kind: "repository" };
  // PR subpages share the same summary and file preview.
  if (["pull", "issues"].includes(type) && /^\d+$/.test(id || "")
      && (parts.length === 4 || (parts.length === 5 && ["files", "commits"].includes(parts[4])))) {
    return { endpoint: `${base}/${type === "pull" ? "pulls" : "issues"}/${id}`, kind: type, subtitle: `${owner}/${repo} #${id}` };
  }
  if (type === "commit" && /^[a-f\d]{7,40}$/i.test(id || "") && parts.length === 4) {
    return { endpoint: `${base}/commits/${id}`, kind: "commit", subtitle: `${owner}/${repo} · ${id.slice(0, 7)}` };
  }
  throw new Error("This GitHub page does not have a content preview yet.");
}

async function loadGitHubLinkPreview(value) {
  const route = githubPreviewRoute(value);
  const tokens = await TokenVault.loadTokens({ refresh: true });
  // Keep credentials in the worker and send them only to the fixed GitHub API origin.
  async function request(endpoint) {
    let lastError;
    for (const token of ["", ...tokens.map(entry => entry.token)]) {
      try {
        return await fetchGitHub(`https://api.github.com${endpoint}`, token);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
  const data = await request(route.endpoint);
  const result = { ok: true, subtitle: route.subtitle || data.full_name || data.login, files: [] };
  if (route.kind === "commit") {
    result.title = data.commit.message.split("\n")[0];
    result.body = data.commit.message.split("\n").slice(1).join("\n").trim();
    result.details = `${data.commit.author.name} · ${data.commit.author.date} · +${data.stats.additions} −${data.stats.deletions}`;
    result.files = data.files || [];
  } else if (["pull", "issues"].includes(route.kind)) {
    result.title = data.title;
    result.body = data.body || "No description provided.";
    result.details = `${data.merged_at ? "Merged" : data.state} · ${data.user.login}`;
    if (route.kind === "pull") {
      try {
        result.files = await request(`${route.endpoint}/files?per_page=100`);
        if (data.changed_files > result.files.length) result.note = `Showing ${result.files.length} of ${data.changed_files} changed files. Open the full page for the remaining files.`;
      } catch {
        result.note = "File diffs could not be loaded. Open the full page to view them.";
      }
    }
  } else {
    result.title = data.full_name || data.name || data.login;
    result.body = data.description || data.bio || "";
    result.details = route.kind === "repository"
      ? `${data.private ? "Private" : "Public"} repository · ${data.stargazers_count} stars · ${data.language || "No language specified"}`
      : `${data.public_repos} public repositories · ${data.followers} followers`;
  }
  // Return only display data, never API response metadata or credentials.
  result.files = result.files.map(file => ({ filename: file.filename, additions: file.additions, deletions: file.deletions, patch: file.patch }));
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "load-github-link-preview") return false;
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith("https://chatgpt.com/")) {
    sendResponse({ ok: false, error: "GitHub previews are only available from ChatGPT." });
    return false;
  }
  loadGitHubLinkPreview(message.url)
    .then(sendResponse)
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
