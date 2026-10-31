# Archived Studio dispatcher prototype

This directory preserves the former Studio prototype and its checklist manifest. Use the integrated Flawless dispatcher at the repository root. The companion server, standalone extension, and native app are archived here for reference and are not required by Flawless.

# Studio Chat Dispatcher

A local app for a rolling pool of ten existing Brave ChatGPT conversations. It dispatches the next task into each idle chat only after the previous task posts a merge confirmation and GitHub verifies that exact PR and merge commit.

This directory is the standalone prototype. The dispatcher is being integrated into Flawless ChatGPT as an extension feature using its existing GitHub connection. The prototype below remains available, but should stay paused when the Flawless dispatcher is in use.

The prototype consists of a browser extension dashboard and a small local GitHub verifier. It does not require an OpenAI API key, move browser focus, open replacement chats, read credential files, or interrupt a running response. The verifier uses your existing `gh` login for read-only PR metadata; the implementation chats perform their authorized work and squash merges.

## Run

1. In `brave://extensions`, enable developer mode and load the `extension` directory with **Load unpacked**. This grants the connector access to ChatGPT tabs and its local verifier. Existing chats can be adopted without reloading them.
2. Open the extension's dashboard and copy the extension ID shown under **GitHub verifier setup**.
3. From this app directory, run `npm start -- --repo PDF-magic/opener --extension-id YOUR_EXTENSION_ID` using Node 22 or newer and an authenticated GitHub CLI.
4. Import the prepared task manifest, choose the ten existing conversation tabs, and identify each tab's current task. The current task is inferred where possible; explicit task IDs can be entered before adoption.
5. Press **Start**. The app begins paused and adopts conversations without sending anything. Busy chats remain untouched. Use **Pause** at any time to prevent further submissions.

To preview the dashboard without connecting or changing any chats, run `npm start` and open the printed local address. Connecting the extension is required for actual dispatch.

## Completion and interruption safeguards

- Stop controls, thinking/streaming indicators, pending submissions, unfinished replies, unknown conversation structure, and existing Flawless queue entries all block submission.
- A completed reply must remain stable for at least 1.5 seconds. Drafts, attachments, and conversation identity are rechecked before preparation and immediately before sending.
- The content adapter addresses the chosen tab directly and accepts only a genuine native Send control. It never clicks Stop, Interrupt, or Steer. It never presses Enter, which other extensions can intercept as a queue command.
- Each send has a persisted reservation and a unique submission reference. A crash, changed route, or unconfirmed submission blocks the slot for manual review rather than replaying it.
- An open or closed-unmerged PR does not release a slot. The assistant must finish with `MERGE_CONFIRMED TASK_ID https://github.com/OWNER/REPO/pull/NUMBER FULL_MERGE_SHA`. The verifier checks repository, PR number, merged state, and the full merge commit. A confirmation from an older task cannot release the current task.
- An idle chat missing its confirmation receives at most one follow-up asking it to finish and confirm the existing task. This follow-up is subject to the same interruption checks. It receives no new checklist task until its merge is verified.
- The app does not switch checkouts or delete branches. Those remain with the existing automatic workflow.

Imported task manifests may use the previous `tasks`, `task_id`, `prompt`, and `status` format. Already submitted tasks remain excluded from fresh assignment; adopted chats track their current tasks. Export preserves session status and confirmed merges. Uncertain sends must be reviewed before resuming a slot. The app never reads arbitrary local files: import is limited to the JSON file you choose.

When the imported manifest identifies earlier tasks sent to an adopted conversation, those tasks also require verified merge confirmations before that slot advances. This catches PRs left open before the merge-confirmation rule was enabled.

The local verifier binds only to `127.0.0.1:8794`, accepts only the paired extension origin, and only queries the repository passed on its command line. It cannot execute prompts, change GitHub data, or merge a PR itself.

## Development

Run `npm install` followed by `npm test`. Runtime code uses browser APIs and Node's standard library. Tests cover completion races, draft preservation, native Stop/Send replacement, uncertain sends, merge confirmation matching, verifier origin restrictions, and recovery behavior.

The lifecycle rules were informed by the existing Flawless implementation: https://github.com/pony-factor/flawless-GPT/blob/main/js/composer/message-queue.js

Browser integration uses [Chrome extension messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging) and [periodic service-worker alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms). Existing ChatGPT DOM changes fail closed; a blocked slot reports its reason in the dashboard.
