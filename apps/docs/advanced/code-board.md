---
description: The runtime-derived Code Thread Board, its statuses, Project grouping, filters, and delivery targets.
---

# Code Thread Board

The Code Thread Board is a server-authoritative, runtime-derived view of your
Code threads and their coding agents. It groups whole threads — never work-list
items, issues, or generic tasks — and opens from the Code sidebar's **Thread
board** action.

## Derived statuses

Statuses come from one shared Work and Code domain policy, each with a
specific reason. Cards cannot be dragged or moved; grouping is a pure
projection over one ordered card set.

- **Ready** — configured, queued, or idle with unmet delivery criteria.
- **In progress** — a provider turn, tool, or subagent is actively executing.
- **Waiting** — needs approval or input, an interrupted turn, recovery, or
  stale or ambiguous delivery evidence. The specific reason stays on the card.
- **Done** — the user-confirmed delivery target is objectively satisfied. A
  completed model turn is not enough.

**Done** is a first-class visible status in both groupings, with no implicit
completed-item suppression. A thread you **Complete** from the sidebar is
different: you put it away, so it leaves the board until you reopen it or
send it a new message. Ambiguous evidence becomes **Waiting**, never
**Done**. Unread is a client overlay and is not part of the server card.
Board queries never call GitHub; they may show manually refreshed PR evidence
with freshness. Exact PR identities produced by a Code thread survive restart
without making cached GitHub status authoritative: before the next manual PR
refresh, the board labels their status **Unknown** and stale.

## Grouping

The **Group by** control switches between **Status** and **Project** and is
remembered per client device (not authoritative host state).

- **Status** grouping shows compact columns with cards sorted by most recent
  meaningful activity; the Code Project appears as metadata. Empty columns
  stay narrow so they do not consume most of the window.
- **Project** grouping shows one column per Code Project; cards keep a
  text-and-icon status badge and sort **Waiting → In progress → Ready →
  Done**, then by most recent activity.
- At a narrow width the same card set becomes a grouped list. Waiting
  reasons remain visible in both layouts.

Shared toolbar filters include text search, status, Code Project,
provider/agent, pull-request and check state, delivery target, and follow-up.

## Card metadata

Cards carry thread and Project identity, derived status and reason, delivery
target and evidence state, provider and model with live activity, active
child-agent summary, checkout or worktree and branch, changed-file state,
linked PR and checks, review state, blocking or recovery reason, follow-up
state, and last meaningful activity. Linked PR summaries show Open, Draft,
Merged, Closed, or Unknown; **Ready to merge** requires fresh mergeability,
passing checks, and an approved review. Opening a card activates that exact
Project and thread.

## Delivery targets

Code delivery targets are **investigation result**, **local implementation**,
**opened PR**, and **merged PR**. A target is suggested at thread creation
from the prompt and must be **user-confirmed**. Agents may propose a change
but cannot lower or redefine the target without user confirmation. Stale
GitHub metadata is labeled stale and cannot satisfy a delivery target.

## Out of scope

Manual card movement or status assignment, a general issue or task Kanban,
due dates, estimates, assignees, and custom columns are not part of the
board. Chat has no board. Persistent work-list items never become board
cards.

## Next steps

- [Work Thread Board](/advanced/work-board) for the same statuses on Work threads
- [Git and worktrees](/advanced/git-worktrees) for the underlying repository state
- [Subagents](/advanced/subagents) for child runs that appear on cards
- [Recovery and troubleshooting](/advanced/recovery) for blocked or waiting threads
