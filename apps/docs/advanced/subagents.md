---
description: Child agent runs, their hierarchy, isolation, recovery, and how results are acknowledged.
---

# Subagents

Subagents are child agent runs that a thread's agent starts to delegate
research, implementation, or review. They are one durable **AgentRun** each and
run under the parent thread's authority ceiling. Their provider and model can
come from the parent, a configured role slot, or an explicit eligible target.

Only the thread's agent starts a subagent. Octant's harness and supported
provider harnesses both hand bounded tasks to the same host-managed child
runtime, and both can collect results and continue a completed child. An
Octant-harness parent can use a provider-harness child and the reverse. You watch and control subagents from the composer and
the **Agents** dock tool, but you do not start them there; a subagent a person
started by hand would have no agent to hand its result back to.

A managed child can also author a Canvas in the workspace the host resolved for
that run. The document appears on the parent thread, and the child is recorded
as its author. A provider that cannot carry Octant's tools does not start the
child.

## Observations and result evidence

Managed children retain their existing controls. A provider-owned child report,
when a provider supports it, is a read-only observation with its own identity and
bounded activity history. Unknown model or history stays unknown. Observations
cannot be messaged, cancelled, steered, or resumed through managed-child controls.
The current bundled adapters keep native children disabled or unsupported, so
there is no verified native-child observation support from those adapters.

A result belongs to one child, execution generation, provider/model and workspace.
Follow-ups preserve earlier generations. The child’s reported summary is separate
from recorded lifecycle blockers, provider-reported file changes, and tools the
host actually executed. File reports are unverified; a tool return is not proof
that tests passed. Missing and truncated evidence is shown explicitly. A completed
child does not establish review, merge, deployment, or completion of its parent.

For writable Code children, **Review changes** opens the host's saved comparison
for that generation in **Review**. It includes committed changes and non-ignored
new files from the child's own workspace. Later follow-ups keep separate
comparisons. Captured file links open this saved diff; they do not open the
parent's current files. Review identifies partial or binary content and offers no
staging or discard controls for saved child results.

A waiting child can update its comparison when it settles again. If its original
baseline is missing after a restart or Git cleanup, review is unavailable rather
than showing only the resumed portion. Chat, Work and Plan children have no Git
review capture. Failed captures and older sessions without a baseline also show
review unavailable. Provider file reports remain separate, unverified claims.
Tool records retain bounded output for inspection. Deleting the parent's content
removes saved comparisons, tool records and earlier result text.

## Availability

Subagent infrastructure — contracts, journaling, projection, the
orchestration service, process supervision, and packaged child smoke — is on
`main`. **Settings → Octant Harness → Helper agents** holds one
server-authoritative switch, **Let the agent start subagents**: on (the
default) or off. **Settings → Octant Harness → Model slots** configures shared
role routing for both Octant and provider harnesses; Projects can override it.

A thread's subagents appear in a compact card above its composer in Chat,
Work, and Code. It starts collapsed and remembers your choice. Its counts keep
failed, waiting and unreviewed children visible. Expand it to preview up to
three active or unresolved children with their task, status, model and last
reported activity. **View all** opens the full **Agents** list, including finished
children. A row opens that child's detail. **Stop** acts on one managed child;
**Stop all** asks first and cancels only this thread's managed children.
Observation-only rows have no execution controls. **Environment → Subagents**
also lists managed children and marks results you have not reviewed **To review**.

When the agent reports a task list, its separate collapsed header shows completed
steps and failed or waiting counts. Expand it to read the steps. Task progress
does not indicate that subagents or the parent delivery are complete.

The **Agents** dock tool lists the thread's subagents under **Working** and
**Finished** and marks results you have not reviewed with **Needs review**. On
a thread with none it says they appear when the agent hands off part of its
work, or that subagents are turned off in Settings. Choosing a row opens its page: the task as the brief,
then its replies, live while it runs, with a bounded saved conversation after
restart. Older entries may be omitted; the view identifies truncation or stale
history. **Mark reviewed**, **Steer**, **Retry**, **Resume**, and
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
**Review**, or **Custom**. Research uses **Research and tasks**, implementation
and custom work use **Main model**, and review uses **Careful review** in Model
slots. An unconfigured route can use the parent's eligible model. A configured
route that is unavailable reports that problem rather than silently choosing a
different provider. The lead can also name an eligible provider, model, and
supported reasoning setting for a specific child. All choices retain the same
authority and budget checks.

