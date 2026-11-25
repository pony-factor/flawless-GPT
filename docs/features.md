# Feature guide

Flawless is an unpacked Chromium Manifest V3 extension for ChatGPT and GitHub. It extends the existing web interface rather than replacing ChatGPT or supplying its own model, quota, or account. Open the extension's toolbar popup for quick preferences, or **Full settings** for the standalone settings page.

For initial installation, credentials, and research publishing setup, see the [README](../README.md). For automated multi-chat implementation tasks, see the [chat dispatcher guide](chat-dispatcher.md).

## Dashboard

The dashboard appears on the ChatGPT new-chat page. Configure public GitHub accounts, connect GitHub, or add tokens before expecting repository results. Account names, visibility, and ordering are configurable; the grid has controls for accounts per row and accounts per page. Repository pins take precedence over the normal activity ranking.

| Feature | How to use it |
| --- | --- |
| Repository search | Press Alt+R by default, or set your own shortcut. Search the loaded repository index; optionally enable custom repository search for explicit owner/repository entries. |
| Repository pins | Use Pin on a repository, then reorder or remove pins in settings. |
| Pinned issues | Add a GitHub issue URL under Dashboard → Pinned issues, optionally give it a label, and reorder it. Up to 24 unique issues are supported. Pull request URLs are not issue URLs for this control. These are local shortcuts, not changes to GitHub issues. |
| Highlights | Add an HTTP(S) webpage under Dashboard → Highlights. Edit its display title, refresh its preview, reorder it, or remove it. Preview cards use fetched metadata and available artwork, falling back when a site cannot supply a preview. |
| Dashboard colors | Independently customize light/dark accents and repository names; restore defaults individually or together. |
| YouTube / Wooten link search | The Dashboard settings expose separate launcher switches. These are distinct from repository search. |

Highlights fetch remote content to construct previews. HTTPS is included in the extension's host permissions; HTTP may need an additional site permission. A missing preview does not imply that a website is unavailable in a normal browser tab. Private repository visibility depends on the configured GitHub credentials.

Implementation: [dashboard scripts](../js/dashboard/), [dashboard styles](../css/dashboard/), [settings](../js/settings/).

## Composer and conversation

- **Auto-focus composer:** focuses the input when the supported chat layout is ready. Turn it off if it conflicts with your navigation habits.
- **Preserve scroll position on send:** opt in to keeping your reading position when submitting rather than automatically following the new turn.
- **Composer placeholder and colors:** customize the empty input text and individual color roles in ChatGPT settings. Unset color overrides follow the native theme.
- **Clipboard send:** where enabled, the clipboard prompt action sends or queues clipboard text, rather than opening it as a URL. The separate clipboard URL action opens recognized URLs or runs a browser search. Inspect clipboard contents before invoking either action.
- **File drop:** dropping files on the supported chat interface passes them to ChatGPT's own upload input. Check that attachment chips appear before sending; Flawless reports an unconfirmed attachment instead of assuming upload succeeded.
- **Queue:** queue text during an active response; edit, reorder, or remove pending messages and set the maximum queue height. Queue entries persist per conversation. The visibility setting for the queue button is separate from the queue's lifecycle. A queued send waits for stable completion rather than merely detecting a quiet page.
- **Temporary Chat:** the inline toolbar button invokes ChatGPT's own mode on the new-chat page; it does not convert an existing conversation or change ChatGPT's retention rules.
- **Reasoning controls:** the high-thinking policy and one-shot Extra High send use the native model and effort controls where supported. The policy recognizes available GPT versions rather than relying on a fixed model name. The extension cannot grant access to a model or reasoning level not offered by ChatGPT.

Display preferences cover wrapping long messages and code, compact headings, model controls, chat timestamps, share labels, the work-duration indicator, and optional notices and promotions. Hiding a control is not the same as disabling a server feature. In particular, disabling manual Search hides the manual selection UI, not all web requests or automatic search.

## Links, copying and previews

Use the Links and Copy & formatting preferences independently. Copied-text formatting can strip bold formatting, normalize quotes, and convert italic markers to underscores. UTM cleanup removes tracking query parameters while retaining other parameters and fragments.

External links can open in a new tab or via an adjacent split-view button. Browser-native split view is preferred when available; the embedded fallback depends on the destination allowing framing. GitHub's API-backed fallback is read-only and requires appropriate credentials for private content. Source-image recovery and conversation recovery cannot bypass expired credentials, access controls, or server limits.

If a link preview fails, use the ordinary browser navigation action. Hiding external-link arrows affects presentation, not the existence of the underlying links.

## Research and launchers

The homepage research telescope selects Deep Research in the current composer and opens a separate Spellcheck Only chat without submitting the original draft. The writing-block telescope has an independent visibility setting. The prompt-review setting controls the Deep Research spellcheck workflow; review its result and use the offered Go action when ready. Attachments and unsupported composer layouts may prevent prompt review.

The allowance tracker reads ChatGPT's observed quota. Homepage and research-composer visibility, counts, reset countdowns and optional pies are independently configurable. Estimated scales are not actual account limits. For a completed report, the optional native research publisher imports Markdown to a locally linked Git repository; see the [publisher setup](../README.md#deep-research-publisher) before enabling it.

The optional Spellcheck Only launcher accepts custom artwork through settings. The optional 2048 launcher provides a local game. Neither is needed for the GitHub dashboard.

## Troubleshooting

| Symptom | First checks |
| --- | --- |
| Dashboard is empty | Configure accounts or credentials, verify repository access, and refresh the page. |
| A settings page stopped responding after an update | Close and reopen it from the extension toolbar; reload the existing unpacked installation rather than removing it. |
| A chat feature is absent | Check its setting, the current route, and whether the native ChatGPT control is present. |
| A queued message is waiting | Check for ongoing generation and pending conversation state; do not manually resend without checking the queue. |
| A conversation fails to load | Use Refresh view when available, honor the server cooldown, and avoid repeated refreshes. |
| Report publishing fails | Check the linked repository, native host registration, Git access and destination branch; retry only after reviewing the displayed error. |

Flawless uses the native browser profile and existing ChatGPT UI. Browser differences, ChatGPT layout changes, site permissions, and network failures can affect features independently. Report reproducible failures with the browser/version, extension version, route, feature preference, and sanitized error details; never include tokens or private chat contents.
