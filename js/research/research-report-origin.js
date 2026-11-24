globalThis.__ghrcIsResearchReportOrigin = (() => {
  const reportOrigin = /^https:\/\/(?:connector-openai-deep-research|connector-id-[a-f0-9]{32}|mcp-app-[a-f0-9]+)\.web-sandbox\.oaiusercontent\.com$/;
  return (url) => {
    try {
      return reportOrigin.test(new URL(url).origin);
    } catch {
      return false;
    }
  };
})();
