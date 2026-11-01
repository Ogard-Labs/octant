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
A child that fails, is interrupted, or is cancelled tells its parent why, for
example that its provider is signed out. The reason is short, and Octant
removes private paths and secrets from it before the parent's agent sees it.

A Chat subagent runs read-only. Claude Code subscription accounts sign in
with the unmodified `claude auth login` command for that account. Sign in
from **Settings → Providers & Models** before a confined Plan or Chat-child turn;
until you do, the child stops and its parent is told to sign in. See
[Providers](/advanced/providers). Claude Code with an Anthropic API key, and
the other providers, need no extra step.

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
server-authoritative switch, **Let the agent start helper agents**: on (the
default) or off. **Settings → Octant Harness → Model roles** (slots, in the
CLI) configures shared role routing for both Octant and provider harnesses; Projects can override it.

A thread's subagents appear in a compact card above its composer in Chat,
Work, and Code, the same width as the message box. It starts collapsed and
remembers your choice. Its head names each state the children are in, such as
**1 failed · 1 working · 2 done**, and puts failed, waiting and unreviewed children
first. A result counts as **to review** only while you could still act on it: once
the host has handed a finished result to the thread's agent, the card counts it as
done. When a Chat thread cannot reach the host the card dims and **Stop** is
unavailable; the thread's connection notice says why. Expand it to preview up to
three active or unresolved children with their task, status, model and last
reported activity. **View all** opens the full **Agents** list, including finished
children, including in Chat. A row opens that child's detail, where its retained
final reply stays readable after completion. **Stop** acts on one managed child;
**Stop all** asks first and cancels only this thread's managed children.
Observation-only rows have no execution controls. **Environment → Subagents**
also lists managed children and marks results you have not reviewed **To review**.

A finished subagent's result appears in the thread as a card of its own, not as
a message from you: it names the subagent's role, its provider and model, the task
it was given and its reply. A long reply starts folded. The run ID, generation and
provider ID sit behind **Details**. A subagent that stopped without finishing says
so and gives the reason the host recorded.

When the agent reports a task list, its separate collapsed header shows completed
steps and failed or waiting counts. Expand it to read the steps. Task progress
does not indicate that subagents or the parent delivery are complete.

The **Agents** dock tool lists the thread's subagents under **Working** and
**Finished** and marks results you have not reviewed, and that the thread's agent
has not already received, with **Needs review**. On
a thread with none it says they appear when the agent hands off part of its
work, or that subagents are turned off in Settings. Choosing a row opens its page: the task as the brief,
then its replies, live while it runs, with a bounded saved conversation after
restart. Older entries may be omitted; the view identifies truncation or stale
history. **Mark reviewed**, **Steer**, **Retry**, **Resume**, and
**Cancel** sit under the conversation when they apply. A subagent that runs
inside the provider's own runtime says so on its page.

**Agents** on the workspace rail is the same hierarchy across Chat, Work, and
Code, for the threads open in this window: the thread in each mode's panes,
including pinned ones. A window reads only the threads in its own workspace, so
the children of a thread you have not opened here are not listed; open the
thread and its Agents tool shows them. On a wide window it can switch between **List** and **Graph**. Graph
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
**Review**, or **Custom**. Research uses **Research and lookups**, implementation
and custom work use **Main model**, and review uses **Careful review** in Model
slots. An unconfigured route can use the parent's eligible model. A configured
route that is unavailable reports that problem rather than silently choosing a
different provider. The lead can also name an eligible provider, model, and
supported reasoning setting for a specific child. All choices retain the same
authority and budget checks.

