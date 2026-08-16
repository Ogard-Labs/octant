---
description: The runtime-derived Code Thread Board, its statuses, Project grouping, filters, and delivery targets.
---

# Code Thread Board

The Code Thread Board is a server-authoritative, runtime-derived view of your
Code threads and their coding agents. It groups whole threads — never work-list
items, issues, or generic tasks — and opens from the Code sidebar's **Thread
board** action.

## Derived statuses

Statuses are derived from the live server state, not manually assigned.
Cards cannot be dragged or moved; grouping is a pure projection over one
ordered card set.

- **Ready** — configured, queued, or idle with unmet delivery criteria.
- **In Progress** — a provider turn, tool, or subagent is actively executing.
- **Waiting** — needs approval or input, provider recovery, CI or review, or
  a dependency.
- **Done** — the user-confirmed delivery target is objectively satisfied.

**Done** is a first-class visible status in both groupings, with no implicit
completed-item suppression. Ambiguous evidence becomes **Waiting**, never
**Done**.

## Grouping

The **Group by** control switches between **Status** and **Project** and is
remembered per client device (not authoritative host state).

- **Status** grouping shows fixed columns with cards sorted by most recent
  meaningful activity; the Code Project appears as metadata.
- **Project** grouping shows one column per Code Project; cards keep a
  text-and-icon status badge and sort **Waiting → In Progress → Ready →
  Done**, then by most recent activity.

Shared toolbar filters include text search, status, Code Project,
provider/agent, pull-request and check state, delivery target, and follow-up.

## Card metadata

Cards carry thread and Project identity, derived status, delivery target and
evidence state, provider and model with live activity, active child-agent
summary, checkout, worktree and branch, changed-file state, linked PR and
checks, review state, blocking or recovery reason, follow-up state, and last
meaningful activity.

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

- [Git and worktrees](/advanced/git-worktrees) for the underlying repository state
- [Subagents](/advanced/subagents) for child runs that appear on cards
- [Recovery and troubleshooting](/advanced/recovery) for blocked or waiting threads
