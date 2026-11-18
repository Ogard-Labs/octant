# Sub-thread progress in a thread

Status: Building (slice 1 of 2)
Size: Small — changes inside the settled subagent surfaces of the thread view
Owner: maintainers · Started: 2026-11-18 · Approved: 2026-11-18, maintainers ("start the orchestrator sub-thread fixes", from the ranked assessment)

A working plan. As each slice lands, its rules move into
[Thread view: Subagents in a thread](thread-view.md#subagents-in-a-thread) and
[Decisions and requirements](decisions.md) in the same PR.

## Requirements

Source: a maintainer compared a thread that runs subagents with a reference
where the parent says plainly what it waits on, finished children read as one
quiet line, and every row opens its child. An assessment of the current
surfaces (2026-11-18) ranked the gaps below.

- FR-1 (Must): A subagent row in the transcript opens that child, as the
  card's rows do. AC: clicking the row, or Enter on it, opens the child in
  Agents; the row keeps its look and its state mark's slot.
- FR-2 (Must): The card's rows and the dock overview's subagent rows show how
  long each child has run, by the transcript row's rule (from its request or
  first sight to its last update, ticking while it works), at the trailing
  edge in a slot of fixed width. AC: a working child's time ticks; a finished
  child's time stops at its last update; nothing moves when it finishes.
- FR-3 (Must): While the card is folded, nothing needs attention and children
  are working, its head reads one line, "Waiting on <A>, <B> and N others",
  each name a child's short task and a link that opens it. AC: with three
  working children the head names two and says "and 1 other"; with a failed
  child or a result to review, the head keeps its counts, attention first.
- FR-4 (Should): A finished child's delivered result reads as one quiet
  centred line, "<Role> subagent finished · worked 48s", with the reply behind
  Show result. A child that stopped or failed keeps today's card. AC: the line
  shows the run time by FR-2's rule; Show result opens the card's body in
  place; keyboard reaches it.
- FR-5 (Should): One name across surfaces: the dock overview's group that
  lists subagent runs says "Subagents", as the card does. AC: no surface that
  lists only subagent runs calls them "Background tasks".

## Scope

- In: FR-1 to FR-5.
- Out: a separate "running children" chip beside Scroll to end. The folded
  card already sits there and FR-3 gives it the same one line, so a chip
  would show the same list twice (ruled here, 2026-11-18).
- Later: run time in the coordinator's Workers panel (workers are long-lived
  threads, so their age reads differently); showing workers in the sidebar by
  default (a maintainer chose off, 2026-11-15).

## Design

- FR-1: `apps/web/src/agents/threadSubagents.tsx` rows become one button
  each, calling the existing open-child handler the card uses; the Code and
  Work workspaces pass it.
- FR-2: one pure `subagentRunTime(row, now)` beside `buildSubagentRows`
  (`subagentRows.ts`), used by the transcript row, the card
  (`ComposerSubagentsTray.tsx`) and the dock overview
  (`DockThreadOverview*.tsx`). The spec line "Age is explicitly time since the
  last update … never inferred execution duration" changes to the
  transcript's rule, which is measured, not inferred.
- FR-3: the card's folded head reads the same shared summary; names are the
  task's first line, cut to fit, as links.
- FR-4: `ChildResultCards.tsx` renders the finished case as a quiet line with
  a disclosure; the transcript keeps its order.
- FR-5: the dock overview's label, after checking that group lists only
  subagent runs.

## Build plan

1. FR-1, FR-2, FR-5: rows open their child, real run time everywhere, one name.
2. FR-3, FR-4: the waiting line and the quiet finish line.

Each slice: focused tests, a visual-check scene if a covered screen changes,
and the spec moved into thread-view.md.

## Change log

- 2026-11-18: first draft, approved with the request to start.
