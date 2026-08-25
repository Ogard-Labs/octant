# 0048. Board cards summarize plan progress

**Status:** Accepted

## Context

0027 keeps a thread's plan as its one task list and forbids copying step
status into a second aggregate, reasoning that this is what keeps 0015's
boards honest monitors instead of a second task system to maintain.
Dogfooding the Code board asked for a plainer signal than the card's existing
facts give today: how much of a thread's approved plan is actually done,
without opening it. 0045 already resolved the analogous question for
Environment — a compact count, not the transcript — by adding a narrow,
explicitly scoped exception rather than reopening 0042 wholesale. This record
does the same for 0027.

## Decision

A Code board card may show a plan's step-completion count as one compact
fact, alongside the card's existing child-run and activity facts.

- The card carries only `{done, total}`: a derived, read-time count of the
  active plan's step statuses (0027). It never carries step titles,
  rationale, or per-step status. Nothing new is persisted and no second
  aggregate is created — the rule 0027 protects is that steps are not copied
  elsewhere as their own durable list; a request-time count computed from the
  thread's own plan is not a copy.
- The count is absent whenever the thread has no live plan
  (`plan === null`), matching 0027's "at most one live plan" and 0044's
  "Plan is artifact-gated." It therefore appears on a minority of Code cards
  and never on Work cards, because Plan remains Code-only.
- The board never lets a person read, revise, approve, or expand steps from a
  card. That stays exactly where 0044 puts it: the active thread's dock, one
  controller, one surface for the real artifact. The board links to the
  thread; it does not grow a second Plan surface.
- Computing the count reads the same per-thread `JournalPlanStore`/
  `PlanService` state the dock already reads (0027) — no new subsystem, no
  new write path.

## Consequences

- A triager scanning the Code board can tell a thread's plan is, for
  example, 3 of 7 steps done without opening it — closing for plans the same
  gap 0045 already closed for subagents.
- 0027 is superseded only where it read as forbidding any board-level signal
  derived from plan steps. Its aggregate design, one-plan-per-thread rule,
  approval flow, and "the dock is where a plan is read, revised, and
  approved" rule are unchanged and still binding.
- 0015's "boards stay honest monitors... not a second task system" still
  holds: the board cannot create, edit, or complete a step, only report a
  count computed from the thread's own plan.

## Related

- 0015 Workspace shell model
- 0027 Plans as journaled artifacts
- 0044 The dock hosts live thread-owned tools
- 0045 Environment summarizes the active thread
