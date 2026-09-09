# 0099. Chat keeps the conversation full width

**Status:** Accepted

## Context

The generic Tools panel offered Environment and Side Chat beside a Chat
conversation, consuming reading space without serving the requested workflow.
Work also placed Browser and completion buttons in an extra row above its
transcript, unlike Code.

## Decision

- Chat does not present the shell's right utility dock or bottom tool panel,
  including their title-bar toggles. Saved utility presentation for other modes
  remains intact. Chat's central Canvas and artifact routes remain available.
- This is a scoped exception to 0077's rule that Environment is a dock tool in
  Chat. Its Work/Code behavior, authority, and lifecycle rules remain unchanged.
  The generic Chat dock and automatic Chat Canvas dock offers in the proposed
  0041/0044 presentation are no longer shown.
- Browser remains available through Work/Code's existing dock. This UI change
  does not claim or grant browser authority in Chat; a Chat browser requires
  a separately implemented supported capability.
- Work has no persistent Browser/completion toolbar above its transcript.
  Browser stays in the dock; completion is available through the compact Task
  actions menu in the composer. The existing evidence and server-confirmation
  flow is preserved. Child-run status may still appear when present.

## Consequences

Chat uses the full conversation area. Removing the generic utility region
changes presentation only: no thread data, provider authority, or saved Code
and Work tool state is deleted. Work keeps completion available without adding
an always-visible button row.