A provider's own subagent feature stays off inside Octant, because a child it
starts itself would run where Octant cannot show it or answer its approvals.
Claude, OpenCode, and Devin turn theirs off through their own settings. Codex
starts with its multi-agent features and `agents.enabled` switched off for
that run only; your `CODEX_HOME` and `config.toml` are left as they are.

## Posture and clamps

**Let the agent start subagents** is on by default: the agent's `delegate`
calls start subagents within the thread's access and the clamps below. Turned
off, every `delegate` call is refused and the agent does its work itself;
subagents it already started stay readable and controllable. A host that had
chosen the retired **Only when I start them** reads as off, because nothing else
could start a subagent under it. Provider-native subagents are not governed by this posture: Octant
keeps them off where the provider allows it. The server enforces hard clamps:

- How many children **run at once** is yours to set in **Settings → Octant
  Harness → Helper agents**: per thread (default 4) and across the app
  (default 8), each up to 16. A child that is only waiting — for the children
  it depends on, or for a free slot — does not take a slot.
- At most **16 unfinished children per parent** and **32 across the app**,
  waiting ones included, so a runaway agent cannot pile up work.
- At most **2 levels of hierarchy depth**.

A child with no free slot waits visibly and starts when one frees up; past the
unfinished cap, the start is refused with a structured limit result. Authority is
an immutable ceiling set at start — a child can narrow it, never widen it.

## Isolation by mode

- **Chat** children are research-only: no implicit filesystem or shell access.
- **Work** children stay inside the one OS-confined Project root.
- **Code** children get **isolated worktrees** by default; the worktree must
  be verified before the child starts, and failure prevents running in the
  parent checkout. Concurrent children use separate worktrees, starting from
  the parent's committed revision. Uncommitted parent edits are not copied.

## Lifecycle, cancellation, and recovery

Lifecycle statuses are **Queued**, **Starting**, **Running**, **Waiting**,
**Completed**, **Failed**, **Cancelled**, and **Interrupted**. Ambiguous
cancellation or restart resolves to **Waiting** or **Interrupted**, never
**Completed**.

Cancellation is leaf-first; a run is **Cancelled** only after its stop is
confirmed. After a restart, Octant rebuilds the hierarchy and identifies
interrupted work. **Resume** reconnects to the saved provider session, keeping
its conversation and verified workspace. If the provider cannot resume it, the
saved session is missing, or its authority no longer matches, Octant refuses
Resume and asks you to use **Retry**, which starts a new execution.

When a child needs an approval or an answer, the composer shows **A subagent
needs your input**. **Review request** opens its detail view. The request names
the child, provider, and model. Allowing a child action covers that request
only; it does not grant access to siblings or later requests. Unanswered
requests expire when the child stops or Octant restarts.

**Steer** sends a note to a running child when its provider supports it.
Octant's harness applies the note at the next complete response or tool-results
boundary; Codex delivers it to the active turn. An unsupported provider reports
that the note was not delivered.

A run waiting for other runs to finish never starts on its own after a
restart, even once they finish: **Resume** on the run, or resuming the parent
thread, lets it go. While the parent thread is paused, or needs a check after
a restart, a waiting run stays waiting too, and its own **Resume** asks you to
resume the parent thread first.

## Following up on results

Finished siblings can return together in one parent turn. Octant does not wait
for the entire group: independent results can reach the parent while other
children are still working. Saved delivery records prevent a restart from
delivering the same result twice.

Open a completed managed child and choose **Follow up** to send another
instruction in its existing conversation. The parent agent can do the same
through either delegation tool. The provider must support genuine resume; if
it cannot, start a new delegation from the parent. Cancelled children cannot
continue. The earlier conversation stays available, and the new reply needs
its own acknowledgement. The previous reply must reach the parent or be
collected before a follow-up starts. Checking status does not collect it; an
oversized reply remains available when a tool cannot return it completely.
A follow-up also requires the child's provider, model, and reasoning choice to
remain available under the parent's current Project policy.
If capacity or the spend ceiling refuses a follow-up, the completed reply and
your draft stay available so you can retry. Once accepted, the follow-up is saved
with the child. If its connection fails before sending, the child becomes
interrupted; choose **Resume** to send the saved follow-up in its existing
conversation. Recovery sends an unsent follow-up as written; if delivery is
uncertain, Octant says so and preserves it for inspection rather than silently
sending it again.

When the lead includes parent context, the child receives a bounded, attributed
selection of accepted prompts and completed replies. Missing or omitted text
is identified; private reasoning and tool bodies are excluded.

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
