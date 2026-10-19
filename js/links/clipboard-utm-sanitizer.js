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
          if (citation.kind === "item") {
            const anchor = parsed.createElement("a");
            anchor.href = citation.urls[0];
            anchor.textContent = citation.text.trim();
            node.replaceChildren(anchor);
            continue;
          }
          let separator = node.previousSibling;
          while (separator && !separator.textContent.trim()) separator = separator.previousSibling;
          if (separator && separator.textContent.trim() === "·") {
            let preceding = separator.previousSibling;
            while (preceding && !preceding.textContent.trim()) preceding = preceding.previousSibling;
            if (preceding?.nodeType === 1 && (preceding.matches("a[href]") || preceding.querySelector("a[href]"))) separator.remove();
          }
          const list = parsed.createElement("ul");
          list.style.marginTop = "0";
          list.style.marginBottom = "0";
          citation.urls.forEach((url, index) => {
            const item = parsed.createElement("li");
            const anchor = parsed.createElement("a");
            anchor.href = url;
            anchor.textContent = citation.titles?.[index] || (index ? new URL(url).hostname : label);
            item.append(anchor);
            list.append(item);
          });
          node.replaceWith(list);
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
    for (const { text, urls, titles, kind } of citations) {
      if (!text || !urls.length) continue;
      if (kind === "item") {
        const label = text.trim();
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const expression = new RegExp(`(^|\\n)([ \\t]{0,3}(?:#{1,6}[ \\t]+|[-*+][ \\t]+)?(?:\\*\\*|__)?)(?:${escaped})((?:\\*\\*|__)?[ \\t]*)(?=\\r?$|\\n)`, "m");
        const match = expression.exec(value.slice(cursor));
        if (!match) continue;
        const link = `[${label.replace(/([\\[\]])/g, "\\$1")}](${urls[0].replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
        const start = cursor + match.index;
        const replacement = match[1] + match[2] + link + match[3];
        value = value.slice(0, start) + replacement + value.slice(start + match[0].length);
        cursor = start + replacement.length;
        continue;
      }
      const label = text.replace(/\s*\+\s*\d+\s*$/, "").trim();
      const links = urls.map((url, index) => {
        const title = titles?.[index] || (index ? new URL(url).hostname : label);
        return `- [${title.replace(/([\\[\]])/g, "\\$1")}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
      }).join(value.includes("\r\n") ? "\r\n" : "\n");
      // Native copy emits chips on their own lines, including the +N count.
      // Do not turn ordinary mentions of the publisher in prose into links.
      const escapeLabel = label.split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
      const count = text.match(/\+\s*(\d+)\s*$/)?.[1];
      const pattern = escapeLabel + (count ? `\\s*\\+\\s*${count}` : "");
      const ending = value.includes("\r\n") ? "\r\n" : "\n";
      // The middle dot separated the original link and inline citation chip.
      // The citation is now a list, so that decorative separator has no role.
      const separator = new RegExp(`(\\]\\([^\\r\\n]*?\\)|\\]\\[[^\\]\\r\\n]*\\])[ \\t]*·[ \\t]*(?:\\r?\\n[ \\t]*)*(?=${pattern}[ \\t]*(?:\\r?$|\\n))`, "gm");
      value = value.slice(0, cursor) + value.slice(cursor).replace(separator, (_, link) => link + ending);
      const expression = new RegExp(`(^|(?:\\r?\\n[ \\t]*)+)[ \\t]*${pattern}[ \\t]*(?=\\r?$|\\n)${count ? "" : "(?!\\s*\\+\\s*\\d+)"}(?:\\r?\\n[ \\t]*)*`, "m");
      const tail = value.slice(cursor);
      const match = expression.exec(tail);
      if (!match) continue;
      const start = cursor + match.index;
      const before = Math.min(2, (match[1].match(/\n/g) || []).length);
      const trailing = match[0].match(/(?:\r?\n[ \t]*)+$/)?.[0] || "";
      const after = Math.min(2, (trailing.match(/\n/g) || []).length);
      const replacement = ending.repeat(before) + links + ending.repeat(after);
      value = value.slice(0, start) + replacement + value.slice(start + match[0].length);
      cursor = start + replacement.length;
    }
    return value;
  }

  function sanitizeCopiedText(value, options = {}, citations = []) {
    if (typeof value !== "string" || !value) return value;
    const settings = normalizedCopyOptions(options);
    // Some rich-text serializers expose encoded spaces in their Markdown output.
    const decoded = value.replace(/&#(?:x0*20|0*32);/gi, " ");
    let result = stripCitationPreviewThumbnails(convertReferenceLinksToInlineMarkdown(restoreCopiedCitations(decoded, citations)));
    // Native card copies can prefix stand-alone links with two spaces. Keep
    // their lines flush left without changing list nesting or indented code.
    let fence = null;
    result = result.split(/(?<=\n)/).map(line => {
      const marker = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        return line;
      }
      if (fence) return line;
      return line.replace(/^ {1,3}(?=\[[^\]\r\n]+\]\(https?:\/\/)/, "");
    }).join("");
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
  const sourceControlSelector = '[data-d-component="popover-trigger"], [data-d-component="pressable"]';
  function sourceControls(parent) {
    return [...parent.querySelectorAll(sourceControlSelector)].filter(control => {
      const item = !control.matches('[data-d-component="popover-trigger"]');
      if (item && /^(?:Copy|Copy response|Share|More actions|Sources|Read aloud)$/i.test(control.getAttribute("aria-label") || control.textContent.trim())) return false;
      control.dispatchEvent(new Event(item ? "ghrc-resolve-item-url" : "ghrc-resolve-citation-url", { bubbles: true }));
      return control.hasAttribute("data-ghrc-citation-url");
    });
  }
  // Writing cards sometimes serialize their HTML document as text/plain.
  // Convert only that card's Copy action; selections and code copies keep
  // their native representation.
  let copyingWritingBlock = false;
  function writingMarkdown(value, enabled) {
    if (!enabled || !/^\s*(?:<!doctype html[^>]*>\s*)?<html[\s>]/i.test(value)
        || typeof TurndownService === "undefined") return value;
    const root = new DOMParser().parseFromString(value, "text/html").body;
    const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "_" });
    converter.use(turndownPluginGfm.gfm);
    converter.addRule("writing-task-checkbox", {
      filter: node => node.nodeName === "INPUT" && node.type === "checkbox",
      replacement: (_, node) => node.checked || node.hasAttribute("checked") ? "[x] " : "[ ] ",
    });
    converter.addRule("writing-github-link", {
      filter: node => node.nodeName === "A" && /^https?:\/\/github\.com\//i.test(node.getAttribute("href") || ""),
      replacement: (_, node) => node.getAttribute("href"),
    });
    return converter.turndown(root);
  }
  let copiedCitations = [];
  const nativeCopies = new WeakMap();
  document.addEventListener?.("copy", (event) => {
    if (copiedCitations.length && event.clipboardData) {
      nativeCopies.set(event.clipboardData, copiedCitations);
      copiedCitations = [];
    }
  }, true);
  if (typeof DataTransfer !== "undefined") {
    patchMethod(DataTransfer.prototype, "setData", (original) => function setData(type, value) {
      const citations = nativeCopies.get(this);
      if (citations) {
        if (type.toLowerCase() === "text/plain") value = sanitizeCopiedText(value, copyFormattingOptions(), citations);
        if (type.toLowerCase() === "text/html") value = sanitizeCopiedHtml(value, copyFormattingOptions(), citations);
      }
      return original.call(this, type, value);
    });
  }
  document.addEventListener?.("click", (event) => {
    copiedCitations = [];
    copyingWritingBlock = false;
    const button = event.target?.closest?.('button, [role="button"], [data-d-component="pressable"]');
    if (!button || !(button.matches('[data-testid="copy-turn-btn"]')
        || /^(?:Copy|Copy response)$/i.test(button.getAttribute("aria-label") || button.textContent.trim()))) return;
    if (button.closest("pre")) return;
    copyingWritingBlock = Boolean(button.closest("[data-oai-writing-block-surface]"));
    let turn = button.closest('article, [data-testid^="conversation-turn-"], [data-turn="assistant"], [data-dil-message-id]');
    if (!turn || !sourceControls(turn).length) {
      // DIL places the toolbar outside its message element. Find the smallest
      // common container with citations and exactly this response's Copy control.
      turn = null;
      for (let parent = button.parentElement; parent && !parent.matches("main, body"); parent = parent.parentElement) {
        const copies = [...parent.querySelectorAll('button, [role="button"]')].filter(control =>
          !control.closest("pre") && /^(?:Copy|Copy response)$/i.test(control.getAttribute("aria-label") || control.textContent.trim()));
        if (copies.length > 1) break;
        if (sourceControls(parent).length) { turn = parent; break; }
      }
    }
    if (!turn) return;
    for (const chip of sourceControls(turn)) {
      const item = !chip.matches('[data-d-component="popover-trigger"]');
      try {
        const urls = JSON.parse(chip.getAttribute("data-ghrc-citation-urls") || "[]");
        const sources = JSON.parse(chip.getAttribute("data-ghrc-citation-sources") || "[]");
        if (urls.length) copiedCitations.push({ text: chip.innerText || chip.textContent, urls,
          kind: item ? "item" : "citation",
          titles: urls.map(url => sources.find(source => source.url === url)?.title || "") });
      } catch { /* Unresolved citations retain the native copy output. */ }
    }
  }, true);
  window.addEventListener?.("copy", (event) => {
    const citations = event.clipboardData && nativeCopies.get(event.clipboardData);
    if (!citations?.length) return;
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
      const writing = copyingWritingBlock;
      copyingWritingBlock = false;
      const value = sanitizeCopiedText(writingMarkdown(String(text), writing), copyFormattingOptions(), citations);
      return original.call(this, value);
    });

    if (typeof ClipboardItem !== "undefined" && typeof Blob !== "undefined") {
      patchMethod(clipboardPrototype, "write", (original) => function write(items) {
        try {
          const options = copyFormattingOptions();
          const citations = copiedCitations;
          copiedCitations = [];
          const writing = copyingWritingBlock;
          copyingWritingBlock = false;
          const sanitizedItems = Array.from(items, (item) => {
            const data = {};
            for (const type of item.types) {
              const blob = item.getType(type);
              if (type === "text/plain") {
                data[type] = blob.then(async (value) => new Blob(
                  [sanitizeCopiedText(writingMarkdown(await value.text(), writing), options, citations)],
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
