# 0123. Explicit GitHub pull-request merges are fresh and approval-gated

**Status:** Accepted

## Context

The Code pull-request reader already exposes GitHub state and mergeability, but
reviewers still have to leave Octant to merge. A merge is an external mutation:
the pull request may have changed since the last observation, the selected
repository must belong to the authorized Project, and a remote client or agent
must not turn a read surface into an unattended write.

## Decision

- The review pane may offer Merge only for an open pull request whose detail is
  fresh, complete, and observed as mergeable. The control remains disabled for
  stale, ambiguous, conflicting, draft, closed, or unavailable detail.
- The user chooses merge commit, squash, or rebase and must confirm in an
  inline warning surface. There is no auto-merge option, branch deletion, or
  implicit merge as a side effect of refresh, chat, or review navigation.
- The server authenticates the local window, resolves the Project's connected
  GitHub repository, and rejects renderer-supplied identity, credentials, roots,
  or agent/remote initiators before invoking GitHub. The Project and repository
  in the command must match the server-authorized connection.
- The GitHub port re-reads the pull request immediately before the mutation and
  passes its current head SHA to `gh pr merge --match-head-commit`. A changed
  head, non-mergeable state, closed pull request, authentication failure, or
  disconnected host is returned as a typed refusal/unavailable outcome rather
  than guessed or retried blindly.
- The merge method and result are typed contracts. A successful merge clears
  the process-local detail cache and lets the next explicit detail refresh
  observe GitHub's terminal state. The external GitHub mutation is not written
  to the Octant journal; only durable local facts belong there.

## Consequences

- A reviewer can complete a normal merge without leaving the review pane while
  still seeing an honest confirmation and conflict boundary.
- A successful command can still be followed by a lost response; the next
  refresh is the source of truth and the typed result does not claim more than
  `gh` reported.
- Remote clients retain read-only review access. Merge remains a local-user
  action and requires a fresh observation, so stale snapshots cannot authorize
  a different revision.

## Related

- 0001 Plugin architecture and typed GitHub integration boundary
- 0023 Bringing a run home (explicit, approval-gated merge semantics)
- 0064 Opt-in background refresh of the pull-request snapshot
- 0076 The pull-request snapshot survives host restart
