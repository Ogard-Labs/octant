# 0002. Durable event journal and rebuildable projections

**Status:** Accepted

## Context

Every stateful Octant feature (Projects, threads, provider instances, workspace
layouts, extensions, agent runs, canvases, remote devices) needs restart-safe
persistence, reconnect replay, and honest recovery after crashes or partial
streams. A mutable row-per-entity store cannot explain how state was reached,
cannot replay to a reconnecting client, and turns every bug into silent data
loss. Octant is local-first: the store lives on the user's host, is never
synchronized through a cloud service, and must never contain provider secrets.

## Decision

- The authoritative store is one immutable, append-only SQLite event journal
  owned by the server. Application code exposes no update or delete for it.
- Every committed event carries a stable envelope: event id, aggregate type and
  id, aggregate version, event name and payload schema version, global
  sequence, correlation and causation ids, structured actor, UTC timestamp, and
  a schema-validated payload. Global order comes only from the sequence.
- Commands target exactly one aggregate and supply the expected aggregate
  version. A stale version returns a typed concurrency conflict and writes
  nothing. Cross-aggregate coordination is modelled explicitly in domain
  commands, never through a hidden database transaction.
- The append flow is fixed: decode and validate the request and actor, resolve
  mode and effective authority, check the expected version, insert the event
  batch, apply every registered projection idempotently in sequence order,
  advance checkpoints, commit, publish the committed range, then trigger
  provider and tool reactors. Nothing is visible before commit.
- Projections are read models rebuildable from the journal. They are keyed by
  global sequence, idempotent under duplicate replay, and checkpointed in the
  same transaction as their state. A checkpoint may trail the head but never
  lead it. Aggregate heads are themselves a rebuildable projection.
- Replay reads strictly after a supplied sequence in bounded batches; every row
  is decoded through its registered schema before projection code sees it.
- Migrations are ordered, forward-only, checksum-verified, and applied inside
  transactions before the server reports ready. A changed checksum or an
  unknown newer migration fails closed; there is no down-migration.
- Malformed, contract-invalid, unsupported-version, or unapplicable events are
  quarantined: the projection keeps its last valid state, readiness becomes
  recovery-required, and the operator receives a typed reason without payload
  disclosure. Octant never skips an undecodable event and reports current.
- A successful explicit projection rebuild is the only operation that retires
  quarantine observations, atomically with the replay it proves. Normal
  startup never clears quarantine.
- Ambiguous recovery state resolves to Waiting or recovery-required, never to
  Done or healthy.
- Durability settings are conservative by default (WAL, synchronous full, one
  server-owned writer). The store lives under an Octant-owned data directory
  with owner-only permissions; tests use isolated temporary directories.
- The database is reached through one narrow server-owned port with thin
  runtime adapters (Bun and Node) that share a conformance suite. Journal,
  migration, and projection code depend only on the port.
- Provider credentials, OAuth tokens, prompts, and raw provider payloads never
  enter journal payloads. Purgeable bulk content (terminal transcripts, test
  output) lives outside the journal and is referenced from it.

## Consequences

- Every feature pays the same tax up front: contracts for its events, a
  projection, and rebuild tests. In return restart, reconnect, and crash
  recovery are uniform rather than re-solved per feature.
- Operators get `status`, `verify`, and `rebuild` tooling instead of manual
  database surgery; a failed rebuild cannot make a store look healthy.
- Schema evolution is additive by design; destructive migrations require their
  own compatibility and backup review.
- The single-writer choice trades write throughput for simplicity; separate
  read connections are added only when measured contention justifies it.
- Downgrading a binary against a newer store refuses to open it rather than
  guessing.

## Related

- 0004 Monorepo layering and dependency direction
- 0013 Remote access (reconnect replay is sequence-based)
