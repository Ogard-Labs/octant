---
description: Child agent runs, their hierarchy, isolation, recovery, and how results are acknowledged.
---

# Subagents

Subagents are child agent runs that a thread can start to delegate research,
implementation, or review. They are one durable **AgentRun** each and inherit
the parent thread's provider, model, and authority ceiling.

## Availability

Subagent infrastructure — contracts, journaling, projection, the
orchestration service, process supervision, and packaged child smoke — is on
`main`. **Settings → Octant Harness → Helper agents** holds the
server-authoritative child-creation posture: **Off**, **Only when I start
them** (Ask), or **Automatically**. Role cards,
mixed-vendor routing per role, and a child-creation form remain planned; the
**Add agent** action in a Chat, Work, or Code thread opens the Agents dock tool. The dock is also available on an existing thread before the first child exists. Off posture still opens Agents and shows a visible refusal instead of a create form. What you can use today is compact child-run status on a live
parent thread in Chat, Work, or Code — how many children are working, waiting,
or blocked, with a stop control that cancels only that thread's children — and
the read-only
**Agents** hierarchy panel in Code threads, which shows active and history
runs, posture, usage quality, recovery state, and an **"Acknowledge result"**
button. Opening the list from the header chrome uses that same hierarchy, not
a second surface. Rows carry a "native read-only" marker when the child runs
inside the provider's own runtime.

**Agents** on the workspace rail is the same hierarchy across Chat, Work, and
Code. On a wide window it can switch between **List** and **Graph**. Graph
places each parent thread above the child runs it launched, and a child under
the run named by `parentRunId` when that parent is on the same page. It is a
layout of the current query, not a swarm board and not a live Canvas. Cards
show role, model, recency, and IN/OUT only when the provider reported token
usage; estimated or missing usage is never shown as zero. Graph can **Save as Canvas**, which writes a versioned diagram document of that parent thread's forest — not a live board. Narrow layouts stay
on List.

This page documents the designed behavior so you know where the product is
going. Where a control is not yet available, the page says so explicitly.

Compact child-run status on the parent thread is current. The read-only
**Agents** hierarchy panel in Code is also current. The approved later
placement keeps that compact header status and opens Agents as a right-dock
tool only when children exist or you explicitly add an agent; it is not a
generic Thread-tab accordion.

## Roles and execution kinds

Every child is one **AgentRun** with an execution kind of `provider-native`
or `octant-managed`, and a role of **Research**, **Implementation**,
**Review**, or **Custom**. Children normally inherit the parent's
provider/model/reasoning. Mixed-vendor routing is **opt-in and disabled by
default**; enabling it opens role-card setup for Research, Implementation,
and Review, with advanced rules behind an **Advanced** disclosure.

A provider's own subagent feature stays off inside Octant, because a child it
starts itself would run where Octant cannot show it or answer its approvals.
Claude, OpenCode, and Devin turn theirs off through their own settings. Codex
starts with its multi-agent features and `agents.enabled` switched off for
that run only; your `CODEX_HOME` and `config.toml` are left as they are.

## Posture and clamps

Creation postures are **Off**, **Only when I start them** (Ask, the default),
and **Automatically** within policy. Off also refuses **Add agent** in the
Agents dock. Under Ask, starting a helper from the dock is the confirmation;
there is no separate prompt, and only the Octant Harness model's `delegate` tool
is refused. Provider-native subagents are not governed by this posture: Octant
keeps them off where the provider allows it. The server enforces hard clamps:

- At most **4 concurrently running children** globally.
- At most **3 children per parent**.
- At most **2 levels of hierarchy depth**.

Saturation queues visibly or returns a structured limit result. Authority is
an immutable ceiling set at start — a child can narrow it, never widen it.

## Isolation by mode

- **Chat** children are research-only: no implicit filesystem or shell access.
- **Work** children stay inside the one OS-confined Project root.
- **Code** children get **isolated worktrees** by default; the worktree must
  be verified before the child starts, and failure prevents running in the
  parent checkout.

## Lifecycle, cancellation, and recovery

Lifecycle statuses are **Queued**, **Starting**, **Running**, **Waiting**,
**Completed**, **Failed**, **Cancelled**, and **Interrupted**. Ambiguous
cancellation or restart resolves to **Waiting** or **Interrupted**, never
**Completed**.

Cancellation is leaf-first; a run is **Cancelled** only after its stop is
confirmed. After a restart, Octant rebuilds the hierarchy, resumable runs
reconnect, and non-resumable runs become **Interrupted** with a restart or
retry. Approvals, tasks, outputs, transcripts, and usage are retained.

## Following up on results

Child results must be **acknowledged** by the parent. On a terminal parent
turn, unacknowledged, failed, interrupted, waiting, or unfinished descendants
raise one concrete persistent follow-up reason, which also appears on the
runtime-derived [Code Thread Board](/advanced/code-board).

## What subagents do not do

Octant does not implement Swarm, a general task Kanban, or peer-to-peer
agent messaging. Active children cannot be detached, and there are no hidden
per-thread routing rules. Token and monetary ceilings are enforced as hard
limits only when the provider reports reliable usage or cost.

## Next steps

- [Context budgets and limits](/advanced/context-budgets) for shared capacity
- [Git and worktrees](/advanced/git-worktrees) for child isolation in Code
- [Recovery and troubleshooting](/advanced/recovery) for interrupted runs

Agents Center and the thread hierarchy offer steering only for running or waiting
runs. Waiting runs and recoverable interrupted runs offer Resume. If a restart
left no resumable execution, use Retry instead; the host still validates every
control request against the current run state.
