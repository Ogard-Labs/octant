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
them** (Ask), or **Automatically**. Role cards and mixed-vendor routing per
role remain planned.

A thread's subagents that are working, or finished and not yet reviewed, show
in its composer in Chat, Work, and Code: one row each with its task and its
state in words, such as "Working · 12s" or "Done — review". Hover or focus a
row to **Stop** a working subagent or **Mark reviewed** a finished one;
**Stop all** asks first and cancels only that thread's subagents. Choosing a
row opens the **Agents** dock tool on that subagent. Once a subagent is
reviewed it leaves the composer and stays in Agents.

The **Agents** dock tool lists the thread's subagents under **Working** and
**Finished**, marks results you have not reviewed with **Needs review**, and
offers **New** to start one; on a thread with none, the New subagent form is
already open. Off posture still opens Agents and shows a visible refusal
instead of a create form. Choosing a row opens its page: the task as the brief,
then its replies, live while it runs, or its retained final reply once the live
conversation is gone. **Mark reviewed**, **Steer**, **Retry**, **Resume**, and
**Cancel** sit under the conversation when they apply. A subagent that runs
inside the provider's own runtime says so on its page.

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

The composer tray and the Agents dock tool are current. Agents is a
right-dock tool, not a generic Thread-tab accordion.

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
and **Automatically** within policy. Off also refuses **New** in the
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
