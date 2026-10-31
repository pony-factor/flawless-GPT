# Chat dispatcher

Open **ChatGPT → Open chat dispatcher** from the Flawless popup or full settings. The dispatcher is part of Flawless and uses its existing GitHub connection. It does not need a separate extension, native app, terminal process, API key, or running Codex session.

## Start or resume

1. While paused, either **paste checklist items** into the dashboard and select **Import incomplete items**, or import a JSON task manifest. The Studio manifest format remains supported; previously submitted tasks stay excluded from new assignments. A pasted Markdown checklist accepts `- [ ]` and `- [x]` entries, numbered checkboxes, ordinary bullet lists, and one task per line. Completed `[x]` items are skipped; Markdown headings are copied into each task as section context.
2. Press **Start**. On the first start, the dispatcher opens ten fresh ChatGPT tabs automatically. It reuses those same ten chats for later tasks after verified merges. Resuming an existing pool keeps its current chats. Every slot works independently: a busy chat stays untouched, while a completed chat can move to its next task after merge verification.

**Pause** immediately prevents further submissions. Browser startup and extension updates leave the dispatcher paused. Closing the dashboard does not stop a running dispatcher; its extension worker and periodic alarm continue in the background.


The pasted checklist is **not** sent immediately. Import replaces the currently unassigned task list and Start controls dispatch. Each unchecked line becomes a separate implementation task and proposed PR. For changes with dependencies or shared files, consolidate related checklist lines into a focused task before importing; ten slots can otherwise start concurrently. Input is preserved if validation or import fails. The JSON manifest import continues to work unchanged.

## When a slot advances

The dispatcher requires all of the following:

- The latest assistant reply is complete and unchanged for at least 1.5 seconds.
- No Stop, thinking, streaming, pending submission, existing queue entry, attachment, or selected context is present. Text drafts are protected by default; the paused-only **Replace existing text drafts** option permits replacing them with the dispatch prompt.
- The current task has a `MERGE_CONFIRMED` line naming its task ID, PR URL, and full merge commit SHA.
- GitHub independently reports that same repository, PR number, merged state, and merge SHA.

An open PR, a closed-unmerged PR, or passing CI alone does not count as completion. Earlier tasks associated with the adopted chat in the imported manifest must also have verified merge confirmations. Already implemented tasks can cite the existing merged PR rather than create an empty one.

New prompts request a focused PR, the needed CI checks, and squash merge after completion. They leave automatic branch deletion and checkout cleanup to the existing workflow. The dispatcher verifies merges; the implementation chats perform the authorized repository changes and PR operations.

## GitHub comment policy

Bulk-merge task prompts and merge follow-ups tell ChatGPT to keep routine CI polling, workflow progress, branch synchronization, merge readiness, and repeated status checks in the ChatGPT conversation—not GitHub PR comments. Publish a PR comment only for a substantive implementation decision, a meaningful code change requiring explanation, an unresolved actionable review finding, or information other contributors need. Before commenting, review the existing PR discussion, consolidate related points, and do not repeat findings already documented.

The optional **Prefer Codex Pony** setting asks implementation chats to use their configured Codex Pony/Kefania publishing tool. It cannot change a chat's GitHub credentials or guarantee the author identity. If that tool is unavailable, the prompt permits the authorized GitHub workflow and asks the chat to report the identity it used.

An idle chat without confirmation receives at most one follow-up asking it to finish its existing task. It receives no new checklist task until its merges are verified. This follow-up goes through the same interruption checks as a normal task.

## Interruption protection

The content adapter reuses Flawless's composer selection, native Send lookup, and read-only lifecycle snapshot when available. It also retains its independent DOM checks for already-open tabs. It never invokes the queue, clipboard sender, Stop, Interrupt, or Steer actions.

Each send first reserves a particular tab, conversation, reply, and prompt. It checks completion before writing and again immediately before clicking the genuine native Send node. Activity resuming, a route change, a changed draft, or Send becoming Stop aborts the operation. Unsent text is preserved for review.

Reservations are saved before changing the composer. A crash or an unconfirmed submission blocks that slot instead of retrying a potentially successful send. In Work layouts that omit user prompts, each reply echoes a unique dispatch receipt before the slot is bound. An uncertain task can also recover automatically from its exact GitHub-verified merge proof, without replaying the prompt. While paused, review the chat and select the matching confirmation action in its card. Existing drafts are never erased by default.

To reuse a ChatGPT window with pre-filled text, pause that dispatcher and enable **Replace existing text drafts in worker ChatGPT windows**. This is an opt-in setting scoped to that dispatcher session, and the next permitted task or merge follow-up replaces the text rather than appending it. The original text is intentionally discarded, so copy anything you want to keep before enabling the option. Attachments, quoted or selected context, queued messages, active replies, and uncertain submissions remain protected. Draft replacement does not allow closing a drafted tab during chat rotation; if a submission is interrupted, the new unsent prompt remains available for review. Disable the setting while paused to restore the default behavior.

## Importing earlier Studio task manifests

The dispatcher is fully integrated into Flawless; the former standalone Brave extension, macOS launcher, and localhost GitHub verifier have been retired. No separate process, companion service, or local GitHub CLI is needed for dispatcher operation.

For the prepared PDF Magic Opener checklist, import `tools/task-manifests/opener-tasks.json` from the paused Flawless dispatcher dashboard. The manifest has been preserved unchanged, including previously dispatched task statuses; those tasks will not be assigned again. Other Studio-format JSON task manifests can also be imported.

If the separate Studio extension is still installed on your computer, disable it to prevent two dispatchers from controlling the same chats. Flawless uses separate storage and its existing GitHub connection, so it does not import the other extension's local session state automatically. Unavailable GitHub access blocks merge verification and task advancement.

## Tests

Install the development-only DOM fixture dependency with `npm install --no-save --package-lock=false jsdom@26.1.0`, then run `node --test tests/chat-dispatcher-*.test.cjs tests/message-queue.test.cjs tests/settings-markup.test.cjs`.

The regression workflow installs the same fixture dependency and includes dispatcher tests in the existing required unit-test step.
