# 0156. Content opens beside the conversation

**Status:** Accepted

## Context

Opening a file replaced the task with no visible way to close the file or return
to the conversation. Image creation covered the workspace with a modal. Both
interrupt reading and make working between a task and its output harder.

## Decision

- A main pane keeps closable navigation entries for conversations, files,
  previews, and canvases opened in that pane. The strip uses its existing title
  row; it does not add another window-wide header. Opening the same content
  selects its existing entry. Closing active content selects its neighbor.
- The host still owns one visible surface per pane. Retained entries are
  renderer-session navigation references, not mounted hidden editors or a second
  persisted layout. Selecting them uses the normal server-authorized open
  command. A refused open does not become a successful tab activation.
- References are scoped to the pane and authority context, and are cleared when
  that context changes or the pane closes. Application reload restores the
  authoritative visible surface, not a separate hidden layout.
- Image creation uses an independent pane-owned content view with the source
  task's explicit scope and client. Its draft and in-flight job view stay mounted
  while switching to the conversation. Closing the view stops its observation;
  only the explicit Cancel job action cancels generation on the host.
- Existing editor drafts remain owned by the thread's draft store. Tabs confer
  no new file, provider, or tool permissions. Approval prompts remain explicit
  confirmations and are not converted into content tabs.

## Supersession

This supersedes 0041's September 7 removal of the main content strip and its
conversation-only restriction. Its one-authoritative-surface rule, split-tree
behavior, and server authority checks remain. The surface-opening contract in
0015 is unchanged.

## Consequences

The task remains one click away from its files and generated content. Retained
navigation lasts for the renderer session; durable multi-tab restoration is not
introduced. Utility processes continue to use their existing dock controls.
