# 0041. Panes hold one authoritative surface; thread tabs are window-local navigation

**Status:** Proposed

## Context

Under 0015 a split-tree leaf was a tab group with its own persisted surface
lifecycle. That gave the window two authorities for one job: the server-owned
pane tree and a second collection of hidden surfaces. It produced duplicate
thread views, restored dead tabs after host restart, separated a draft from the
thread it created, and made the Right Utility Dock's subject ambiguous.

Removing every main-window tab solved those authority problems but made the
sidebar the only way to revisit recent conversations. A person comparing work
across several Chat, Work, or Code threads had to repeatedly rediscover rows in
the Project tree, and an unbound global reader could trap ordinary navigation
behind a separate Back to workspace step.

## Decision

The server-authoritative workspace remains a recursive split tree whose leaf is
one pane holding exactly one surface. The renderer may additionally present a
window-local thread strip as navigation history. A strip entry is not a hidden
surface, does not keep a second transcript mounted, and carries no authority;
activating it sends the same open-thread command as the sidebar and the server
revalidates mode, Project, host, and thread identity before replacing or
activating a pane.

- **One preview, explicit pins.** The current conversation occupies one
  unpinned preview entry. Opening another conversation replaces that preview.
  Pinning retains the entry so several threads can be swapped from the main
  window. Closing an active entry activates the nearest retained thread.
- **Conversation entries only.** Chat threads, Work threads, and the Code
  conversation overview participate. Browser, Files, Terminal, Tests, Review,
  Preview, Canvas, and other utility surfaces keep their pane or dock controls;
  they are not disguised as conversation tabs.
- **Open still replaces.** Activating a surface replaces the active pane unless
  the same surface is already visible, in which case that pane becomes active.
  The renderer-local strip does not alter that operation.
- **Drag still splits.** Dragging a sidebar row or pane grip to an edge creates
  a same-authority split. Center drop replaces. Cross-Project, cross-mode, and
  cross-host placement remains server-refused.
- **Drafts rebind in place.** A draft occupies one pane and becomes its real
  thread after creation. It is represented in the title breadcrumb, not as a
  separately retained conversation entry.
- **Restore remains authoritative.** Pane layout and visible surface identities
  restore through the host. The thread strip is presentation history for the
  current renderer session; it cannot resurrect a missing or unauthorized
  thread.
- **The right utility dock follows the active pane and remembers per thread.**
  Pointer or keyboard activity activates a pane. Each thread owns its open Side
  Chat, Browser, Files, Canvas, Plan, Delivery, Review, Terminal, Tests, and iOS
  Simulator tools plus the selected tool. Project- and host-scoped readers keep
  a window fallback where no thread exists. A tool with no valid subject shows
  an explicit unavailable state, never another pane's content.
- **A wide window arrives with the dock shown.** A window that has never been
  told otherwise starts with it shown. Starting it hidden left the workspace as
  one narrow column in an empty window, with the dock's own region reading as
  page margin rather than as the place the thread's tools live. A narrow window
  still starts closed, because there the dock is a modal drawer and would cover
  the workspace on launch. Arrival state is window presentation state and stays
  user-controllable; an explicit close is remembered for that window.
- **The dock's own control is the only manual open and close.** No other
  affordance hides or reveals the region. Opening a tool still raises the dock,
  and so does a turn that produces something the dock owns — a written
  document, a Canvas, a handed-off thread — because the offer is worthless in a
  region the user cannot see. A raise like that follows the active pane: an
  offer for a thread the dock is not describing waits rather than opening
  another thread's tools.
- **Global readers do not block navigation.** New thread, thread search, and
  thread-tab activation dismiss Inbox, Thread Board, Pull Requests, and other
  blocking readers before opening their destination.
- **Zen is untouched.** It is not a split-tree or thread-strip entry.

## Consequences

- Several threads can be kept within reach without reintroducing persisted
  background surfaces, duplicate controllers, or a second authority model.
- The strip may show a stale title until the next authoritative open, but it
  cannot bypass a missing Project, moved host, archived thread, or revoked
  capability; the ordinary open command resolves those cases.
- Utility surfaces retain their explicit close/split lifecycle. Conversation
  tabs close navigation history, not terminals or browser contexts.
- 0015 remains Accepted. This record supersedes only its persisted tab-group
  leaf and defines the renderer-local thread navigation layered above panes.

## Related

- 0015 defines the shell and split tree.
- 0017 and 0003 own mode, Project, and thread authority.
- 0042 owns Environment presentation.
- 0043 owns Simulator placement.
- 0044 owns dock tool instances and placement.
