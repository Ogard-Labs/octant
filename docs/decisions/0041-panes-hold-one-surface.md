# 0041. Panes hold one surface; the sidebar is the only switcher

**Status:** Proposed

## Context

Under 0015 a split-tree leaf was a tab group with its own strip, which gave the
window two switchers for one job: the sidebar hierarchy (server-authoritative,
unread marks, row menus) and the per-group strip (its own lifecycle, identity,
ordering, and restore state). The strip's lifecycle is where the observed
workspace instability lived: every open gesture minted a new tab with no
identity rule, so ordinary navigation produced duplicate thread tabs; a draft
and the thread created from it became distinct tabs; and tabs restored against
a restarted host rendered as dead views with an unrecoverable Retry. The strip
also broke the Right Utility Dock's premise: with two groups of tabs visible,
"which thread does the right dock describe?" had no honest answer.

## Decision

The central workspace remains one persistent recursive split tree, but a leaf
is now a pane holding exactly one surface — a thread, a draft, a project
overview, a utility surface, or a mode welcome — with no tab strip and no tab
lifecycle. Several same-authority threads may be pinned into that tree at
once. The sidebar's hierarchy is the one and only switcher.

- **Open replaces.** Activating a surface replaces the content of the active
  pane. Opening never mints a second view of a surface already visible in some
  pane; activation focuses that pane instead.
- **Drag splits.** Dragging a sidebar row (or a pane's header grip) onto a
  pane's edge creates a split on that edge; dropping on a pane's center
  replaces its surface. The split, resize, focus, reset, and authority rules
  of 0015 are unchanged: completed operations go through server-authoritative
  workspace commands, and a cross-Project, cross-mode, or cross-host drop is
  still refused.
- **Drafts rebind in place.** A new-thread draft occupies a pane; when the
  thread is created, the same pane rebinds to the real thread. A draft is
  never a separately persisted view.
- **Restore is layout-only.** What persists is the pane tree and each pane's
  surface identity. A restored surface that no longer resolves under the
  window's current authority renders that mode's welcome surface in place —
  never a dead view demanding recovery.
- **The right utility dock follows the active pane and remembers per thread.**
  One surface per pane means the active pane names the dock's subject
  unambiguously. Pointer activity or keyboard focus activates that pane. Each
  thread owns its open Side Chat, Browser, Files, Canvas, Plan, Delivery,
  Review, Terminal, Tests, and iOS Simulator tools plus which tool is selected.
  Returning to
  a visible thread restores that tab set and reconnects to the thread's
  host-owned utility state. The whole sidebar is window state; the explicit
  top-right control is the only thing that opens or closes it, and a wide
  window that has never been told otherwise starts with it shown. Starting it
  hidden left the workspace as one narrow column in an empty window, with the
  dock's own region reading as page margin rather than as the place the
  thread's tools live. A narrow window still starts closed, because there the
  dock is a modal drawer and would cover the workspace on launch. Project- and host-scoped
  readers keep a window fallback for panes that hold no thread. A panel the
  newly active pane gives nothing to describe presents that as an explicit
  unavailable state — never the previous pane's content. Which live tools exist
  for that subject, and which of them is selected, are owned with the subject
  (0044). Simulator placement is 0043. Authority stays server-side; the dock
  only presents.
- **Zen is untouched** — it was never a split-tree tab, as 0015 already
  records. Environment is 0042. Side chat is a dock tool under 0044.

## Consequences

- Background tabs — surfaces held open but not visible — no longer exist.
  The sidebar lists every thread with its marks, which is the same promise
  without renderer-local state; a surface in no pane is simply not rendered,
  while its authority, environment, and activity live on the server as before.
- Per-tab accessories die with the strip. Signals that rode on background
  tabs (for example a Project's context-health warning) must reach the user
  through the sidebar or the surface itself. The context-health warning marks
  its Project's sidebar row; opening it activates that Project. Context
  composition for a turn is a composer meter (0044), not a dock tab.
- 0015 remains Accepted. This record supersedes only its tab-group leaf —
  the strip, tab lifecycle, and per-group activation; everything else in 0015
  (mode-first shell, split tree, boards, dock region, authority) stands.

## Related

- 0015 defines the shell this record amends.
- 0017 and 0003 own the authority context the pane tree binds to.
- 0042 owns Environment presentation.
- 0043 owns Simulator in the right sidebar.
- 0044 owns dock tool instances and placement.
