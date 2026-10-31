# 0064. Opt-in background refresh of the pull-request snapshot

**Status:** Accepted

## Context

Work and Code board cards carry pull-request facts — state, checks, review,
mergeability — joined from the Project pull-request snapshot. That snapshot is
an in-memory, non-journaled cache that only an explicit Refresh reconstructs,
so after a host restart every card reads stale until someone opens the
workspace and clicks. The staleness is honest but unhelpful on a host that is
running all day precisely to watch delivery move.

The failure mode to avoid is equally concrete: a reconnect loop once journaled
an observation per poll of an unchanged worktree and bloated one journal by
roughly 21,000 redundant events before 0039 cleaned it up. Any background
observation of GitHub must be structurally unable to reintroduce that class of
bug, and must not turn one workstation into a polling storm against the rate
limit the snapshot itself depends on.

## Decision

- **Opt-in, per Project, default off.** Background refresh is a journaled Code
  Project setting (`project.code-pull-request-background-refresh-changed@1`,
  one event per user toggle) so the opt-in survives restart — the restart being
  the motivating staleness. Absence of the setting means disabled, so every
  existing Project keeps the explicit-refresh-only behavior bit for bit. The
  toggle is an authoritative server command on the Project aggregate; the
  renderer only issues it.
- **The cadence observes only what the board shows.** A Project is observed
  only while it is enabled, active, connected to a github.com repository, and
  has at least one board-relevant linked-thread fact. The observation is the
  same per-Project refresh an explicit click performs — one code path, no
  second refresh semantics — except that cached merged and closed identities
  are not re-observed: merged is terminal, and a reopened pull request
  re-enters the active list.
- **Cadence bounds.** Observations are floored at 30 seconds per Project and
  default to 120 seconds. Each Project keeps a sync position — the time of its
  last successful observation — and a failed observation never advances it.
  Failures back off exponentially from 30 seconds to a 15-minute ceiling
  (reusing the cache backoff policy); a rate limit's own retry-after extends
  the wait when it is later. All pacing decisions are pure domain policy.
- **Fail closed on `gh`.** A missing or invalid `gh` executable means the
  cadence never starts an observation; an unauthenticated `gh` stops it
  entirely. Both are values (`unavailable` states), not retry loops, and only
  an explicit signal — the user re-enabling the Project, or a successful
  explicit refresh — restarts a stopped cadence.
- **The journal never sees a poll.** The snapshot stays an in-memory bounded
  cache; per-observation facts, cadence pacing state, and per-Project cadence
  status are process-local values. The cadence's dependency surface exposes no
  journal or persistence handle, so journal contents are identical whether the
  cadence ran once or a hundred times with no upstream change. The only
  journaled fact this record adds is the user's toggle. Anything that seems to
  need journaling per observation is a design error under 0039, not a gap to
  fill.
- **Honest freshness on cards.** Board queries still never call GitHub; they
  read the snapshot. Card pull-request summaries now distinguish `fresh`,
  `stale` (reachable but older than the last successful refresh), and
  `unavailable` (the snapshot cannot reach GitHub at all — `gh` missing,
  unauthenticated, or offline). Merge readiness continues to require `fresh`.

## Consequences

- A restarted host with an opted-in Project repopulates board facts within one
  cadence interval instead of waiting for a human click; hosts that never opt
  in are unaffected.
- The cadence spends the same bounded read budget as an explicit per-Project
  refresh, so worst-case GitHub load is one explicit refresh every interval per
  opted-in Project, less the skipped merged/closed identity reads.
- The `unavailable` freshness literal is additive for the desktop renderer but
  is a wire-contract widening: remote clients decoding board summaries must
  ship with contracts that know the third state.
- The per-Project cadence status shown in the Pull requests workspace is
  process-local and resets on restart; only the opt-in itself is durable.

## Related

- 0002 Durable event journal and rebuildable projections
- 0039 Journal compaction of superseded checkout observations
- 0051 Board cards summarize plan progress
