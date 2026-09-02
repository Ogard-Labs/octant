---
description: Journal-based recovery, replay, rebuilds, conflict recovery, and diagnostic tooling.
---

# Recovery and Troubleshooting

Octant's recovery model is built on the durable event journal: every
meaningful action is journaled as a versioned event, and every projection can
be rebuilt from that journal. This makes crashes and interruptions recoverable
instead of destructive.

## The event journal

The journal is append-only and stores versioned envelopes carrying event,
aggregate, sequence, correlation, causation, actor, and timestamp identity.
Optimistic concurrency uses expected aggregate versions. A termination before
commit writes nothing; after commit, the full batch is preserved even if the
caller never received a response. Repeating an operation with the same event
IDs cannot duplicate work.

Malformed or unsupported events are **quarantined** with typed reasons and
stop the affected projection without rewriting history. Ambiguous recovery
state is always **Waiting** or **recovery-required**, never **Done** or
healthy.

## Recovery tooling

Operator commands cover the journal and projections:

- `db:status` — inspect database and projection state
- `db:verify` — verify the journal and projections
- `db:rebuild` — rebuild projections from the journal
- `db:rebuild --projection <name>` — rebuild a single projection

Rebuilds never edit or delete journal events. Quarantine retirement happens
only after a successful explicit rebuild. A confirmed thread purge is the
separate data-lifecycle exception: it removes that thread's own journal
events so a later rebuild cannot resurrect the transcript, and it records a
tombstone rather than leaving a hole with no explanation.

## User-level recovery

- **Local clients**: reopening Electron or the canonical browser URL after
  sleep or a host restart renews process-local client context automatically.
  It does not create another store or require a recovery workflow.
- **Threads**: reconnect resumes from bounded live cursors. If a cursor belongs
  to an older host process or fell outside replay, the client reloads the
  authoritative transcript before applying more updates.
- **Settings**: a failed settings command restores the last authoritative
  value and announces the failure.
- **Zen**: when state cannot be decoded, **Recover Zen** restores the main
  workspace instead of trapping you; Zen rebuilds from the journal after
  restart or reconnect, and concurrent mutations surface a version conflict
  with a refresh.
- **Editor**: a stale save blocks with a conflict result that preserves the
  authoritative file and your draft. See
  [Editor and terminals](/advanced/editor-and-terminals).
- **Worktrees**: ambiguous repository identity or inventory becomes
  `waiting` or `unavailable` and is never pruned automatically. See
  [Git and worktrees](/advanced/git-worktrees).
- **Extensions**: the extension supervisor quarantines crash-looping
  components and reconciles after restart; interrupted installs recover to
  an honest state, never a visible partial package. See
  [Plugins and skills](/advanced/plugins-and-skills).
- **Previews**: a missing, changed, revoked, or offline source restores as an
  honest unavailable or stale placeholder, never a silently substituted file.

## Previews and evidence honesty

Octant never infers a green from partial output. Preview and validation
surfaces show distinct states for denied, missing, stale, superseded,
interrupted, failed, and inconclusive results, and keep superseded runs from
being resurrected by delayed completion.

## Next steps

- [Privacy and security](/advanced/privacy-and-security) for where data lives
- [Remote access](/advanced/remote-access) for reconnect and replay behavior
- [Release compatibility](/advanced/release-compatibility) for migration boundaries
