(() => {
  "use strict";
  const MAX_ISSUES = 24;
  const PATH = /^\/([a-z0-9-]+)\/([a-z0-9_.-]+)\/issues\/([1-9][0-9]*)\/?$/i;
  function parseIssueUrl(value) {
    const raw = String(value || "").trim();
    let url;
    try { url = new URL(/^github\.com\//i.test(raw) ? "https://" + raw : raw); }
    catch { throw new Error("Enter a GitHub issue URL, such as https://github.com/owner/repo/issues/123."); }
    const parts = PATH.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" ||
        url.port || url.username || url.password || !parts)
      throw new Error("Only GitHub issue URLs ending in /owner/repo/issues/123 are supported.");
    const number = Number(parts[3]);
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("The issue number must be a positive integer.");
    const [, owner, repository] = parts;
    return { url: `https://github.com/${owner}/${repository}/issues/${number}`, owner, repository, number };
  }
  function normalizePinnedIssues(value) {
    const seen = new Set(), result = [];
    for (const entry of Array.isArray(value) ? value : []) {
      if (typeof entry?.url !== "string") continue;
      let issue;
      try { issue = parseIssueUrl(entry.url); } catch { continue; }
      const key = issue.url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...issue, label: typeof entry.label === "string" ? entry.label.trim().slice(0,120) : "" });
      if (result.length === MAX_ISSUES) break;
    }
    return result;
  }
  const api = Object.freeze({ MAX_ISSUES, parseIssueUrl, normalizePinnedIssues });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.__ghrcPinnedIssues = api;
})();
