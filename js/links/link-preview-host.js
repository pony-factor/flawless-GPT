(() => {
  try {
    const url = new URL(decodeURIComponent(location.hash.slice(1)));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Unsupported website URL.");
    }
    const frame = document.createElement("iframe");
    frame.title = "Website preview: " + url.hostname;
    frame.referrerPolicy = "no-referrer";
    // Browser PDF viewers cannot run inside sandboxed frames. This remote
    // frame remains isolated from the extension by the same-origin policy.
    frame.src = url.href;
    document.body.append(frame);
  } catch {
    document.body.textContent = "This website URL cannot be previewed.";
  }
})();
