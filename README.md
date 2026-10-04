# Flawless ChatGPT

A Brave/Chrome extension that adds a GitHub-style repository dashboard directly
below the composer on ChatGPT's new-chat page, with optional ChatGPT interface
tweaks.

The dashboard:

- shows seven ranked repositories in each account column;
- labels account columns with their GitHub profile display names;
- starts with no accounts configured, so every installation is personal to its
  user;
- loads public repositories for any configured GitHub users or organizations;
- can independently hide the repository search bar or repository total;
- optionally hides the dictation microphone, compacts the new-chat heading, or
  disables ChatGPT Work mode;
- strips UTM tracking parameters from links shown by ChatGPT by default;
- can skip ChatGPT's external-site warning and dismiss its history rate-limit
  modal independently;
- queues follow-up messages locally while ChatGPT is responding, keeps them editable and reorderable, and sends them FIFO only after the active response fully completes;
- adds columns for any other GitHub accounts the connected tokens can access;
- pins important repositories at the top of their user or organization column;
- searches across every loaded repository; and
- combines recent repository activity with locally tracked opening frequency to
  personalize the order.

## Artwork ✨

Extension icon and settings artwork by [Squeaky_Belle](https://disqus.com/by/Squeaky_Belle),
from the provided [source post](https://x.com/Squeaky_Belle/status/1855267207577731504).

Spellcheck Only launcher artwork by Kiriya, from the [source image](https://derpibooru.org/images/3394656).

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome or `brave://extensions` in Brave.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose this repository's folder.
5. In the setup page that opens, add a fine-grained GitHub token, public
   GitHub accounts, or both.
6. Open or refresh [ChatGPT](https://chatgpt.com/).

After setup, click the extension icon in the browser toolbar to open the compact
settings menu. Select **Full settings** there whenever you want the standalone
settings page with the complete layout and artwork.

Without a token, the extension displays public repositories from the accounts
entered in settings. With one or more tokens, it also displays every repository
those tokens can access. Token labels are local identifiers; repository access
comes from each token's GitHub settings. Tokens and GitHub accounts can be
added, removed, or reordered at any time. Existing single-token settings are
migrated automatically. Use a fine-grained token with read-only access to only
the repository metadata the extension should display.

### GitHub App login

Connect GitHub opens the Flawless ChatGPT app's browser authorization page and returns to the extension automatically. Choose repositories to install the app on a personal account or organization and select its repository access.

The small local login service exchanges GitHub's authorization code; the extension stores the resulting session in its encrypted browser vault. The service listens only on `127.0.0.1:8787`, accepts the configured extension identity, and keeps access tokens out of redirect URLs.

To configure it on macOS:

1. In the app settings, set the callback URL to `http://127.0.0.1:8787/github/callback` and generate a client secret. App settings: https://github.com/settings/apps/flawless-chatgpt
2. Run `swift auth/configure-secret.swift` and paste the secret into the secure local dialog. It saves the credential in macOS Keychain; do not put it in the repository or extension settings.
3. Run `python3 auth/install.py` to install the login service, which starts automatically at login. Run the installer again after changing the Keychain credential to restart it.
4. Reload the extension and select Connect GitHub.

The login service automatically derives this checkout's extension ID using Chromium's algorithm, including a public manifest key when present. No extension ID is needed during normal setup. After moving the checkout, rerun `python3 auth/install.py` to update the service's launch path and restart it. For additional installations, repeat `--extension-id YOUR_EXTENSION_ID`, or set `GITHUB_APP_EXTENSION_IDS` to a comma-separated list when starting the service manually. These add to the automatically detected identity. The server also accepts `GITHUB_APP_CLIENT_SECRET` from its environment for non-Keychain setups. Existing device-flow sessions can still refresh; new connections use browser authorization.

To stop and remove the local service, run `launchctl bootout gui/$(id -u)/com.flawless-chatgpt.auth` and delete `~/Library/LaunchAgents/com.flawless-chatgpt.auth.plist`. This retains the Keychain credential and browser session.

### ChatGPT / Codex personalization

Flawless ChatGPT can keep a browser-local copy of the Custom Instructions text you use on ChatGPT web and mirror the same managed block into `~/.codex/AGENTS.md` for the Codex VS Code extension. The "Sync from ChatGPT web" button reads only the clipboard after you click it.

The Codex Web co-author toggle adds the managed instruction requiring `Co-authored-by: Codex Web <noreply@openai.com>` for commits created through web or GitHub tools. The optional PGP field sends the secret only to the local native bridge; the bridge imports it into GnuPG through stdin, stores only the public fingerprint in Git configuration, and clears the browser field after import.

Use "Set up local bridge" in extension settings to install the native bridge without linking a research repository. The settings-only installer preserves an existing research-publisher repository configuration.

### Token storage

GitHub token values are encrypted with AES-GCM before being written to
`chrome.storage.local`. The AES key is generated by Web Crypto as a
non-extractable `CryptoKey` and stored separately in the extension's IndexedDB
vault. Existing plaintext `githubToken` and `githubTokens` settings are migrated
to encrypted storage automatically and the plaintext values are removed.

Both IndexedDB and `chrome.storage.local` belong to the installed extension's
browser profile, so normal updates and extension reloads keep the key and the
encrypted tokens. Removing the extension, changing its installed identity, or
clearing its site/storage data can remove the vault key and require the tokens to
be entered again.

This protects tokens from being left as immediately readable plaintext in the
extension's local-storage record. It is not an operating-system keychain: code
running with access to the extension's privileged browser context can still ask
the non-extractable key to decrypt the values. Use fine-grained, read-only tokens
with the minimum repository access needed.

### Updating an unpacked installation

To update an unpacked copy without losing the encrypted token vault:

1. Keep the existing extension installed in Chrome or Brave.
2. Update or replace the extension files in the same local folder, for example
   with `git pull`.
3. Open `chrome://extensions` or `brave://extensions` and select **Reload** for
   the existing extension.
4. Refresh ChatGPT so the updated content scripts are loaded.

Do not remove the extension and then load it again just to update it. Removing an
extension can clear its browser-owned local storage and IndexedDB, including the
encryption key needed to decrypt saved tokens. Reloading the existing unpacked
extension preserves its installed identity and persistent storage during normal
updates.

UTM tracking removal, the external-site warning bypass, and history rate-limit
modal dismissal are separate settings enabled by default. **Hide dictation
microphone**, **Compact new-chat header**, and **Disable Work mode** are disabled
by default. UTM removal strips `utm_*` query parameters while preserving other
query parameters and URL fragments. When Work mode is disabled, the extension
switches an available Work selector back to Chat, hides Work controls, and blocks
their selection. The external-site setting clicks ChatGPT's own **Open link**
confirmation when the exact external-site dialog appears. The history setting
hides the known conversation-history rate-limit modal, clears the page locks it
leaves behind, and preserves native wheel and touch scrolling if stale modal
listeners remain. The extension does not perform a cross-origin request to the
destination itself.

## Queued messages

Use the stack-plus button beside ChatGPT's composer to queue the current draft. While ChatGPT is already responding, pressing **Enter** also adds the draft to the queue instead of interrupting the active response; **Shift+Enter** still inserts a newline. Pending messages appear directly above the composer and can be edited, reordered, or removed before they are sent.

Queues are stored in `chrome.storage.local` per conversation, so pending text survives page reloads and normal extension updates. A queue created during the first response of a new chat is migrated to that conversation once ChatGPT assigns its `/c/...` URL. Navigating away leaves that conversation's queue stored locally until the conversation is opened again.

Automatic sending deliberately does **not** rely on a quiet DOM or the end of ChatGPT's thinking phase. The next item is eligible only when the stop/generation control is gone, the normal send control is ready, user and assistant turns are balanced, the latest assistant turn exposes a completed-response action, and that completed state remains stable for a short settle window. This prevents the queue from firing in the transition between thinking and answer generation.

## Deep research publisher

**Deep research publisher** is off by default in both settings views. Enabling it
adds an **Add to repo** icon immediately left of the download/export control on
completed deep research reports, including the embedded report card. Clicking it
opens an import launcher where you can choose an existing category, enter a new
category (including nested folders), or leave it empty for the repository root.
Only **Import report** captures the full report as Markdown and commits and
pushes it to the chosen category in the linked repository. Cancel leaves the
repository unchanged. Report links open in a new browser tab, and expanding a
report hides the chat composer until the report is collapsed.

Use **Link repository** in settings for the one-time macOS setup. The page supplies
an installer command for your extension ID and browser (Chrome or Brave). Run it
from this extension's folder and select the local research repository. Python 3,
Git, an origin remote, a Git author, and working push access are required. Use
**Check connection** to see the destination repository and branch. The installer
pins the current branch; link again to change it. Existing app-only connections
must run the updated installer and select the app's repository folder.
For Brave, the installer also creates a compatibility link in Chrome's native-host
folder when no publisher registration already exists there.

The button preserves headings, links, lists, and tables from the report. It reads
the full report pages, including text clipped by the preview, rather than the
surrounding chat. The report widget's DOM must be loaded; this integration targets
the current research widget and may need updating if ChatGPT changes its markup.

Publishing uses a temporary bare clone of the remote branch and a separate Git
index. Local files, staged changes, and the checkout's branch are untouched.
Filenames include a stable suffix based on the conversation and report title;
retrying an identical report produces no additional commit. Concurrent remote
updates or branch restrictions cause a visible error, never a force-push. The
button reports success only after Git confirms the push (or the same content is
already on the remote). Failed attempts can be retried from the report.

The bridge uses Chrome's [native messaging protocol](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
It accepts reports only from this extension's research-frame content script and
uses the repository selected locally, not a path supplied by the webpage. GitHub
dashboard tokens are not sent to the bridge. Turn the checkbox off to remove the
buttons. To uninstall the connection, remove `org.research.publisher.json` from
your browser's `NativeMessagingHosts` folder under `~/Library/Application Support`
and the corresponding browser folder under `~/Library/Application Support/Research Publisher`.
For Brave, also remove the compatibility link at
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/org.research.publisher.json`
if it points to Brave's registration.

Markdown conversion bundles Turndown 7.2.0 and turndown-plugin-gfm 1.0.2 in
`vendor/`, with their MIT license files. Their npm distribution integrity hashes
were checked when vendoring.

## Pins

Select **Pin** beside any repository on the dashboard or in search results to
keep it visible at the top of its account column. Pinned repositories remain
visible even when an account has more than seven repositories. Open the extension
settings menu to drag pins into a preferred order, move them with the arrow
buttons, or remove them.

## Ranking

Unpinned repository order uses a weighted score:

- 60% recent GitHub activity, with older activity gradually fading;
- 27% the number of times a repository was opened from this dashboard; and
- 13% how recently it was opened from this dashboard.

Usage history stays in the extension's local browser storage. GitHub token
ciphertext stays there as well, while its non-extractable encryption key is kept
in the extension's IndexedDB vault. Tokens are decrypted only when the extension
needs to load settings or authenticate to GitHub's API.

Press **Alt+R** on the new-chat page to focus the repository search field.
