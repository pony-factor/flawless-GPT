(() => {
  const STRIP_UTM_TRACKING_ATTR = "data-ghrc-strip-utm-tracking";
  const STRIP_COPIED_BOLD_ATTR = "data-ghrc-strip-copied-bold";
  const NORMALIZE_COPIED_QUOTES_ATTR = "data-ghrc-normalize-copied-quotes";
  const UNDERSCORE_COPIED_ITALICS_ATTR = "data-ghrc-underscore-copied-italics";
  const URL_PATTERN = /https?:\/\/[^\s<>"'`\])}]+/gi;
  const CONTENT_REFERENCE_PATTERN = /:chatgpt-content-reference\{[^}\r\n]*\}/g;

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

  function sanitizeCopiedHtml(value, options = {}) {
    if (typeof value !== "string" || !value) return value;
    const settings = normalizedCopyOptions(options);
    let result = value;
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

  function sanitizeCopiedText(value, options = {}) {
    const settings = normalizedCopyOptions(options);
    let result = convertReferenceLinksToInlineMarkdown(value);
    if (settings.stripBold) result = stripMarkdownBold(result);
    if (settings.underscoreItalics) result = normalizeMarkdownItalics(result);
    if (settings.plainQuotes) result = normalizeSmartQuotes(result);
    if (settings.stripTracking) result = stripTrackingFromText(result);
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
      sanitizeCopiedText,
      sanitizeCopiedHtml,
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
  const clipboardPrototype = typeof Clipboard !== "undefined"
    ? Clipboard.prototype
    : (clipboard && Object.getPrototypeOf(clipboard));

  if (clipboardPrototype) {
    patchMethod(clipboardPrototype, "writeText", (original) => function writeText(text) {
      const value = sanitizeCopiedText(String(text), copyFormattingOptions());
      return original.call(this, value);
    });

    if (typeof ClipboardItem !== "undefined" && typeof Blob !== "undefined") {
      patchMethod(clipboardPrototype, "write", (original) => function write(items) {
        try {
          const options = copyFormattingOptions();
          const sanitizedItems = Array.from(items, (item) => {
            const data = {};
            for (const type of item.types) {
              const blob = item.getType(type);
              if (type === "text/plain") {
                data[type] = blob.then(async (value) => new Blob(
                  [sanitizeCopiedText(await value.text(), options)],
                  { type: value.type || type },
                ));
              } else if (type === "text/html") {
                data[type] = blob.then(async (value) => new Blob(
                  [sanitizeCopiedHtml(await value.text(), options)],
                  { type: value.type || type },
                ));
              } else {
                data[type] = blob;
              }
            }
            const options = item.presentationStyle
              ? { presentationStyle: item.presentationStyle }
              : undefined;
            return new ClipboardItem(data, options);
          });
          return original.call(this, sanitizedItems);
        } catch {
          return original.call(this, items);
        }
      });
    }
  }
})();