A provider's own subagent feature is off by default, because a child it starts
itself would run where Octant cannot show it or answer its approvals. Claude,
OpenCode, and Devin turn theirs off through their own settings. Codex starts
with its multi-agent features and `agents.enabled` switched off for that run
only; your `CODEX_HOME` and `config.toml` are left as they are. For Claude Code
and Codex you can let the provider run as itself, which turns its own subagents
on and shows each one in the thread as a subagent run. Codex also needs the
thread at Full access before it starts them; see
[Let a provider run as itself](/advanced/providers#let-a-provider-run-as-itself).

## Posture and clamps

**Let the agent start helper agents** is on by default: the agent's `delegate`
calls start subagents within the thread's access and the clamps below. Turned
off, every `delegate` call is refused and the agent does its work itself;
subagents it already started stay readable and controllable. A host that had
chosen the retired **Only when I start them** reads as off, because nothing else
could start a subagent under it. Provider-native subagents are not governed by this posture: they stay off
unless you let the provider run as itself. The server enforces hard clamps:

- How many children **run at once** is yours to set in **Settings → Octant
  Harness → Helper agents**: **At once in one thread** (default 4) and **At
  once across Octant** (default 8), each up to 16. A child that is only waiting — for the children
  it depends on, or for a free slot — does not take a slot.
- At most **16 unfinished children per parent** and **32 across the app**,
  waiting ones included, so a runaway agent cannot pile up work.
- At most **2 levels of hierarchy depth**.

A child with no free slot waits visibly and starts when one frees up. A Chat
helper whose model provider is busy with other requests shows **Waiting for a
free request slot** in Agents and starts by itself when the provider has room;
you can cancel it while it waits. After five minutes it stops waiting and
shows as Interrupted with the reason, and Retry starts it again. Past the
unfinished cap, the start is refused with a structured limit result. Authority is
an immutable ceiling set at start — a child can narrow it, never widen it.

A finished child's reply is outside content for its parent, so a thread that
took one in cannot start more helpers: the agent's next `delegate` is refused
with a message that says so. A person can review what the thread read and clear
that from the notice above the composer, or the work can continue in a new
thread. See [Privacy and security](/advanced/privacy-and-security).

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

A Work or Code subagent that is waiting also appears in **Needs you** on the
start screen, in the Inbox, in the command palette, and in the menu bar. The row names the parent
thread and the child (for example "Research subagent needs your approval") and
has one action, **Review request**, which opens the parent thread on its Agents
tab with that child selected. Answer there; the row has no Approve or Deny of
its own. This card lists Work and Code subagents only; Chat's Agents dock does not
add Chat subagents to the card.

**Steer** sends a note to a running child when its provider supports it.
Octant's harness applies the note at the next complete response or tool-results
boundary; Codex delivers it to the active turn. An unsupported provider reports
that the note was not delivered. The host answers only once the
child has taken the note, which can be most of a long response away, so the
subagent's page says **Sending the steering note** while it waits, then
**Steering note delivered**, and gives the reason when the host refuses one.

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
agent messaging. A Code thread's agent can leave a short message for another
thread of the same Project: Octant delivers it as untrusted data at the start
of that thread's next turn, starts nothing there, and returns no reply. When
Octant refuses such a message, whether the thread is in another Project, the
sender is in Plan, or the recipient closed, the Agents Center lists it with the
two threads and the reason, so a refusal is not seen by the sending agent
alone. Child runs are not part of that. Active children cannot be detached, and there are
no hidden per-thread routing rules. A child's turns count toward its parent
thread's and Project's spend ceilings like the parent's own. A child on a
provider that never reports usage, such as an ACP agent, is not measured
against the token or money budget, and the ceiling says so; a child on a
provider that can report usage but did not is never counted as free. See
[Spend ceilings](/advanced/usage-and-limits#spend-ceilings).

## Next steps

- [Context budgets and limits](/advanced/context-budgets) for shared capacity
- [Git and worktrees](/advanced/git-worktrees) for child isolation in Code
- [Recovery and troubleshooting](/advanced/recovery) for interrupted runs

Agents Center and the thread hierarchy offer steering only for running or waiting
runs. Waiting runs and recoverable interrupted runs offer Resume. If a restart
left no resumable execution, use Retry instead; the host still validates every
control request against the current run state.
