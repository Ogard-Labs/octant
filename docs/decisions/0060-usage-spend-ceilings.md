# 0060. Usage spend ceilings

**Status:** Proposed

## Context

The host already records provider usage in a journal-backed ledger and exposes
it through the Usage destination, Environment thread usage, and the composer
context meter (0008). Those reads attribute tokens by provider, model,
Project, thread, mode, and request shape. Monetary cost stays unavailable
unless reviewed pricing metadata or explicit user rates exist; unknown usage
or price is never shown as zero.

Threads also carry `ThreadGoalBudget` and `ThreadGoalUsage`: optional token,
time, and turn ceilings that stop a goal loop at `budget-limited` (0025). That
shape is the right stopping vocabulary, but it only covers one goal on one
thread. A Project with many threads, or a thread without a goal, can still
spend without a host-owned cap.

People need Project- and thread-level spend ceilings so concurrent or
unattended work cannot burn provider quota unnoticed. Vendor billing portals
and account APIs differ by provider and are not a local-first core dependency.
This record is design only: no enforcement lands until it is Accepted and an
implementation change is authorized.

## Decision

- A **spend ceiling** is an optional host policy on a Project, a thread, or
  both. When both exist, a turn must satisfy the intersection: Project spend
  and thread spend each stay under their own ceiling.
- Ceiling fields reuse the goal-budget shape: optional positive
  `tokenBudget`, `timeBudgetMs`, and `turnBudget`. An optional monetary field
  is allowed only when the host can price the scoped usage from reviewed or
  user-supplied pricing metadata, or from provider-reported `costUsd` on the
  same turn facts. Absent pricing, monetary ceilings cannot be set; token,
  time, and turn ceilings still can.
- Spend against a ceiling is the sum of existing `UsageRecord` rows for that
  Project or thread subject, filtered by the ceiling's window. The host does
  not invent a second ledger or call vendor billing APIs as a core path.
  Optional provider cost facts may feed monetary totals the same way they
  already feed turn UI; they never become required for token ceilings.
- The window is explicit on the ceiling: lifetime for a thread by default, and
  a calendar period (day, week, or month in the host viewing time zone) for a
  Project. Clearing or raising a ceiling is a journaled owner command; spend
  already recorded does not vanish.
- Goal budgets and spend ceilings are separate stops. A goal that hits
  `budget-limited` pauses that goal. A spend ceiling that is exhausted refuses
  further provider-consuming turns under that scope, including goal-loop
  iterations, until a person clears or raises it.
- Enforcement, when implemented, runs on the server before side effects: turn
  admission and the capacity scheduler refuse a turn that would start over a
  hard ceiling. Soft warning thresholds may surface earlier in Usage and
  Environment; they never substitute for the hard refuse.
- **Hard ceilings use atomic reservation, not a post-hoc sum alone.** Counting
  only committed `UsageRecord` rows races concurrent admitted turns and under-
  counts in-flight spend. Admission must reserve remaining capacity for the
  scoped turn (commit on completion, release on cancel or failure, with a
  defined retry path). Every hard-ceiling turn needs a **pre-admission upper
  bound** before the provider call: a declared estimate from the scheduler, or
  a configured per-turn maximum for that dimension. Turns with no bound are
  refused rather than admitted on hope. If observed spend still exceeds the
  reservation, the host records the overrun, refuses further admission under
  that scope, and surfaces recovery — it does not silently widen the ceiling.
- **Unknown spend fails closed for the dimensions that are set.** If a token
  ceiling is set and recent rows are `unavailable` or would leave the total
  unknowable, the host refuses rather than treating missing tokens as zero.
  The same rule applies to monetary ceilings when cost quality is missing.
- **Refusal UX.** The product names the scope (Project or thread), the
  exhausted dimension, remaining or overrun figures when known, and a recovery
  a person can perform: raise or clear the ceiling, open Usage already
  filtered to that scope, or pause work. The refusal is visible on the
  composer and in Environment before it is terminal, following 0032's rule
  that a fail-closed refuse must name a recovery. Widening is explicit and
  journaled; nothing auto-clears a ceiling because a loop or child is running.
- Child agent runs inherit the parent's thread and Project ceilings; they do
  not get a separate raise path. Subagent token and cost hard limits (0012)
  remain additional clamps when accounting is reliable.

## Consequences

- Implementation can extend contracts and domain policy beside
  `ThreadGoalBudget` without a parallel budget vocabulary, and can aggregate
  from the usage projection the Usage dashboard already reads.
- Projects without ceilings stay unbounded on spend; setting a ceiling is
  opt-in. First enforcement should cover token ceilings first, then monetary
  once pricing metadata is actually configured on a host.
- Until Accepted, the roadmap keeps spend ceilings outside the shipping
  boundary. This note is the start gate for later enforcement work.

## Related

- 0008 Context budget, provider limits, and capacity scheduling
- 0012 Mixed-provider subagents and agent runs
- 0025 Long-running goal loops
- 0032 A refusal a person can clear
