# 0042. Environment is a transient disclosure

**Status:** Proposed

## Context

0015 gave every thread tab a persisted environment presentation of floating,
pinned, or hidden. Pinned made the panel an in-flow sibling of the thread, so
the two shared the row's width. An earlier proposal dropped pinned and kept a
floating or hidden panel whose open state still persisted. Dogfooding that
shape showed the same cost in a milder form: a stored float is still a second
column of cards — Git facts, local-server stacks, working-folder fields —
competing with the transcript. The panel's value is a glance at live checkout
status, not a workspace of its own, and not a home for Files, Plan, or
Publish once the dock can name a thread.

## Decision

Environment is a compact thread summary with a transient disclosure. It is
not a persisted panel, not an in-flow sibling of the transcript, and not a
wall of cards.

- The thread header always carries a compact, truthful summary: checkout
  identity, clean or dirty state, running-server count, and working location.
- Opening the summary shows a popover or overlay anchored to the thread.
  Escape, an outside click, or activating another pane closes it.
- Open or closed is renderer state. It is not persisted and is not a
  journaled per-thread preference.
- The disclosure answers only what the environment is for: checkout identity,
  what has changed, local servers, and where work happens. Files, Plan,
  Delivery, Agents, Browser, and Review belong in the dock (0044).
- Local servers are compact rows, grouped by process and port, with the
  current checkout separated from other listeners. Stop appears only when
  Octant owns a safe stop; an unmanaged process says so and has no fake stop
  control.
- Working-folder changes are a focused action, not a permanent field. The
  resulting relative folder returns to the compact summary.
- A stored floating, pinned, or hidden presentation, and any stored panel
  width, are dropped at the persistence seam before the wire schema decodes.

## Consequences

- The thread pane owns its column. The readable-width floor and the
  narrow-viewport overlay that existed only to protect the pane from a pinned
  panel have nothing left to fight.
- Anyone who wants the environment permanently in view no longer has a way to
  keep it in the row. That is the trade: a glance closes; a surface that must
  stay open belongs in the dock (0044).
- 0015 remains Accepted. This record supersedes only its environment
  presentation rule — persisted floating, pinned, or hidden. Everything else
  in 0015 stands, including that the environment belongs to a thread and
  follows the authoritative thread.

## Related

- 0015 defines the shell rule this record amends.
- 0041 makes the dock follow the active pane.
- 0044 owns the working tools that no longer live in Environment.
