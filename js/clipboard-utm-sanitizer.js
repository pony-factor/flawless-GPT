(() => {
  const STRIP_UTM_TRACKING_ATTR = "data-ghrc-strip-utm-tracking";
  const STRIP_COPIED_BOLD_ATTR = "data-ghrc-strip-copied-bold";
  const NORMALIZE_COPIED_QUOTES_ATTR = "data-ghrc-normalize-copied-quotes";
  const UNDERSCORE_COPIED_ITALICS_ATTR = "data-ghrc-underscore-copied-italics";
  const URL_PATTERN = /https?:\/\/[^\s<>"'`\])}]+/gi;
  const CONTENT_REFERENCE_PATTERN = /:chatgpt-content-reference\{[^}\r\n]*\}/g;
  // Source-preview favicons are decoration, not cited images. The copied
  // Markdown may include the icon and a bare file name as an extra paragraph.
  const CITATION_PREVIEW_FILE_PATTERN = /^[a-z0-9][a-z0-9_.() -]{0,150}\.(?:docx?|pdf|rtf|txt|html?)$/i;

  function isCitationFaviconUrl(value) {
    try {
      const url = new URL(value.replace(/\\&/g, "&").replace(/&amp;/gi, "&"));
      return url.protocol === "https:"
        && ["www.google.com", "google.com"].includes(url.hostname)
        && url.pathname === "/s2/favicons";
    } catch {
      return false;
    }
  }

  function isBlankPreviewLine(line) {
    return !line.replace(/^\s*(?:>\s*)+/, "").trim();
  }

  function stripCitationPreviewThumbnails(value) {
    if (typeof value !== "string" || !value) return value;
    const lines = value.split(/\r?\n/);
    const removed = new Set();
    const imageLine = /^!?\[(?:image|favicon|thumbnail)\]\((https?:\/\/[^\s)]+)\)$/i;
    for (let index = 0; index < lines.length; index += 1) {
      const content = lines[index].replace(/^\s*(?:>\s*)+/, "").trim();
      const match = content.match(imageLine);
      if (!match || !isCitationFaviconUrl(match[1])) continue;
      removed.add(index);

      let captionIndex = index + 1;
      while (captionIndex < lines.length && captionIndex <= index + 4
        && isBlankPreviewLine(lines[captionIndex])) captionIndex++;
      const caption = lines[captionIndex]?.replace(/^\s*(?:>\s*)+/, "").trim();
      if (!caption || !CITATION_PREVIEW_FILE_PATTERN.test(caption)) continue;

      // Remove only a stand-alone filename directly following this known
      // favicon, not document titles, hyperlinks, or filenames in prose.
      for (let cursor = index + 1; cursor <= captionIndex; cursor++) removed.add(cursor);
      for (let cursor = captionIndex + 1; cursor <= captionIndex + 2
        && cursor < lines.length && isBlankPreviewLine(lines[cursor]); cursor++) {
        removed.add(cursor);
      }
    }
    if (!removed.size) return value;
    return lines.filter((_, index) => !removed.has(index))
      .join(value.includes("\r\n") ? "\r\n" : "\n");
  }

  function stripCitationPreviewHtml(value) {
    return value.replace(/<img\b[^>]*>/gi, (tag) => {
      const source = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      return source && isCitationFaviconUrl(source[1] ?? source[2] ?? source[3]) ? "" : tag;
    });
  }


  function stripTrackingFromUrlValue(value) {
    const htmlAmpersands = /&amp;/i.test(value);
    const parseValue = htmlAmpersands ? value.replace(/&amp;/gi, "&") : value;
    let url;
    try {
      url = new URL(parseValue);
    } catch {
      return value;
    }
    if (!["http:", "https:"].includes(url.protocol)) return value;

    const trackingParameters = [...url.searchParams.keys()]
      .filter((name) => name.toLowerCase().startsWith("utm_"));
    if (!trackingParameters.length) return value;

    trackingParameters.forEach((name) => url.searchParams.delete(name));
    const result = url.href;
    return htmlAmpersands ? result.replace(/&/g, "&amp;") : result;
  }

  function stripTrackingFromText(value) {
    if (typeof value !== "string" || !value) return value;
    return value
      .replace(CONTENT_REFERENCE_PATTERN, "")
      .replace(URL_PATTERN, stripTrackingFromUrlValue);
  }

  function stripMarkdownBold(value) {
    if (typeof value !== "string" || !value) return value;
    return value
      .replace(/\*\*(?=\S)([^\r\n]*?\S)\*\*/g, "$1")
      .replace(/__(?=\S)([^\r\n]*?\S)__/g, "$1");
  }

  function normalizeSmartQuotes(value) {
    if (typeof value !== "string" || !value) return value;
    return value
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  }

  function normalizeMarkdownItalics(value) {
    if (typeof value !== "string" || !value) return value;
    return value.replace(/(^|[^*])\*(?!\*)([^*\r\n]+?)\*(?!\*)/g, "$1_$2_");
  }

  function normalizedCopyOptions(options = {}) {
    if (typeof options === "boolean") {
      return {
        stripTracking: options,
        stripBold: true,
        plainQuotes: true,
        underscoreItalics: true,
      };
    }
    const source = options && typeof options === "object" ? options : {};
    return {
      stripTracking: source.stripTracking !== false,
      stripBold: source.stripBold !== false,
      plainQuotes: source.plainQuotes !== false,
      underscoreItalics: source.underscoreItalics !== false,
    };
  }

  function sanitizeCopiedHtml(value, options = {}, citations = []) {
    if (typeof value !== "string" || !value) return value;
    const settings = normalizedCopyOptions(options);
    let result = stripCitationPreviewHtml(value);
    if (citations.length && typeof DOMParser !== "undefined") {
      const parsed = new DOMParser().parseFromString(result, "text/html");
      const compact = text => text.replace(/\s+/g, "").trim();
      for (const citation of citations) {
        const candidates = [...parsed.body.querySelectorAll("*")].filter(node =>
          !node.closest("a, pre, code") && compact(node.textContent) === compact(citation.text));
        // Replace the outer chip once, keeping all of its additional sources.
        const node = candidates.find(node => !candidates.includes(node.parentElement));
        if (node) {
          const label = citation.text.replace(/\s*\+\s*\d+\s*$/, "").trim();
          node.replaceChildren();
          citation.urls.forEach((url, index) => {
            if (index) node.append(" ");
            const anchor = parsed.createElement("a");
            anchor.href = url;
            anchor.textContent = index ? new URL(url).hostname : label;
            node.append(anchor);
          });
        }
      }
      result = parsed.body.innerHTML;
    }
    if (settings.stripBold) {
      result = result.replace(/<\/?(?:strong|b)\b[^>]*>/gi, "");
    }
    if (settings.underscoreItalics) {
      result = result
        .replace(/<(?:em|i)\b[^>]*>/gi, "_")
        .replace(/<\/(?:em|i)>/gi, "_");
    }
    if (settings.plainQuotes) result = normalizeSmartQuotes(result);
    if (settings.stripTracking) result = stripTrackingFromText(result);
    result = result.replace(/(\bhref=["'])github\.com\//gi, "$1https://github.com/");
    return result;
  }

  function normalizeReferenceLabel(label) {
    return label.trim().replace(/\s+/g, " ").toLowerCase();
  }

  function convertReferenceLinksToInlineMarkdown(value) {
    if (typeof value !== "string" || !value) return value;

    const lineEnding = value.includes("\r\n") ? "\r\n" : "\n";
    const lines = value.split(/\r?\n/);
    const definitions = new Map();

    lines.forEach((line, index) => {
      const match = line.match(
        /^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|(\S+))(?:[ \t]+(?:"([^"\r\n]*)"|'([^'\r\n]*)'|\(([^)\r\n]*)\)))?[ \t]*$/,
      );
      if (!match) return;

      const label = normalizeReferenceLabel(match[1]);
      if (!label || definitions.has(label)) return;
      const wrappedDestination = match[2] != null;
      definitions.set(label, {
        destination: wrappedDestination ? `<${match[2]}>` : match[3],
        title: match[4] ?? match[5] ?? match[6] ?? "",
        lineIndex: index,
      });
    });

    if (!definitions.size) return value;

    const usedDefinitions = new Set();
    const convertedLines = lines.map((line) => line.replace(
      /(!?)\[([^\]\r\n]+)\]\[([^\]\r\n]*)\]/g,
      (match, imagePrefix, text, referenceLabel) => {
        const label = normalizeReferenceLabel(referenceLabel || text);
        const definition = definitions.get(label);
        if (!definition) return match;

        usedDefinitions.add(label);
        const title = definition.title
          ? ` "${definition.title.replace(/"/g, '\\"')}"`
          : "";
        return `${imagePrefix}[${text}](${definition.destination}${title})`;
      },
    ));

    if (!usedDefinitions.size) return value;

    return convertedLines
      .filter((_, index) => {
        for (const label of usedDefinitions) {
          if (definitions.get(label)?.lineIndex === index) return false;
        }
        return true;
      })
      .join(lineEnding);
  }

  function restoreCopiedCitations(value, citations = []) {
    let cursor = 0;
    for (const { text, urls } of citations) {
      if (!text || !urls.length) continue;
      const label = text.replace(/\s*\+\s*\d+\s*$/, "").trim();
      const links = urls.map((url, index) => {
        const title = index ? new URL(url).hostname : label;
        return `[${title.replace(/([\\[\]])/g, "\\$1")}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
      }).join(" ");
      // Native copy emits chips on their own lines, including the +N count.
      // Do not turn ordinary mentions of the publisher in prose into links.
      const escapeLabel = label.split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
      const count = text.match(/\+\s*(\d+)\s*$/)?.[1];
      const pattern = escapeLabel + (count ? `\\s*\\+\\s*${count}` : "");
      const expression = new RegExp(`(^|\\n)[ \\t]*${pattern}[ \\t]*(?=\\r?$|\\n)${count ? "" : "(?!\\r?\\n[ \\t]*\\+\\s*\\d+)"}`, "m");
      const tail = value.slice(cursor);
      const match = expression.exec(tail);
      if (!match) continue;
      const start = cursor + match.index;
      const replacement = match[1] + links;
      value = value.slice(0, start) + replacement + value.slice(start + match[0].length);
      cursor = start + replacement.length;
    }
    return value;
  }

  function sanitizeCopiedText(value, options = {}, citations = []) {
    const settings = normalizedCopyOptions(options);
    let result = stripCitationPreviewThumbnails(convertReferenceLinksToInlineMarkdown(restoreCopiedCitations(value, citations)));
    if (settings.stripBold) result = stripMarkdownBold(result);
    if (settings.underscoreItalics) result = normalizeMarkdownItalics(result);
    if (settings.plainQuotes) result = normalizeSmartQuotes(result);
    if (settings.stripTracking) result = stripTrackingFromText(result);
    result = result.replace(/(\]\()github\.com\//gi, "$1https://github.com/");
    return result;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      stripTrackingFromUrlValue,
      stripTrackingFromText,
      stripMarkdownBold,
      normalizeSmartQuotes,
      normalizeMarkdownItalics,
      convertReferenceLinksToInlineMarkdown,
      stripCitationPreviewThumbnails,
      stripCitationPreviewHtml,
      sanitizeCopiedText,
      sanitizeCopiedHtml,
      restoreCopiedCitations,
    };
    return;
  }

  function attributeEnabled(name) {
    return document.documentElement?.getAttribute(name) !== "false";
  }

  function trackingRemovalEnabled() {
    return attributeEnabled(STRIP_UTM_TRACKING_ATTR);
  }

  function copyFormattingOptions() {
    return {
      stripTracking: trackingRemovalEnabled(),
      stripBold: attributeEnabled(STRIP_COPIED_BOLD_ATTR),
      plainQuotes: attributeEnabled(NORMALIZE_COPIED_QUOTES_ATTR),
      underscoreItalics: attributeEnabled(UNDERSCORE_COPIED_ITALICS_ATTR),
    };
  }

  function patchMethod(target, name, createReplacement) {
    const original = target?.[name];
    if (typeof original !== "function") return;
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        writable: true,
        value: createReplacement(original),
      });
    } catch {
      // Leave the native behavior untouched if this browser does not allow patching it.
    }
  }

  patchMethod(window, "open", (original) => function open(url, ...args) {
    let value = url;
    if (trackingRemovalEnabled()) {
      if (typeof url === "string") {
        value = stripTrackingFromUrlValue(url);
      } else if (typeof URL !== "undefined" && url instanceof URL) {
        value = stripTrackingFromUrlValue(url.href);
      }
    }
    return original.call(this, value, ...args);
  });

  const clipboard = navigator.clipboard;
  let copiedCitations = [];
  document.addEventListener?.("click", (event) => {
    copiedCitations = [];
    const button = event.target?.closest?.('button, [role="button"], [data-d-component="pressable"]');
    if (!button || !(button.matches('[data-testid="copy-turn-btn"]')
        || /^(?:Copy|Copy response)$/i.test(button.getAttribute("aria-label") || button.textContent.trim()))) return;
    if (button.closest("pre")) return;
    const turn = button.closest('article, [data-testid^="conversation-turn-"], [data-turn="assistant"], [data-dil-message-id]');
    if (!turn) return;
    for (const chip of turn.querySelectorAll('[data-d-component="popover-trigger"]')) {
      chip.dispatchEvent(new Event("ghrc-resolve-citation-url", { bubbles: true }));
      try {
        const urls = JSON.parse(chip.getAttribute("data-ghrc-citation-urls") || "[]");
        if (urls.length) copiedCitations.push({ text: chip.innerText || chip.textContent, urls });
      } catch { /* Unresolved citations retain the native copy output. */ }
    }
  }, true);
  window.addEventListener?.("copy", (event) => {
    if (!copiedCitations.length || !event.clipboardData) return;
    const citations = copiedCitations;
    copiedCitations = [];
    const selection = window.getSelection();
    const field = document.activeElement;
    const text = event.clipboardData.getData("text/plain")
      || (typeof field?.value === "string" && field.selectionStart != null
        ? field.value.slice(field.selectionStart, field.selectionEnd) : selection?.toString());
    if (!text) return;
    let html = event.clipboardData.getData("text/html");
    if (!html && selection?.rangeCount) {
      const container = document.createElement("div");
      container.append(selection.getRangeAt(0).cloneContents());
      html = container.innerHTML;
    }
    const options = copyFormattingOptions();
    event.clipboardData.setData("text/plain", sanitizeCopiedText(text, options, citations));
    if (html) event.clipboardData.setData("text/html", sanitizeCopiedHtml(html, options, citations));
    event.preventDefault();
  });
  const clipboardPrototype = typeof Clipboard !== "undefined"
    ? Clipboard.prototype
    : (clipboard && Object.getPrototypeOf(clipboard));

  if (clipboardPrototype) {
    patchMethod(clipboardPrototype, "writeText", (original) => function writeText(text) {
      const citations = copiedCitations;
      copiedCitations = [];
      const value = sanitizeCopiedText(String(text), copyFormattingOptions(), citations);
      return original.call(this, value);
    });

    if (typeof ClipboardItem !== "undefined" && typeof Blob !== "undefined") {
      patchMethod(clipboardPrototype, "write", (original) => function write(items) {
        try {
          const options = copyFormattingOptions();
          const citations = copiedCitations;
          copiedCitations = [];
          const sanitizedItems = Array.from(items, (item) => {
            const data = {};
            for (const type of item.types) {
              const blob = item.getType(type);
              if (type === "text/plain") {
                data[type] = blob.then(async (value) => new Blob(
                  [sanitizeCopiedText(await value.text(), options, citations)],
                  { type: value.type || type },
                ));
              } else if (type === "text/html") {
                data[type] = blob.then(async (value) => new Blob(
                  [sanitizeCopiedHtml(await value.text(), options, citations)],
                  { type: value.type || type },
                ));
              } else {
                data[type] = blob;
              }
            }
            const itemOptions = item.presentationStyle
              ? { presentationStyle: item.presentationStyle }
              : undefined;
            return new ClipboardItem(data, itemOptions);
          });
          return original.call(this, sanitizedItems);
        } catch {
          return original.call(this, items);
        }
      });
    }
  }
})();
