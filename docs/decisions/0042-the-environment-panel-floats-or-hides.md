# 0042. The environment panel floats or hides

**Status:** Proposed

## Context

0015 gives every thread tab a persisted environment presentation of floating,
pinned, or hidden. Pinned made the panel an in-flow sibling of the thread, so
the two shared the row's width. Dogfooding the single-pane workspace showed
what that costs: a stored dock width plus a pinned panel left the thread — the
surface actually being read — squeezed, and the app grew a minimum-width floor
and a narrow-viewport override to stop the panel eating the pane outright.
Those rules were treatment for a symptom. The panel's value is a glance at
live checkout status beside the thread; docked into the row it stopped reading
as status about the thread and started reading as shell chrome, competing with
the sidebar and the dock for the same job.

The panel had also become the place where every thread-scoped surface landed —
Files, Plan, and Publish moved in when the dock could not name a thread — which
turned a glanceable float into a stack of disclosures.

## Decision

- A thread tab's environment presentation is **floating or hidden**. There is
  no docked presentation, no stored panel width, and no resizer. The per-mode
  default for Code is floating.
- Hide and show are one toggle: the panel's header carries Hide, and the hidden
  state carries a reveal control that names the environment it opens. Escape
  hides an open panel, as before.
- The floating panel holds what the **environment** answers for: what the
  checkout has changed, what is listening locally, and where work happens. The
  thread's own working surfaces belong to the dock's thread panel, which has
  the room for them.
- A stored `pinned` presentation restores as floating and a stored panel width
  is dropped, at the persistence seam, before the wire schema decodes. A user
  who pinned an environment starts up with a floating one; nothing else about
  their presentation state is lost.

## Consequences

- The thread pane owns its column again. The readable-width floor and the
  narrow-viewport overlay override that existed only to protect the pane from
  the pinned panel are gone with it.
- Two presentations means the mode default is a real choice rather than a
  three-way preference most of which contradicted the panel's purpose.
- Anyone who wants the environment permanently in view no longer has a way to
  keep it in the row. That is the deliberate trade: the panel is a glance, and
  a surface that must stay open belongs in the dock, which is built to hold one.
- 0015 remains Accepted. This record supersedes only its per-tab presentation
  rule — "each tab persists floating, pinned, or hidden presentation";
  everything else in 0015 stands, including that the environment belongs to a
  thread tab and follows the authoritative thread.

## Related

- 0015 defines the shell rule this record amends.
- 0041 makes the dock follow the active pane, which is what lets a thread-scoped
  panel live there instead.
