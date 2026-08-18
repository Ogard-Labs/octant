# 0020. Checkpoints and restore by forking

**Status:** Accepted

## Context

Octant's journal is append-only (0002): a Chat edit appends a superseding turn
rather than rewriting one, and Code records a checkout snapshot before every
turn. Users still asked for the ordinary thing an assistant transcript makes
them want — "go back to where this was working and try again" — and the pieces
that could answer it were scattered and unnamed. Chat had "Branch from here" on
every turn with no way to say which turn mattered. Code had a per-turn checkout
snapshot reachable only as an in-place file restore, which overwrites the
working tree and is the one gesture that cannot be taken back cheaply. Nothing
in either mode named a point the user chose, and nothing carried that idea
across modes.

The naive fix — a rewind that truncates a thread at a turn — is the one option
the journal forbids and the one users would regret: it discards the work done
after the point being returned to, exactly when the value of comparing the two
directions is highest.

## Decision

- A **checkpoint** is a user-marked point in a thread, journaled as its own
  `thread-checkpoint` aggregate. It records where a turn already is; it never
  copies, freezes, or snapshots thread state. Marking, forgetting, and
  restoring are three journaled events on that aggregate.
- A checkpoint anchors to one turn of one thread: a Chat turn, or a Code
  operation. The caller supplies identity only; every fact a restore depends on
  is read from the server's own copy of the thread when the checkpoint is
  marked.
- A Code checkpoint always carries the revision the checkout was on before the
  marked turn ran, taken from the snapshot Code already records. A turn whose
  revision the host never caught cannot be checkpointed, rather than being
  marked as a point that would refuse to restore.
- **Restoring a checkpoint forks; it never rewinds.** Chat restores by
  branching the conversation through the marked turn into a second thread. Code
  restores by creating a thread on its own Octant-managed worktree at the
  recorded revision. The thread the checkpoint was marked in is untouched: no
  turn is rewritten, no journal event is retracted, and no checkout is moved.
- The restored thread carries provenance back to its origin — Chat's
  `branchedFrom`, Code's `forkedFrom` plus managed-worktree source provenance —
  so a reader can always tell which point it came from.
- A restored Code thread starts approval-gated whatever the source thread holds,
  because a new thread carries no approval receipt of its own (0003, 0009), and
  takes a fresh delivery branch so returning to a point never competes for the
  branch the original work is still delivering on.
- Restoring never widens authority. The checkpoint service resolves facts and
  decides shape; Chat and Code run their own Project, thread, lifecycle,
  approval, and worktree checks before creating anything, and their refusals are
  reported to the user as the reason rather than swallowed.
- A checkpoint is refused rather than silently degraded: an unavailable thread,
  a turn a later revision dropped, an unrecorded revision, an unavailable
  Project, a forgotten marker, and a mode the host cannot restore into each have
  their own stated reason.
- Forgetting a checkpoint retires the marker and nothing else. The record stays
  readable as `forgotten` so a client holding one learns it was put away instead
  of watching it disappear.
- Checkpoints are host-local for now. The surface is not admitted to the
  authenticated remote product catalog, so a paired device fails closed on it
  until remote surface classification covers it (0013).
- "Restore" in the checkpoint sense always produces a thread. Code's existing
  in-place `restore-git-checkpoint` operation — which overwrites the working
  tree and is approval-gated as destructive — keeps its own name and copy, and
  the two are never presented as the same gesture.

## Consequences

- Going back costs a thread rather than history: both directions stay open and
  comparable, which is what parallel attempts on one task need anyway.
- Code restores are exact but committed-only. The recorded revision names a
  commit; uncommitted work at the marked moment stays with the source checkout
  and is not carried into the restored worktree.
- Managed-worktree creation gains an explicit revision source, which resolves an
  object already in the repository and never fetches. Starting from a revision
  and starting from a remote tip are mutually exclusive by contract.
- Every restore adds a worktree and a thread, so a user who restores repeatedly
  accumulates both; managed worktrees remain subject to their ordinary grant,
  receipt, and cleanup rules (0003).
- Marking is cheap and unbounded per thread today. If a thread ever carries
  enough markers to matter, bounding them is a change to this record.

## Related

- 0002 Durable event journal and rebuildable projections
- 0003 Product modes: Chat, Work, and Code authority
- 0009 Sandbox confinement, approvals, and Plan mode
- 0013 Remote access: single host, paired devices, and mobile
