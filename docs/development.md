# Development and architecture

Flawless is a Manifest V3 browser extension with plain JavaScript, CommonJS tests, CSS and optional local helpers. There is no application bundling step required to load the repository as an unpacked extension.

## Runtime entry points

| Entry point | Role |
| --- | --- |
| [manifest.json](../manifest.json) | Declares permissions, content-script worlds and order, extension pages, and web-accessible resources. |
| [js/core/background.js](../js/core/background.js) | Service-worker entry; imports feature workers in dependency order. |
| [js/core/service-worker.js](../js/core/service-worker.js) | GitHub repository loading, owner resolution, cache and dashboard requests. |
| [popup.html](../popup.html), [options.html](../options.html) | Compact and full settings surfaces. |
| [chat-dispatcher.html](../chat-dispatcher.html) | Dispatcher dashboard. |
| [link-preview.html](../link-preview.html) | Extension-owned fallback preview surface. |
| [publisher-setup.html](../publisher-setup.html) | Native research publishing setup. |

ChatGPT content scripts run at document start in both the page's MAIN world and the default isolated extension world. MAIN-world scripts observe page-owned data and interactions, while isolated scripts can access extension APIs and mount UI. Research-frame scripts run inside supported report frames; GitHub has its own targeted content script. Keep privileged work in the appropriate extension context, validate cross-context messages, and never expose credentials to webpage scripts.

The service worker can be suspended and restarted by the browser. Persist durable workflow state in extension storage rather than assuming in-memory state survives. Content scripts also need to cope with client-side route changes, rerendered native controls and extension reloads. See [extension context](../js/core/extension-context.js) and [route events](../js/core/chatgpt-route-events.js).

## Source layout

JavaScript and CSS use feature folders, not a flat directory of prefixed files.

| Area | JavaScript | CSS |
| --- | --- | --- |
| Conversation display and recovery | [js/chat](../js/chat/) | [css/chat](../css/chat/) |
| Input, queue, upload and clipboard | [js/composer](../js/composer/) | [css/composer](../css/composer/) |
| Repository dashboard, issues and highlights | [js/dashboard](../js/dashboard/) | [css/dashboard](../css/dashboard/) |
| Links, previews and image recovery | [js/links](../js/links/) | [css/links](../css/links/) |
| Research launch, tracking and publishing | [js/research](../js/research/) | [css/research](../css/research/) |
| History and sidebar | [js/sidebar](../js/sidebar/) | [css/sidebar](../css/sidebar/) |
| Preferences | [js/settings](../js/settings/) | [css/settings](../css/settings/) |
| Launchers and game | [js/launchers](../js/launchers/), [js/games](../js/games/) | [css/launchers](../css/launchers/), [css/games](../css/games/) |

[GitHub authentication](../js/github/), [dispatcher logic](../js/dispatcher/), [core](../js/core/), [native publisher](../native/), and [local GitHub App login service](../auth/) have distinct responsibilities. The browser extension does not require either optional local helper for public repository browsing. Bundled libraries are in [vendor](../vendor/) with their license material; artwork is in [artwork](../artwork/).

When moving a file, update the manifest, extension HTML references, worker imports, tests and documentation in the same change. Worker import paths are relative to the worker entry point, including imports made by its dependencies.

## State and trust boundaries

- Preferences and local workflow state use browser extension storage; token ciphertext is stored separately from the non-extractable IndexedDB vault key. Removing the extension can destroy that state.
- GitHub read operations use configured access, not the permissions of an arbitrary webpage. The read-only preview is distinct from the optional report publishing workflow.
- The optional local authentication service exchanges GitHub App authorization codes; the native research publisher uses the locally selected Git checkout and existing push access. They are separate integrations.
- The dispatcher persists task reservations and verifies merge evidence against GitHub before assigning another task. Do not bypass its completion or interruption checks.
- Remote HTML, Markdown, images, links and report contents are untrusted. Use existing sanitization, URL validation and sandbox boundaries; do not insert arbitrary page markup or secrets into extension UI.
- Prefer native ChatGPT controls to synthetic implementations of sending, model selection or attachments; do not treat a DOM selector match alone as proof of completion.

## Testing locally

Use Node.js 22 or 24 and Python 3.11 or 3.12 to match CI. From the repository root:

```sh
npm install --no-save --package-lock=false playwright@1.56.1 jsdom@26.1.0
git ls-files -z '*.js' '*.cjs' | xargs -0 -n 1 node --check
node tests/ci/validate-extension.cjs
node --test tests/*.test.cjs
python3 -m compileall -q native
python3 -m unittest discover -s tests -p '*_test.py' -v
```

For browser regressions, install Playwright Chromium and point the browser harness at that executable:

```sh
npx playwright install chromium
export BROWSER_EXECUTABLE="$(node -p 'require("playwright").chromium.executablePath()')"
node --test tests/compact-startup.browser.cjs tests/dashboard-startup.browser.cjs tests/refresh-view.browser.cjs
node --test --test-name-pattern="reasoning policy" tests/chat-display.browser.cjs
node --test tests/external-links.browser.cjs
```

On Linux, browser system dependencies may also be needed (CI uses `npx playwright install --with-deps chromium`). Some harnesses support local Brave or `BRAVE_PATH`; follow the individual test's executable selection when needed. Run the focused feature test as well as the broad suite. Browser fixtures exercise representative DOM and lifecycle behavior; they do not certify that every live ChatGPT layout works.

## Continuous integration

Two workflows run on PRs and pushes to main:

- [Flawless quality gates](../.github/workflows/quality-gates.yml): JavaScript syntax, packaged-resource integrity, Node 22/24 unit tests, Python 3.11/3.12 native-host tests, and Chromium startup and reasoning-policy checks. Queue/composer and highlights/YouTube browser regressions are advisory in this workflow.
- [Extension regression tests](../.github/workflows/regression-tests.yml): full Node unit suite, focused source-image CSP regression, and focused user-message/sidebar-icon regressions. The full external-link browser suite is advisory.

Advisory failures remain visible and should be investigated. Workflow success does not establish which checks a repository branch protection rule requires. Consult the workflow files for the current commands and conditions instead of assuming every browser fixture is run by CI.

## Change checklist

1. Identify the relevant feature folder, settings surface and manifest entry.
2. Update both popup and full settings when a shared preference changes; maintain backward-compatible defaults and migrations.
3. Preserve route, lifecycle and security boundaries; add regression coverage for changed behavior.
4. Run resource validation and the relevant unit/browser tests.
5. Update the user guide and any feature-specific documentation when behavior, permissions, setup, or defaults change.
