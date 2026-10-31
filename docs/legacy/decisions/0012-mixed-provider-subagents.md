# 0012. Mixed-provider subagents and agent runs

**Status:** Accepted

## Context

Delegation appears in three shapes: a provider's own child agents, an
independent Octant-managed provider session, and cross-provider handoff (for
example research on one model, implementation on another, review on a third).
Provider-native subagents alone give inconsistent visibility, routing,
cancellation, and recovery; Octant-managed only discards useful native context
sharing. Users also need to see, constrain, stop, and recover every child
regardless of which vendor runs it, and children must never gain more
authority than their parent.

## Decision

- Every child is one durable Octant-owned `AgentRun` with a stable id, parent
  thread and optional parent run, depth, bounded task and expected result,
  role (Research, Implementation, Review, or Custom), execution kind
  (`provider-native` or `octant-managed`), provider instance id, model id,
  raw and normalized reasoning settings, selected context and memory subset,
  workspace and repository identity, effective authority, worktree and branch
  metadata, normalized lifecycle status, task list, approvals, output,
  artifacts, usage, and terminal reason. A child provider is never inferred
  from the parent provider's name.
- Provider-native execution is an optimization used only when it satisfies the
  requested routing, authority, workspace, observability, cancellation, and
  recovery requirements; otherwise Octant starts a managed child. Core
  delegation never depends on one provider's native subagent feature.
- Normalized statuses are Queued, Starting, Running, Waiting, Completed,
  Failed, Cancelled, and Interrupted. Provider-specific detail is kept
  alongside without changing the product state.
- Creation posture is global with three values: Off, Ask (default; the user
  approves each start), and Automatic within policy. Mixed-vendor routing is
  off by default; children inherit the parent provider, model, and compatible
  reasoning. Enabling it opens role cards for Research, Implementation, and
  Review with an explicit fallback per role (normally inherit parent).
- Effective policy resolves as global defaults and safety ceilings, optional
  Project overrides, one-off child selection, then parent and mode authority
  clamps. Project overrides can lower but never exceed global ceilings or
  parent authority. No hidden per-thread routing state is stored.
- A child receives an immutable authority ceiling at start that is equal to or
  narrower than its parent and mode: Chat children are research-only, Work
  children stay inside the confined root, Code children get isolated worktrees
  by default and cannot start in the parent checkout if worktree creation or
  verification fails. Child sandbox profiles derive from the clamped
  authority, never from the parent's raw profile. All child tool calls pass
  through ordinary capability policy and approvals.
- Bounded by default: four concurrent children globally, three per parent,
  depth two. Excess children queue visibly. Only measurable limits are hard
  (concurrency, depth, runtime, allowlists, workspace, permission ceiling);
  token and cost ceilings are hard only when the provider reports reliable
  usage or accepts an enforceable budget. Unknown cost is never shown as zero;
  automatic fallback never picks a more expensive model unless configured.
- Every state transition is journaled before the external side effect counts
  as committed; duplicate, delayed, or out-of-order provider events apply
  idempotently. Cancellation proceeds leaves-up and completes only after the
  process is confirmed stopped; ambiguity becomes Waiting, Failed, or
  Interrupted, never Completed. After restart, hierarchies rebuild, resumable
  children reconnect, and non-resumable ones become Interrupted with a retry
  action.
- Every child is a navigable thread or normalized activity transcript in a
  parent/child hierarchy that shows provider, model, reasoning, status,
  current task, workspace, approvals, elapsed time, and honest usage. Parent
  threads in every mode expose compact live child status and a stop control
  that cancels only that parent's live children. Results return as findings,
  artifacts, patches, diffs, or pull requests and are acknowledged in the
  parent; unfinished child work raises the parent's follow-up.
- Every dispatched child passes through the provider capacity scheduler.
- There is no separate "swarm" or team surface; the hierarchy is the product.

## Consequences

- Users get one mental model and one UI for delegation across vendors, with
  routing choice as an opt-in rather than a default surprise.
- Provider-native children are used when they are safe, so native context
  sharing is not lost, but a provider that cannot meet the guarantees is
  simply bypassed with a managed child.
- Worktree-per-child costs disk and time and demands cleanup discipline; it
  buys isolation and honest attribution of changes.
- Concurrency and depth defaults are conservative and adjustable within
  ceilings; automatic mode is powerful only where accounting is reliable.

## Related

- 0003 Product modes and authority
- 0007 Direct API providers and the native agent harness
- 0008 Context budget and capacity scheduling
- 0009 Sandbox confinement, approvals, and Plan mode
- 0044 The dock hosts live thread-owned tools
