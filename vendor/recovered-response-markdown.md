Bundled Markdown rendering dependencies for js/missing-response-recovery.js:

- Showdown 2.1.0 (MIT): https://github.com/showdownjs/showdown/tree/2.1.0
- DOMPurify 3.4.17 (Apache-2.0 OR MPL-2.0): https://github.com/cure53/DOMPurify/tree/3.4.17

Both are loaded locally in MAIN before the recovery script. Sanitization uses an explicit HTML tag/attribute allowlist; the renderer falls back to plain text if either library is unavailable.
