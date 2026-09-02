# 0077. Environment is a context-aware dock tool

**Status:** Accepted

## Context

0045 kept Environment in a floating disclosure. As the checkout, server,
pull-request, subagent, and working-folder summary grew, the popup became a tall
second sidebar with weaker overflow and multi-pane behavior than the dock.

## Decision

- Environment is a singleton thread-owned tool in the right dock for Chat,
  Work, and Code. It appears in Add tool and the title-bar icon opens or focuses
  that tab.
- The active pane continues to own the authoritative environment controller.
  Switching panes replaces the dock subject and never leaks the previous pane's
  facts.
- Environment uses the dock's ordinary tab lifecycle, selected state, overflow,
  narrow drawer, close behavior, and per-thread window presentation state. It
  has no separate popup.
- Checkout, changes, local servers, pull requests, working folder, and compact
  subagent summaries remain Environment content. Deep Review and Agents actions
  continue to open their dedicated dock tabs.
- The tool strip sizes to its visible tabs so Add tool sits directly after the
  final tab. Several open tools use a consistent selected edge and overflow.

This record supersedes only 0045's transient-disclosure presentation. Its
active-thread authority and compact-summary content rules remain accepted.

## Consequences

- Environment can remain open while someone works and follows the same pane
  focus rules as every other thread-owned tool.
- Multiple tools read as one compact tab strip, and Environment no longer adds
  a floating card over the workspace.
- Opening Environment restores the dock's per-thread presentation choice. It
  does not journal a new domain preference or change thread authority.

## Related

- 0041 Panes hold one authoritative surface
- 0044 The dock hosts live thread-owned tools
- 0045 Environment summarizes the active thread
