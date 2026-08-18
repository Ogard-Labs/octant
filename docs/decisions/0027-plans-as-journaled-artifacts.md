# 0027. Plans as journaled artifacts

**Status:** Accepted

## Context

Plan was only an access posture: a Code thread could be told to read and not
write, and whatever it then wrote came back as prose in the transcript. A plan
that lives in prose cannot be pointed at, cannot be revised without rewriting
the conversation, cannot record which of its steps has actually been done, and
cannot be approved — the only gesture near it was the posture dropdown, which
says what a thread may do and nothing about whether its intentions were agreed.
Octant needed the plan itself to be a thing the host holds.

## Decision

- A thread's plan is a journaled aggregate of its own: an ordered list of steps,
  each with a title, an optional rationale, and a status. It is versioned like
  every other aggregate, rebuilt by replay, and scoped to one thread; a thread
  has at most one live plan.
- A plan is proposed as a whole and approved as a whole. Approval names the
  exact revision that was read. Rewriting the steps mints a new revision and
  returns the plan to proposed, because approving a plan approves the wording
  someone actually read, not a heading it still shares.
- Approval is its own recorded gesture and nothing else performs it. Changing a
  thread's access posture — including leaving Plan mode — says what the thread
  may do and never that its plan was agreed. A plan may be proposed, revised,
  and approved under any posture, Plan mode included: deciding what to do is
  what a read-only thread is for.
- Steps become work only once the plan they belong to is approved. Until then
  the host refuses to start, finish, or drop one. A step that survives a
  revision keeps the status it had, because it is the same step and the work
  done to it really happened.
- The plan is the thread's task list; there is no second one. Steps carry their
  own status rather than being copied into another aggregate, which keeps 0015's
  rule that boards monitor real threads instead of becoming a task system.
- A proposal cannot claim its own progress: position comes from the order steps
  were written and status from the plan's own transitions, so neither a person
  nor a provider can submit a plan whose steps are already done.
- The plan is rendered where it is used — beside the transcript it came out of
  and in the thread's own panel — from one controller, so two surfaces cannot
  show two revisions of it. Assistant messages in Code render as markdown, so a
  plan written in prose reads as the list it is.

## Consequences

- Approval survives restart and states exactly what was agreed, so "the plan was
  approved" is answerable from the journal rather than from memory of a chat.
- Revising a plan is cheap and honest: the previous wording stays in history and
  the approval does not silently carry over.
- One plan per thread keeps the model small; work that needs several plans is
  several threads, which is the linkage the thread hierarchy already provides.
- Steps are not yet fannable into linked threads and are separate from Chat's
  `ThreadWorkItem`. Both remain possible later; neither is required for a plan
  to be a durable, approvable artifact.

## Related

- 0002 Durable event journal and rebuildable projections
- 0003 Product modes: Chat, Work, and Code authority
- 0009 Sandbox confinement, approvals, and Plan mode
- 0015 Workspace shell model
