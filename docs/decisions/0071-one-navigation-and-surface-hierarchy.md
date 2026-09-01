# 0071. One navigation and surface hierarchy

**Status:** Accepted

## Context

The raised object language in 0070 fixed Octant's flat setup surfaces, but it
did not distinguish navigation, value selection, pane identity, routine form
layout, and discrete objects. Applying one card or segmented treatment to all
five made Settings dense, tabs look like filters, and an inactive pane look
selected. Narrow Settings also placed its rail above the form instead of giving
the active page priority.

## Decision

- **One primitive stack remains.** Base UI recipes under `ui/shadcn` and the
  Octant adapters under `ui/base` remain the only shared control stack. No new
  UI dependency or public-block package is added.
- **Navigation has one grammar.** Sidebar and Settings destinations are compact
  rows with a quiet selected fill and sentence-case group labels. True tabs use
  a flat rail and selected fill with no enclosing track. Segmented choices keep
  an enclosed muted track. Active split-pane identity appears only on the pane
  grip; it does not borrow tab or segmented paint.
- **Settings separates layout from objects.** This partially supersedes 0070's
  rule that every Settings or form group is a raised card. Routine related rows
  are open on the application ground with hairline separators. A profile,
  provider, skill, preview, theme, destructive group, or other discrete object
  remains a raised card. Important labels and explanatory text stay at least
  12px at the default interface scale.
- **Narrow Settings keeps content first.** Below the wide-layout boundary, the
  fixed rail becomes an accessible left drawer opened from a compact page
  header. The active page title and search remain visible; selecting a
  destination closes the drawer and returns focus to its trigger.
- **Welcome and dock chrome are conditional.** A new-thread surface first reads
  as one question and one raised composer. Starter actions appear only when
  recent work does not already provide a next step. Repository and branch
  context stays with the composer's context card. A pane with no thread and no
  valid tool does not render a dock toggle or an empty dock.
- **Operational density uses summary then disclosure.** Provider and skill
  lists show compact readiness counts and one effective state per row. Usage
  starts with requests, input, and output; cache, reasoning, execution time,
  and latency stay in one explicit operational disclosure.

All remaining rules in 0070 stand, including its radius and shadow scale,
composer elevation, adapter ownership, originality, and one-stack constraint.

## Consequences

- A selected destination, tab, segmented value, and active pane no longer use
  the same silhouette.
- Settings can scan like a desktop preference pane without losing raised
  objects where elevation communicates ownership or depth.
- Empty chrome is removed from welcome and Project surfaces, while real
  thread-owned tools retain their dock lifecycle.
- Contract tests guard the navigation grammar, Settings hierarchy, and removal
  of legacy feature tab paint.

## Related

- 0015 Workspace shell model
- 0016 Component foundation and theme
- 0044 The dock hosts live thread-owned tools
- 0046 shadcn recipes own product controls
- 0070 Renderer visual language matches public block catalogs
