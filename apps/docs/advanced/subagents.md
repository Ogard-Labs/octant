---
description: Child agent runs, their hierarchy, isolation, recovery, and how results are acknowledged.
---

# Subagents

Subagents are child agent runs that a thread can start to delegate research,
implementation, or review. They are one durable **AgentRun** each and inherit
the parent thread's provider, model, and authority ceiling.

## Availability

Subagent infrastructure — contracts, journaling, projection, the
orchestration service, process supervision, and packaged child smoke — is
landing on `main`. The full user-facing flow, including
**Settings → Agents**, role cards, mixed-vendor routing, and a child-creation
interface, remains a planned part of the technical-preview program. What you
can use today is the read-only **Agents** hierarchy panel in Code threads,
which shows active and history runs, posture, usage quality, recovery state,
and an **"Acknowledge result"** button. Rows carry a "native read-only"
marker when the child runs inside the provider's own runtime.

This page documents the designed behavior so you know where the product is
going. Where a control is not yet available, the page says so explicitly.

## Roles and execution kinds

Every child is one **AgentRun** with an execution kind of `provider-native`
or `octant-managed`, and a role of **Research**, **Implementation**,
**Review**, or **Custom**. Children normally inherit the parent's
provider/model/reasoning. Mixed-vendor routing is **opt-in and disabled by
default**; enabling it opens role-card setup for Research, Implementation,
and Review, with advanced rules behind an **Advanced** disclosure.

## Posture and clamps

Creation postures are **Off**, **Ask** (the default), and **Automatic within
policy**. The server enforces hard clamps:

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
