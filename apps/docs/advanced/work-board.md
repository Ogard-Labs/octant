---
description: The runtime-derived Work Thread Board, its statuses, Project grouping, filters, and delivery confirmation.
---

# Work Thread Board

The Work Thread Board is a server-authoritative, runtime-derived view of your
Work threads. It groups whole threads — never work-list items, issues, or
generic tasks — and opens from the Work sidebar's **Thread board** action.

## Derived statuses

Statuses come from one shared Work and Code domain policy, each with a
specific reason. Cards cannot be dragged or moved; grouping is a pure
projection over one ordered card set.

- **Ready** — configured, queued, or idle with unmet delivery criteria.
- **In progress** — a provider turn, tool, or child run is actively executing.
- **Waiting** — needs approval or input, an interrupted turn, recovery, or
  stale or ambiguous delivery evidence. The specific reason stays on the card.
- **Done** — the user-confirmed Work delivery target is objectively satisfied.
  A completed model turn is not enough.

**Done** is a first-class visible status in both groupings, with no implicit
completed-item suppression. Ambiguous evidence becomes **Waiting**, never
**Done**. Unread is a client overlay and is not part of the server card.
Refresh re-queries local authoritative state and keeps the last useful view
while refreshing or on failure.

## Grouping

The **Group by** control switches between **Status** and **Project** and is
remembered per client device (not authoritative host state).

- **Status** grouping shows compact columns with cards sorted by most recent
  meaningful activity; the Work Project appears as metadata. Empty columns
  stay narrow so they do not consume most of the window.
- **Project** grouping shows one column per Work Project; cards keep a
  text-and-icon status badge and sort **Waiting → In progress → Ready →
  Done**, then by most recent activity.
- At a narrow width the same card set becomes a grouped list. Waiting
  reasons remain visible in both layouts.

Shared toolbar filters include text search, status, Work Project, pending
request, and follow-up.

## Card metadata

Cards carry thread and Project identity, derived status and reason, the
confined root binding (working directory and Project binding revision),
active request, artifacts, citations, goal or delivery state, child runs,
follow-up, recovery, and last meaningful activity. Opening a card activates
that exact Project and thread. Work is OS-confined: cards never carry a Git
checkout, worktree, or pull request.

## Delivery targets

A Work thread is Done only when you confirm the current delivery target —
the thread title — with bounded satisfaction evidence. Agents cannot mark
the thread complete. Stale citations, a mismatched binding revision, or
outstanding child-run results keep the thread in **Waiting**.

## Out of scope

Manual card movement or status assignment, a general issue or task Kanban,
due dates, estimates, assignees, and custom columns are not part of the
board. Chat has no board. Persistent work-list items never become board
cards.

## Next steps

- [Work](/guide/work) for confinement, artifacts, and research
- [Code Thread Board](/advanced/code-board) for the shared status policy on Code threads
- [Subagents](/advanced/subagents) for child runs that appear on cards
- [Recovery and troubleshooting](/advanced/recovery) for blocked or waiting threads
