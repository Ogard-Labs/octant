# 0114. Thread composers and utility panels keep only useful chrome

**Status:** Accepted

## Context

The maintainer's side-by-side workspace comparison showed a composer with a
blank feedback row, separate access and approval-review controls, and repeated
binding details. Utility headers added a second divider below each panel's
resize boundary. These consumed space without helping the person write or
identify the active checkout.

## Decision

- Follow-up composers keep one message surface and one compact control row.
  Feedback appears when it has content; an empty feedback or context slot
  consumes no height. Visible notices and recovery actions remain accessible.
- Attachment and model controls stay on the left; access, context usage and
  send form one right-aligned group, including when the row must wrap.
- Menus use compact interface text. Model menus stay within the viewport and
  retain a stable scrollable list rather than growing with the result count.
- Keyboard focus uses control fill and text emphasis without drawn outlines
  or bright border changes. This partially supersedes 0105's neutral focus
  edge; keyboard operation, visible focus, and shared recipe ownership remain.
  A menu container does not draw a focus frame around its contents.
- Selected controls and context-menu targets use fills, check marks, or text
  emphasis instead of highlighting borders. Preview thumbnails retain their
  content while a check mark identifies the selected appearance.
- This partially supersedes only 0098's fixed, empty feedback lane. Its shared
  frame, separate attached checkout strip, input growth, and ownership rules
  remain in force. A notice may now change the composer's height.
- The access menu contains the provider's optional approval-review choice and
  the starting profile. The closed control reflects an enabled approval-review
  choice. Moving those controls changes no server authorization, native
  confirmation, provider capability, or approval policy from 0009 and 0104.
- Repository identity, branch and PR actions remain visible in the compact
  checkout strip below the input.
- Sent messages do not repeat an access-policy caption. Stored policy and
  approval history remain intact; the composer shows the next turn's choice.
- Utility panels use one resize boundary and one tab row. The tab row does not
  add a second horizontal rule. Tabs, add-tool, close, keyboard resizing and
  thread-owned tool lifecycle keep their existing meaning under 0044.

## Consequences

The shared composer and panel CSS own the simpler geometry. Feature callers
still own their draft, actions, errors and exact checkout context. Hiding
presentation does not stop or rebind a process.

## Related

- 0044 The dock hosts live thread-owned tools
- 0098 Follow-up composers separate the message and its context
- 0104 Harness-delegated approvals as a per-thread pass-through
