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
- optionally hides the dictation microphone, compacts the new-chat heading (enabled
  by default), or disables ChatGPT Work mode and manual web Search mode;
- wraps long ChatGPT response text, links, and code by default, with a Display
  preference to restore native horizontal overflow;
- strips UTM tracking parameters from links shown by ChatGPT by default;
- can skip ChatGPT's external-site warning and dismiss its history rate-limit
  modal independently;
- hides ChatGPT's usage remaining / credits card by default;
- queues follow-up messages locally while ChatGPT is responding, keeps them editable and reorderable, and sends them FIFO only after the active response fully completes;
- adds columns for any other GitHub accounts the connected tokens can access;
- pins important repositories at the top of their user or organization column;
- searches across every loaded repository, with an optional **+ Custom repo** button
  to add or remove specific `owner/repository` search overrides even when the
  normal index misses them (GitHub access is verified before saving; overrides
  are stored locally and do not affect dashboard account rankings); and
- combines recent repository activity with locally tracked opening frequency to
  personalize the order.

## Artwork ✨

Extension icon and settings artwork by [Squeaky_Belle](https://disqus.com/by/Squeaky_Belle),
from the provided [source post](https://x.com/Squeaky_Belle/status/1855267207577731504).

Spellcheck Only launcher artwork by Kiriya, from the [source image](https://derpibooru.org/images/3394656).

Work-duration cannon artwork by Cerberus (`@fcolumnare`), from the
[original artwork post](https://x.com/fcolumnare/status/1952740544443998252).
The bundled `artwork/searching-complete.png` is an AI-assisted transparent cutout
of the cannon, with obscured portions reconstructed, from `love-weapon.jpg`:
https://github.com/JFWooten4/JFWooten4/blob/main/headshots/final-form/love-weapon.jpg
Original artwork credits:
https://github.com/JFWooten4/JFWooten4/blob/main/headshots/final-form/README.md

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

The **Open clipboard URL** button on New Chat also supports local `file:///` links.
For local files, enable **Allow access to file URLs** in Flawless ChatGPT's
`chrome://extensions` or `brave://extensions` details. The local file opens in
the current tab; this feature does not upload its contents.

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

### Web commit personalization

The **Personalization** tab contains one editable **Web commit guidance** field. Flawless stores a local mirror in `chrome.storage.local.webCommitGuidance` and synchronizes it with ChatGPT's account-level Custom Instructions (`about_model_message`) while a signed-in `chatgpt.com` tab is open. Editing either ChatGPT's Personalization setting or the Flawless field updates the other side; no clipboard handoff is involved.

Synchronization uses ChatGPT's own same-origin `/backend-api/user_system_messages` request path from the ChatGPT page. The extension reads the current payload before updating only the model-instruction field so unrelated personalization fields stay intact. Authentication is obtained ephemerally from the active ChatGPT session and is never written into extension storage. On the first sync for an account, ChatGPT's current setting wins so installing or upgrading Flawless cannot silently overwrite existing web personalization. After that, `webCommitGuidanceLastSynced` lets Flawless determine which side changed; local edits made while ChatGPT is closed are pushed the next time ChatGPT opens.

Existing guidance from the older `codexCustomInstructions` / `chatgptCustomInstructions` keys is migrated into `webCommitGuidance`. If the older Codex Web co-author preference was enabled, its trailer instruction is folded into the migrated guidance rather than kept as a separate setting. Personalization never writes `~/.codex/AGENTS.md`, inspects `CODEX_HOME`, imports PGP keys, or changes global Git configuration. Commit signing remains a separate feature.

### Sidebar hover behavior

The sidebar starts collapsed on page load. **ChatGPT → Reveal sidebar on hover**
is off by default. Enable it to reveal the sidebar by holding the mouse in the
leftmost 64 pixels, anywhere from directly below **Library** to the bottom
of the viewport, for 650 milliseconds.

The reveal area covers the entire remaining left rail, even below the last
preset icon or when no preset icons exist. Hovering Library itself or the
left edge above Library does not trigger the reveal.

The sidebar stays open while the mouse is inside it or one of its open menus,
including nested menus and a 12-pixel margin around those menus. It collapses
90 milliseconds after the mouse leaves those areas. Hovering should work
without clicking or giving the browser keyboard focus; moving keyboard focus
away alone should not collapse it. The hover delay also works in visible but
unfocused browser windows when animation frames pause; hidden/background tabs
cannot respond to mouse hover because they are not visible.

### Chat creation ages

Chat history entries show compact creation ages (such as `2d`, `2mo`, or `2y`).
Conversations less than a day old show a small 🆕 icon rather than `0d`.
Hovering the age or icon still reveals the absolute creation date.

### Chat bar colors

Under **ChatGPT → Chat bar colors**, choose independent opt-in colors for the composer background, border, focus ring, typed text, caret, placeholder, selection, toolbar, send/stop buttons, and attachments. Unchecked swatches use ChatGPT's own theme, including dark-mode changes. Colors are stored locally under `composerColors`, update live in open chats, and can all be reset with **Restore ChatGPT colors**.

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

UTM tracking removal, the external-site warning bypass, history rate-limit
modal dismissal, and **Hide usage remaining card** are separate settings enabled by default. **Hide dictation
microphone** and **Disable Work mode** are disabled by default; **Compact new-chat
header** is enabled by default. UTM removal strips `utm_*` query parameters while preserving other
query parameters and URL fragments. When Work mode is disabled, the extension
switches an available Work selector back to Chat, hides Work controls, and blocks
their selection. The external-site setting clicks ChatGPT's own **Open link**
confirmation when the exact external-site dialog appears. **Open links in new
tabs** is enabled by default and keeps external links, including search
references, from replacing the chat. Disable it to reuse the current tab when
warning bypass is enabled. **Open links beside the response** takes precedence
and shows a website preview in a right-hand pane. Close it with **Close** or
**Escape**. Websites or ChatGPT security policies may block embedded previews;
the pane always provides **Open in new tab**. This extension preview is separate
from the browser’s native split-tab view. Modifier clicks keep browser behavior.
The history setting hides the known conversation-history rate-limit modal, clears the page locks it
leaves behind, and preserves native wheel and touch scrolling if stale modal
listeners remain. Link previews load the destination in a sandboxed iframe.

### Browsing GitHub pages inside the sidebar

GitHub prevents other sites from embedding its pages. With **Open links beside the response**
enabled, Flawless instead loads GitHub pages through the GitHub API immediately. It can
display repositories and their root files, individual files (including JSON, Markdown,
source code, and small images), directories, branches, tags, issues, pull requests,
commits, releases, workflow runs, and Discussions. The existing pull-request diff
viewer remains available, with issue/PR comments where GitHub permits access.

GitHub directories and lists include links you can follow **inside the same panel**.
The GitHub pane has Back and Forward controls, a parent-directory link when applicable,
and its usual Copy link and Open in new tab actions for the currently viewed page.
Paths are loaded for the branch or tag in the URL, including ref names containing slashes.

Private pages require a configured GitHub token with appropriate read permissions.
Discussions require authenticated GraphQL access, and some GitHub page types
(such as account settings, interactive Projects interfaces, and unsupported routes)
still require **Open in new tab**. Large or unavailable files give a readable message
instead of displaying corrupt content. File rendering is read-only and treats
remote Markdown as untrusted text; no repository changes are made by this viewer.

### Inline Temporary Chat

On the new-chat page, Flawless places an icon-only **Temporary Chat** button
(a chat bubble with a lock) directly in the composer toolbar, beside the other
input actions. Its accessible label and tooltip explain the action. It uses ChatGPT's existing
Temporary Chat control rather than recreating the mode; any native
**Personalized / Unpersonalized** choice still belongs to ChatGPT. The old
control is hidden only when the inline button is ready. If ChatGPT changes or
removes the native control, Flawless leaves its UI alone instead of claiming
that the chat is temporary. The inline button is not shown in existing saved
conversations, since changing a conversation to temporary is not supported.

**Disable manual web browsing mode**, available in both settings views, hides
ChatGPT's explicit Search tool in the composer and its tool menus. It is off by
default and does not block automatic searches, network requests, or searches
initiated by ChatGPT; it should not be treated as an offline or privacy guarantee.

## Queued messages

Use the stack-plus button beside ChatGPT's composer to queue the current draft. While ChatGPT is already responding, pressing **Enter** also adds the draft to the queue instead of interrupting the active response; **Shift+Enter** still inserts a newline. Pending messages appear directly above the composer and can be edited, reordered, or removed before they are sent.

Queues are stored in `chrome.storage.local` per conversation, so pending text survives page reloads and normal extension updates. A queue created during the first response of a new chat is migrated to that conversation once ChatGPT assigns its `/c/...` URL. Navigating away leaves that conversation's queue stored locally until the conversation is opened again.

Automatic sending deliberately does **not** rely on a quiet DOM or the end of ChatGPT's thinking phase. The next item is eligible only when the stop/generation control is gone, the normal send control is ready, user and assistant turns are balanced, the latest assistant turn exposes a completed-response action, and that completed state remains stable for a short settle window. This prevents the queue from firing in the transition between thinking and answer generation.

## Deep research publisher

**Deep research publisher** is off by default in both settings views. Enabling it
adds an **Add to repo** icon immediately left of the download/export control on
completed deep research reports, including the embedded report card. Clicking it
opens a compact folder picker. Click folders to browse, use the home/up controls
to navigate, or type a new category (including nested folders). **Import to root**
imports immediately to the repository root; **Import report** imports to the
selected category. Both capture the full report as Markdown and commit and push
it to the linked repository. Cancel leaves the
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
already on the remote). Failed attempts can be retried from the report. If an
extension update disconnects an open report, the status asks you to reload the
ChatGPT page before retrying. Research windows retain their import destination
across extension updates and refresh automatically to reconnect. Interrupted
imports resume automatically; temporary bridge or Git failures retry up to three
times. A changed destination still requires choosing it again.

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

Press **Alt+R** on the new-chat page to focus the repository search field by
default. In **Dashboard → Repository search shortcut**, click the shortcut
button and press a key or key combination to replace it (for example, **Del**).
The setting works in both the browser popup and Full settings, updates the
shortcut hint immediately, and includes **Reset** to restore Alt+R. A plain
shortcut key leaves normal typing, deletion, and editing alone while a text
field is active. Browser-reserved keyboard combinations may be unavailable.
