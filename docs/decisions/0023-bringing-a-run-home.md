# 0023. Bringing a run home

**Status:** Accepted

## Context

Octant can run the same task several ways at once: a linked-thread aggregate
records N attempts, each on its own managed worktree, each free to work without
disturbing the others or the person's checkout. Starting that was solved.
Finishing it was not. There was no way to see what an attempt actually produced
against the branch it targets, no way to compare attempts, and no way to take
one — the only routes home were a pull request or hand-typed Git in a terminal,
which is exactly the moment isolated work stops being cheap.

The dangerous shortcut is an automatic merge. A flow that lands work in the
person's own checkout without being asked, or that merges over uncommitted
changes, turns "try three approaches" into "lose an afternoon".

## Decision

- Reviewing a run is a **read**: `review-run` measures the run's branch against
  its confirmed delivery base — remote-tracking ref first, local branch second,
  because that is what a pull request would be opened against. It reports the
  commits ahead and behind, the changed paths, the branch diff, and the work the
  run never committed.
- Mergeability is **asked of Git, not guessed**. `merge-tree --write-tree`
  computes the merge without a working tree and without touching either branch.
  A Git that cannot answer reports `unknown`, and `unknown` is refused — an
  optimistic guess here is a merge conflict in someone's own checkout.
- The diff is the one Code already renders. Scoping it to the branch is a
  parameter, not a second diff engine.
- **Merging is explicit, approval-gated, and journaled.** `merge-run` carries a
  confirmation naming the branch, the base branch, and the head it was reviewed
  at; the host re-reads the run and refuses if any of them no longer match.
  Nothing merges as a side effect of anything else, and there is no auto-merge.
- A merge is refused, before anything moves, when: the Project's checkout cannot
  be read, is on another branch, or is dirty; the run has uncommitted work a
  merge would leave behind; the run has nothing to bring; Git reports conflicts;
  or the run moved since it was reviewed. Each refusal names the state the user
  can fix.
- The merge lands in the **Project's own checkout**, with `--no-ff`, so the
  history says a run was brought home rather than pretending the work happened
  there. A merge that cannot complete is aborted, leaving the checkout as it was
  found.
- The comparison across attempts **states facts and stops**: commits, changed
  files, and which files more than one attempt touched. It ranks nothing. Which
  attempt is better is a judgement about the work, and ranking by diff size
  would dress the smallest change up as the best answer.
- Discarding an attempt is the existing managed-worktree cleanup path, unchanged
  and still under its own authority. Bringing one home does not retire the
  others.

## Consequences

- Parallel work has an ending: three attempts can be compared on their real
  output and one can be taken in a gesture, without a pull request round trip.
- The strict pre-conditions mean the flow refuses often — a dirty checkout is
  common — and every refusal is a sentence the user can act on rather than a
  failed merge to clean up.
- A run whose base has moved will report `behind` and may report conflicts. The
  fix is in the run (merge or rebase the base into it there, where it is
  isolated), which is where a conflict costs nothing.
- `merge-tree --write-tree` needs a reasonably recent Git. An older one reports
  `unknown` and the merge is refused rather than attempted blind.
- A remote client may ask for a merge, but the decision stays clamped to the
  host's thread authority: the checkout being changed is the person's own.

## Related

- 0003 Product modes: Chat, Work, and Code authority
- 0009 Sandbox confinement, approvals, and Plan mode
- 0020 Checkpoints and restore by forking
