# 0035. Thread retention and explicit purge

**Status:** Accepted

## Context

0002 makes the journal append-only: application code exposes no update or
delete. Chat can already hide a thread and drop its out-of-journal content
store, but journal events, titles, and other derived projections remain, a
rebuild can resurrect them, and there is no retention window or confirmed
per-scope report. Erasure of a thread — including derived reads — needs a
named data-lifecycle operation, not a silent row delete.

## Decision

- Retention windows are per-scope: host default, Project override, thread
  override. The narrower scope wins. Setting a window never deletes anything.
- A window is `forever` or a positive day count. The host default is `forever`.
- Retention is applied only by an explicit, user-confirmed purge (`confirm:
true` on the wire). A named thread may be purged even while it is still
  inside its window. Project and host scopes purge only threads that have aged
  past their effective window.
- Purge is a data-lifecycle operation in the same class as reset, remove-all,
  and delete-remote-host. Ordinary command handlers still do not update or
  delete journal rows.
- A confirmed purge, for each named thread: deletes purgeable bulk content
  (content stores, attachments, context summaries, agent-run subject text);
  removes derived projection rows so ordinary reads cannot serve the thread;
  physically deletes that thread's own journal events and thread-owned related
  aggregates so a rebuild cannot resurrect transcript or title; then appends a
  tombstone on the `thread-retention` aggregate for audit and idempotence.
- Every outcome is reported per scope (deleted vs retained). Scopes the
  request did not name stay retained. Fail closed: a remote principal cannot
  set a window or purge; missing confirmation refuses; an unknown thread
  refuses.
- No telemetry and no cloud. There is no unattended timer.

## Consequences

- Physical deletion of a thread's journal events is the same exception
  delete-remote-host already takes, scoped to one thread rather than a host.
- SQLite free pages may keep bytes until a vacuum or store rebuild; that
  residual is reported, not hidden.
- Usage attribution, canvas documents, memory, credentials, Projects, and
  other threads stay unless a later request names them.

## Related

- 0002 Durable event journal and rebuildable projections
- 0013 Remote access
