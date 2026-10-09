// GitHub blocks framing. Read its API rather than embedding the website.
function githubPreviewRoute(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname)
      || url.username || url.password || url.port) {
    throw new Error("Unsupported GitHub preview URL.");
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (!parts.length || parts.some(part => !part || part === "." || part === ".."
      || /[/\\\x00-\x1f]/.test(part))) {
    throw new Error("Open this GitHub page in a new tab.");
  }
  const [owner, repo, type, id] = parts;
  if (!/^[\w-]+$/.test(owner) || (repo && !/^[\w.-]+$/.test(repo))) {
    throw new Error("Open this GitHub page in a new tab.");
  }
  if (parts.length === 1) return { endpoint: "/users/" + owner, kind: "profile" };
  const base = "/repos/" + owner + "/" + repo;
  const browser = "https://github.com/" + owner + "/" + repo;
  if (parts.length === 2) return { endpoint: base, kind: "repository", browser };
  if (["blob", "tree"].includes(type) && parts.length >= 4) {
    return { endpoint: base, kind: "path", pageKind: type, segments: parts.slice(3),
      browser, subtitle: owner + "/" + repo };
  }
  if (["pull", "issues"].includes(type) && /^\d+$/.test(id || "")
      && (parts.length === 4 || (parts.length === 5 && ["files", "commits"].includes(parts[4])))) {
    return { endpoint: base + "/" + (type === "pull" ? "pulls" : "issues") + "/" + id,
      kind: type, browser, id, subtitle: owner + "/" + repo + " #" + id };
  }
  if (type === "commit" && /^[a-f\d]{7,40}$/i.test(id || "") && parts.length === 4) {
    return { endpoint: base + "/commits/" + id, kind: "commit", subtitle: owner + "/" + repo + " · " + id.slice(0, 7) };
  }
  if (type === "discussions" && (parts.length === 3
      || (parts.length === 4 && /^\d+$/.test(id || "")))) {
    return { kind: parts.length === 3 ? "discussions-list" : "discussion",
      owner, repo, id, subtitle: owner + "/" + repo };
  }
  if (parts.length === 3) {
    const endpoints = {
      issues: ["/issues?state=all&per_page=50", "issues-list"],
      pulls: ["/pulls?state=all&per_page=50", "pulls-list"],
      branches: ["/branches?per_page=100", "branches"],
      tags: ["/tags?per_page=100", "tags"],
      commits: ["/commits?per_page=50", "commits-list"],
      releases: ["/releases?per_page=50", "releases"],
      actions: ["/actions/runs?per_page=50", "actions"],
    };
    if (endpoints[type]) return { endpoint: base + endpoints[type][0],
      kind: endpoints[type][1], browser, subtitle: owner + "/" + repo };
  }
  if (type === "releases" && parts.length === 5 && parts[3] === "tag") {
    return { endpoint: base + "/releases/tags/" + encodeURIComponent(parts[4]),
      kind: "release", subtitle: owner + "/" + repo };
  }
  if (type === "actions" && parts.length === 5 && parts[3] === "runs" && /^\d+$/.test(parts[4])) {
    return { endpoint: base + "/actions/runs/" + parts[4],
      kind: "action-run", subtitle: owner + "/" + repo };
  }
  throw new Error("This GitHub page does not have an API preview yet.");
}

function githubPreviewPath(parts) {
  return parts.map(encodeURIComponent).join("/");
}

