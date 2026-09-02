# 0075. Thread reads are snapshot-first and change-driven

**Status:** Accepted

## Context

Opening a small Code thread could issue dozens of requests before displaying
its text. Conversation evidence was read one reference at a time, Work polled
its full transcript, each navigation controller kept its own timer, and hidden
thread tools could start filesystem or Git work before the transcript painted.
Those reads multiplied across Electron and browser clients even though 0074
makes them clients of the same Machine.

A live feed cannot replace the journal. It is process-local, may overflow, and
resets when the canonical host restarts. Fast reads therefore need an explicit
snapshot and cursor contract rather than treating a stream as durable state.

## Decision

- A thread opens from one authoritative snapshot. Independent snapshot reads
  start concurrently, and longer histories paint page by page.
- Referenced display evidence crosses the authorized read boundary in bounded
  batches. Code operation replay may carry display-ready text beside its
  durable evidence reference; the journal remains reference-only.
- Work response text uses a bounded per-thread delta feed. The durable Work
  transcript remains the recovery snapshot.
- One bounded Machine change feed invalidates Chat, Work, Code, Project, and
  extension projections after journal commit. It replaces feature navigation
  timers; high-frequency Code text events do not invalidate navigation.
- Every feed has a monotonically ordered process cursor, bounded replay,
  subscriber and queue limits, caller cancellation, and a `snapshot-required`
  outcome for overflow, stale cursors, or host-generation changes. A snapshot
  marker may reset a client cursor after restart.
- The shared client transport bounds concurrent reads, prioritizes foreground
  thread data, coalesces identical in-flight reads, and cancels obsolete caller
  work. It may renew local client context after an unauthorized response, but
  it never automatically replays a mutation. Electron publishes a newly
  registered window capability when its host instance changes so surviving
  renderers rebuild these clients before their snapshot retry.
- A browser tab carries a tab-stable client-context marker. A new tab that
  inherits a copy of `sessionStorage` mints its own presentation context rather
  than reusing the opener's window identity; both still read the same Machine.
- Files, Git, Browser, Computer Use, and other auxiliary observations wait for
  the primary transcript or an explicit opening. Recent Git observations are
  coalesced briefly, explicit refresh bypasses that cache, and independent Git
  facts are observed concurrently.
- Safety-critical child-run stop and acknowledgement controls may retain state
  already read for an open thread while its transcript reconnects. They do not
  start a new child-run read before the transcript is display-ready.
- Long Work and Code transcripts are windowed. Idle activity polling backs off
  and hidden documents do not poll.
- The host records separate latency classes for navigation, thread snapshots,
  conversation evidence, and environment observation, and returns
  `Server-Timing` on measured API responses without including identifiers.

## Consequences

- Electron, loopback browsers, Vite, and paired clients converge through the
  same snapshots and committed invalidations while keeping independent view
  state.
- Normal thread work no longer scales HTTP request count with every evidence
  reference or remounts the entire transcript.
- Streams are acceleration only. A dropped, overflowed, or restarted stream
  always returns to server-authoritative state before applying more deltas.
- A short cache may make passive environment observations identical across
  clients; the person's Refresh action always requests a new observation.
- Display-ready Code stream frames are larger than reference-only frames but
  remain bounded and avoid a request per text delta.

## Related

- 0002 — durable event journal and rebuildable projections
- 0013 — authenticated remote clients and reconnect
- 0035 — thread retention and explicit purge
- 0074 — one Machine, canonical host, and shared store
