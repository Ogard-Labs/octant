# 0044. The dock hosts live thread-owned tools

**Status:** Proposed

## Context

0015 put the Right Utility Dock outside the split tree as a capability-gated
region, and 0041 made that dock follow the active pane. 0043 already placed
Simulator there. The renderer still fills remaining dock chrome with a generic Thread tab plus
launch buttons. Context usage already lives on the composer meter; Project
memory already lives in Project Overview; Navigator already opens as a
host-wide popover from the profile and Settings control. The remaining Thread
tab still makes the user pick an implementation bucket before reaching Plan,
Delivery, or Agents, and it cannot say honestly which thread owns a live
terminal, browser, or review.

## Decision

The shell has two resizable working regions for live tools owned by the active
pane's subject: the right dock and a horizontal bottom panel. They are not
lists of shortcuts, not second thread switchers, and not places for host-wide
or Project-wide surfaces.

- **Instances stay with their owner.** A dock tool instance belongs to the
  thread or Project authority that created it. Switching panes never rebinds a
  running terminal, browser context, file view, canvas, or agent control to
  another thread. Activating a pane shows that subject's tools and last
  selected tool; a subject with no open tools shows a compact launcher. A
  panel the newly active pane cannot describe is explicitly unavailable —
  never the previous pane's content.
- **Several tools, one thread.** The dock may hold more than one live tool
  for the active thread, switched by a compact tool strip. The strip is for
  tools, not threads, and shows only capabilities valid for that pane. Hiding
  a tool does not stop its server-owned process; close and stop keep their
  existing product meaning. Narrow windows keep the existing overlay drawer.
- **Terminal-first bottom panel.** The pane title row may open a horizontal
  bottom panel below the central workspace and right dock. Terminal is its
  first supported tab; the strip remains tool-shaped so another horizontal
  tool can be added without inventing another panel model. New windows start
  closed. Open state and height are per-window presentation preferences, while
  authority and content still follow the active pane.
- **One instance, one presentation.** A thread-owned tool appears in one shell
  region at a time. Moving Terminal between the right dock and bottom panel
  remounts the same thread-owned tool over the same server session; it never
  duplicates, transfers, or rebinds a terminal to another thread.
- **Direct tools, no generic tabs.** When mode and capability allow them, the
  utility regions host Review, Files, Browser, Terminal, Canvas, and Side chat. The
  generic Context, Project memory, Navigator, and Thread tabs are removed.
- **Plan is artifact-gated.** Plan appears only when the active thread has a
  real plan artifact (0027). The dock shows that artifact, revisions, approval,
  and step state. It does not show an empty Propose plan form; proposal stays
  the thread's planning workflow.
- **Publish is Delivery, and conditional.** Delivery appears only when the
  server reports an enabled target or an actionable delivery plan (0026). An
  unconfigured empty panel is absent.
- **Agents is conditional.** Compact child-run status stays in the thread
  header (0012). Agents opens as a dock tool when children exist or the user
  invokes Add agent.
- **Review is the diff destination.** Local checkout changes and merge-back
  run review open in Review beside the main thread. Pull-request detail remains
  a later Review destination. The full-window Code diff surface is gone.
- **Context usage is a composer meter.** A circular used-capacity control on
  the active thread's composer opens an authoritative breakdown popover. It is
  not a dock tab. Estimated or unavailable values say so; opening the popover
  causes no unrequested provider call. Switching panes replaces every value
  and closes a popover that belonged to the previous pane (0008).
- **Project memory lives in Project Overview.** Memory stays Project-scoped
  (0003); the Overview is where its ownership is obvious.
- **Navigator is a host-wide popover.** One host-owned conversation opens from
  the bottom-left profile and Settings control. Opening it never changes the
  active thread or Project (0019).

Canvas in the dock addresses the existing authorized document (0010); it does
not copy content or treat renderer focus as authority. Environment remains a
thread-header disclosure (0042). The central pane remains the thread, a board,
a Project overview, or a Project-level list.

## Consequences

- Project memory now lives in Project Overview, and Navigator opens from the
  profile control. Files, Browser, Terminal, Canvas, Side chat, artifact-gated
  Plan, conditional Delivery, thread-level Agents, and Review are direct
  thread-owned utility tools; the generic Thread accordion is gone. Terminal
  may be presented in the horizontal bottom panel without creating another
  session. Local checkout changes and
  merge-back run diffs open in Review beside the thread; the full-window Code
  diff surface is gone.
- 0015 remains Accepted as the current implemented shell. This record, with
  0041 and 0042, is the approved migration of dock content, tool ownership,
  and placement. It does not change mode authority, journal ownership, or
  which capabilities exist.

## Related

- 0003 Product modes and authority
- 0008 Context budget, provider limits, and capacity scheduling
- 0010 Secure file preview and canvas artifacts
- 0012 Mixed-provider subagents and agent runs
- 0015 Workspace shell model
- 0016 Component foundation and theme
- 0019 User profile and first-run setup
- 0026 Shipping to a user-owned target
- 0027 Plans as journaled artifacts
- 0041 Panes hold one surface; the sidebar is the only switcher
- 0042 Environment is a transient disclosure
- 0043 Simulator follows the active thread in the right sidebar
