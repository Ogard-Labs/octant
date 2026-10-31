# 0039. Journal compaction of superseded checkout observations

**Status:** Accepted

## Context

A reconnect loop journaled a `code.checkout-observed@1` event for every poll of
an unchanged worktree: one dogfooding host holds roughly 22,000 events of which
about 21,000 are consecutive, payload-identical observations of a single
`code-checkout` aggregate, and the bloat has already broken replay once. The
write side now refuses to journal an observation that repeats the journaled
state, but 0002 exposes no delete, so existing journals keep the dead weight.

Checkout observations are system-recorded infrastructure facts, not user
content. Every consumer of them was inventoried before this record: the code
projection upserts by checkout id and keeps only the newest version;
aggregate heads keep only the newest sequence; every other journal reader
filters by event name or aggregate and never sees them; thread export and
diagnostics export do not read them; concurrency checks read heads, not row
counts. No read surface distinguishes a superseded observation from its
successor. The store verifier does, however, require each aggregate's versions
to be contiguous from 1, so deleting rows mid-stream without renumbering would
make a healthy store report invalid.

## Decision

- Compaction removes a `code.checkout-observed@1` event only when the next
  event of the same `code-checkout` aggregate is also `code.checkout-observed@1`
  and identical in payload except `checkout.observedAt`, with the same host and
  actor. Within a run of identical observations only the last survives — the
  exact state the projection already serves, carrying the newest `observedAt`.
- Availability transitions, `code.checkout-removed@1`, every other aggregate,
  and the retained events' ids, payloads, timestamps, and global sequences are
  preserved. A superseded row always precedes a retained row of the same
  aggregate, so the journal head and projection checkpoints stay valid; global
  sequence gaps are the same residue thread purge (0035) already leaves.
- Mechanism: one transaction per store deletes the superseded rows, renumbers
  each compacted aggregate's surviving `aggregate_version` contiguously from 1,
  and updates `aggregate_heads` and `code_checkout_projection` to the renumbered
  head. Renumbering is not optional: the verifier's contiguity invariant is kept
  deliberately, so a version gap must never survive compaction. Foreign keys
  stay enforced; an unexpected reference aborts the transaction.
- Compaction runs at every startup after migrations and projection catch-up and
  before restart reconciliation and the readiness gate. It is idempotent — a
  compacted journal has no identical adjacent observations left — and measured:
  it reports how many events it removed and for how many checkouts.
- Fail closed. An aggregate is skipped whole when it has quarantined events,
  when its versions are not already contiguous, or when its stored head or
  projection row disagrees with its journal tail. A row is kept when any event
  names it as `causationId`, when its payload does not decode to the expected
  shape, or when any part of the identity test fails. Doubt always retains.
- This is not a 0035 erasure and needs no confirmation. Purge removes facts a
  user can see — transcripts, titles, derived reads — so it demands an explicit
  confirmed request. Compaction cannot change any answer the product can give:
  every projection, rebuild, subscription, and export is identical before and
  after. What is lost is visible only to a raw database read: how many times an
  unchanged state was re-observed, the per-repeat envelope ids and timestamps,
  and the original numbering of the surviving checkout stream.

## Consequences

- 0002's "no update or delete" now has exactly two exceptions, both in the
  persistence data-lifecycle layer and never in command handlers: user-confirmed
  purge (0035) and this behavior-preserving compaction. Compaction is
  self-applying because it preserves behavior; anything that removes an
  observable fact stays behind an explicit confirmed request.
- Extending compaction to any other event name requires a new record proving
  the same properties: a single last-writer-wins consumer, no reader that
  distinguishes the superseded event, and a renumbering the verifier accepts.
- The adjacent-identical rule intentionally leaves availability flaps
  uncompacted; correctness is bought with a weaker compression ratio.
- Deleted rows free SQLite pages only after a vacuum or store rebuild, the same
  reported residual 0035 accepts.

## Related

- 0002 Durable event journal and rebuildable projections
- 0035 Thread retention and explicit purge
