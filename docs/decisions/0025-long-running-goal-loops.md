# 0025. Long-running goal loops

**Status:** Accepted

## Context

A thread carries a `ThreadGoal`: an objective, a budget in tokens, time, and
turns, the usage spent against it, and the evidence gathered toward it. Today a
person drives every turn against that goal by hand. The obvious next step is to
let a thread keep working on its own — pick up the goal again after a turn
finishes, on a schedule, or until the objective is met.

That is also the point where an assistant stops being something a person is
watching. An unattended loop with a thread's full authority can spend a budget,
change a checkout, push a branch, and call a paid API for an hour before anyone
reads a word of it. The interesting question is not how to run the loop; it is
what the loop is allowed to do while nobody is looking, and what makes it stop.

Scheduled work is outside the first release boundary. This record states the
shape so that goal, budget, checkpoint, and approval work done before then
composes into it rather than having to be unpicked.

## Decision

- A **goal loop** is a thread-scoped, server-owned iteration over an existing
  `ThreadGoal`. It introduces no new place work happens: each iteration is an
  ordinary turn in the thread that owns the goal, journaled like every other.
- **Budgets are the loop's stopping condition, not a display.** `ThreadGoalBudget`
  already carries token, time, and turn ceilings and `ThreadGoalUsage` the spend
  against them. A loop that would exceed any ceiling does not start the next
  iteration; the goal moves to `budget-limited`, which is a state a person
  resumes, never one the loop clears for itself.
- **Completion is evidence, not assertion.** A loop may only move a goal to
  `complete` by recording `ThreadGoalEvidenceRef` entries the host can point at
  — a passing test run, a written artifact, a review, a user confirmation. A
  provider saying it is finished is not evidence and does not end the loop.
- **An unattended iteration runs under a lowered ceiling, never the thread's
  own.** The loop declares an `AgentRunAuthority`-shaped ceiling at the moment
  the person starts it, and every iteration is clamped to the intersection of
  that ceiling and the thread's current authority. The ceiling can only narrow
  while the loop runs; widening it ends the loop and waits for a person.
- **The loop pauses at policy edges rather than deciding them.** Any effect that
  would need an approval a person is not present to give — the destructive and
  irreversible classes, privilege expansion, anything gated by external-content
  taint — suspends the loop with the request recorded, rather than being
  auto-approved because a loop is running. A standing grant a person gave
  earlier still applies; nothing new is granted by the loop's existence.
- **Every iteration marks a checkpoint** (0020) before it starts. A loop that
  ran overnight is therefore reviewable turn by turn, and any point in it can be
  taken up in a second thread without unwinding what the loop did.
- **A loop is visible while it runs and interruptible at any moment.** Pausing is
  the existing `pause-thread-goal` command and takes effect before the next
  iteration; an in-flight turn is cancelled by the existing turn cancellation.
- **Schedules are a trigger, not a second authority.** When a loop is started on
  a schedule rather than continuously, the schedule decides only _when_ an
  iteration may begin. Everything above still applies to it unchanged, and a
  schedule cannot start a loop on a thread whose goal is paused or complete.

## Consequences

- Long-running work becomes reviewable rather than merely observable: the record
  a loop leaves is a series of ordinary turns with checkpoints between them.
- Loops will stop often — a budget edge, an approval, a widened authority — and
  each stop is a state a person resumes. That is the intended cost; a loop that
  never stops is a loop nobody can supervise.
- Evidence-gated completion means a goal can be objectively unfinished while a
  provider believes otherwise, and the loop will keep spending budget until a
  ceiling stops it. Budgets are therefore mandatory for unattended loops, not
  optional as they are for hand-driven ones.
- Clamping to the intersection means a person who lowers a thread's access mid
  loop lowers the loop too, with no separate gesture.
- The loop, the ceiling, budget-gated rounds, evidence-gated completion, and the
  journaled record of every stop are implemented for Work threads. Two parts are
  not, and both fail closed rather than pretending: a **schedule as a trigger**
  is refused at the start command until the scheduler can hand a due occurrence
  to a round, and a **ceiling narrower than the mode itself** is refused at the
  same place, because a Work turn's posture is a property of Work and there is
  no per-turn grant to hand it. A ceiling the host cannot impose is worse than
  no ceiling: the person believes the loop is narrower than it is.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode
- 0012 Mixed-provider subagents and agent runs
- 0020 Checkpoints and restore by forking