async function loadGitHubLinkPreview(value) {
  const route = githubPreviewRoute(value);
  const tokens = await TokenVault.loadTokens({ refresh: true });
  // Credentials stay in this worker and are only sent to the fixed GitHub API origin.
  async function request(endpoint) {
    let lastError;
    for (const token of [...tokens.map(entry => entry.token), ""]) {
      try {
        return await fetchGitHub("https://api.github.com" + endpoint, token);
      } catch (error) {
        lastError = error;
        // A permission/rate-limit error should not trigger many alternative ref guesses.
        if (/403|rate.limit/i.test(error.message || "")) break;
      }
    }
    throw lastError;
  }

  const result = { ok: true, kind: route.kind, subtitle: route.subtitle || "", files: [] };
  if (["discussion", "discussions-list"].includes(route.kind)) {
    // GitHub Discussions use GraphQL rather than REST; only authenticated tokens work.
    if (!tokens.length) {
      throw new Error("Connect a GitHub account with Discussions read access to preview this page.");
    }
    const query = route.kind === "discussion"
      ? "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){discussion(number:$number){title body url author{login} comments(first:30){nodes{body url author{login}}}}}}"
      : "query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){discussions(first:30){nodes{number title url category{name}}}}}";
    const variables = { owner: route.owner, repo: route.repo };
    if (route.kind === "discussion") variables.number = Number(route.id);
    let payload, lastError;
    for (const entry of tokens) {
      try {
        const response = await fetch("https://api.github.com/graphql", {
          method: "POST",
          headers: githubHeaders(entry.token),
          body: JSON.stringify({ query, variables }),
        });
        if (!response.ok) throw new Error("GitHub GraphQL returned " + response.status);
        const answer = await response.json();
        if (answer.errors?.length) throw new Error("GitHub did not authorize this discussion.");
        payload = answer.data?.repository;
        if (!payload) throw new Error("Discussion or repository unavailable.");
        break;
      } catch (error) { lastError = error; }
    }
    if (!payload) throw lastError || new Error("Discussion unavailable.");
    if (route.kind === "discussion") {
      const discussion = payload.discussion;
      if (!discussion) throw new Error("Discussion not found.");
      result.title = discussion.title;
      result.body = discussion.body || "";
      result.details = "GitHub Discussion · " + (discussion.author?.login || "Unknown author");
      result.comments = (discussion.comments?.nodes || []).map(item => ({
        author: item.author?.login || "Unknown", body: item.body || "", url: item.url,
      }));
    } else {
      result.title = "Discussions";
      result.entries = (payload.discussions?.nodes || []).map(item => ({
        title: "#" + item.number + " " + item.title, detail: item.category?.name || "Discussion", url: item.url,
      }));
    }
    return result;
  }
  if (route.kind === "path") {
    // GitHub's /blob/ and /tree/ URLs don't delimit ref names containing slashes.
    // Resolve the first successful ref/path split instead of assuming one segment.
    let data, ref, path, lastError;
    const segments = route.segments;
    for (let split = 1; split <= Math.min(segments.length, 12); split += 1) {
      const candidateRef = segments.slice(0, split).join("/");
      const candidatePath = segments.slice(split).join("/");
      if (route.pageKind === "blob" && !candidatePath) continue;
      const suffix = candidatePath ? "/" + githubPreviewPath(candidatePath.split("/")) : "";
      try {
        const candidate = await request(route.endpoint + "/contents" + suffix
          + "?ref=" + encodeURIComponent(candidateRef));
        if (Array.isArray(candidate) !== (route.pageKind === "tree")) continue;
        data = candidate;
        ref = candidateRef;
        path = candidatePath;
        break;
      } catch (error) {
        lastError = error;
        if (!/404/.test(error.message || "")) throw error;
      }
    }
    if (!data) throw lastError || new Error("GitHub could not resolve this file or directory.");
    result.ref = ref;
    result.path = path;
    result.subtitle = route.subtitle + " · " + ref;
    const refUrl = githubPreviewPath(ref.split("/"));
    const directoryUrl = (directory) => route.browser + "/tree/" + refUrl
      + (directory ? "/" + githubPreviewPath(directory.split("/")) : "");
    const parent = path.split("/").slice(0, -1).join("/");
    result.parentUrl = route.pageKind === "tree" && !path ? null : directoryUrl(parent);
    if (Array.isArray(data)) {
      result.kind = "directory";
      result.title = path || ref;
      result.details = data.length + " items";
      result.entries = data.map(item => ({
        title: item.name,
        detail: item.type === "dir" ? "Folder" : "File",
        url: route.browser + "/" + (item.type === "dir" ? "tree" : "blob")
          + "/" + refUrl + "/" + githubPreviewPath(item.path.split("/")),
      }));
      result.entries.sort((a, b) => (a.detail === "Folder" ? 0 : 1) - (b.detail === "Folder" ? 0 : 1)
        || a.title.localeCompare(b.title));
    } else {
      result.kind = "file";
      result.title = data.name;
      result.details = path + " · " + (data.size || 0).toLocaleString() + " bytes";
      const imageMime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp" };
      const extension = data.name.split(".").pop().toLowerCase();
      if (data.encoding === "base64" && data.content) {
        const encoded = data.content.replace(/\s/g, "");
        if (imageMime[extension] && data.size <= 1000000) {
          result.image = "data:" + imageMime[extension] + ";base64," + encoded;
        } else if (imageMime[extension]) {
          result.note = "This image is too large for an inline preview. Open it in a new tab.";
        } else {
          const binary = atob(encoded);
          if (binary.length > 250000) {
            result.note = "File is too large for a sidebar preview. Open it in a new tab.";
          } else if (binary.includes("\x00")) {
            result.note = "Binary files cannot be displayed as text.";
          } else {
            result.text = new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
            result.markdown = /\.(md|markdown|mdown)$/i.test(data.name);
          }
        }
      } else {
        result.note = "GitHub did not return file contents. Open the full file in a new tab.";
      }
    }
    return result;
  }

  const data = await request(route.endpoint);
  if (route.kind === "commit") {
    result.title = data.commit.message.split("\n")[0];
    result.body = data.commit.message.split("\n").slice(1).join("\n").trim();
    result.details = data.commit.author.name + " · " + data.commit.author.date
      + " · +" + data.stats.additions + " −" + data.stats.deletions;
    result.files = data.files || [];
  } else if (["pull", "issues"].includes(route.kind)) {
    result.title = data.title;
    result.body = data.body || "No description provided.";
    result.details = (data.merged_at ? "Merged" : data.state) + " · " + data.user.login;
    if (route.kind === "pull") {
      try {
        result.files = await request(route.endpoint + "/files?per_page=100");
        if (data.changed_files > result.files.length) {
          result.note = "Showing " + result.files.length + " of " + data.changed_files + " changed files.";
        }
      } catch {
        result.note = "File diffs could not be loaded. Open the full page to view them.";
      }
    }
    try {
      const comments = await request(route.browser.replace("https://github.com", "/repos")
        + "/issues/" + route.id + "/comments?per_page=30");
      result.comments = comments.map(comment => ({
        author: comment.user?.login || "Unknown",
        body: comment.body || "",
        url: comment.html_url,
      }));
    } catch {
      // Comments are optional; never hide the issue or pull request.
    }
  } else if (route.kind === "repository") {
    result.title = data.full_name;
    result.body = data.description || "";
    result.details = (data.private ? "Private" : "Public") + " repository · "
      + data.stargazers_count + " stars · " + (data.language || "No language specified");
    try {
      const contents = await request(route.endpoint + "/contents?ref=" + encodeURIComponent(data.default_branch));
      result.entries = contents.map(item => ({
        title: item.name,
        detail: item.type === "dir" ? "Folder" : "File",
        url: route.browser + "/" + (item.type === "dir" ? "tree" : "blob") + "/"
          + encodeURIComponent(data.default_branch) + "/" + githubPreviewPath(item.path.split("/")),
      }));
      result.entries.sort((a, b) => (a.detail === "Folder" ? 0 : 1) - (b.detail === "Folder" ? 0 : 1)
        || a.title.localeCompare(b.title));
    } catch {
      result.note = "Repository files are unavailable with the current GitHub access.";
    }
  } else if (route.kind === "profile") {
    result.title = data.name || data.login;
    result.body = data.bio || "";
    result.details = data.public_repos + " public repositories · " + data.followers + " followers";
  } else if (["issues-list", "pulls-list", "branches", "tags", "commits-list", "releases", "actions"].includes(route.kind)) {
    const items = route.kind === "actions" ? data.workflow_runs : data;
    result.title = route.kind.replace(/-list$/, "").replace(/-/g, " ");
    result.details = items.length + " recent entries";
    result.entries = items.map(item => {
      switch (route.kind) {
        case "issues-list": case "pulls-list":
          return { title: "#" + item.number + " " + item.title, detail: item.state, url: item.html_url };
        case "branches":
          return { title: item.name, detail: "Branch",
            url: route.browser + "/tree/" + githubPreviewPath(item.name.split("/")) };
        case "tags":
          return { title: item.name, detail: "Tag",
            url: route.browser + "/tree/" + githubPreviewPath(item.name.split("/")) };
        case "commits-list":
          return { title: item.commit?.message?.split("\n")[0] || item.sha.slice(0, 7),
            detail: item.sha.slice(0, 7), url: item.html_url };
        case "releases":
          return { title: item.name || item.tag_name, detail: item.tag_name, url: item.html_url };
        default:
          return { title: item.name || item.display_title || "Workflow run #" + item.run_number,
            detail: item.status + (item.conclusion ? " · " + item.conclusion : ""), url: item.html_url };
      }
    });
  } else if (route.kind === "release") {
    result.title = data.name || data.tag_name;
    result.body = data.body || "";
    result.details = "Release · " + data.tag_name;
    result.entries = (data.assets || []).map(item => ({
      title: item.name, detail: (item.size || 0) + " bytes", url: item.browser_download_url,
    }));
  } else if (route.kind === "action-run") {
    result.title = data.name || "Workflow run #" + data.run_number;
    result.details = data.status + " · " + (data.conclusion || "Pending") + " · " + data.head_branch;
    result.body = data.display_title || "";
  }
  result.files = result.files.map(file => ({
    filename: file.filename, additions: file.additions, deletions: file.deletions, patch: file.patch,
  }));
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
