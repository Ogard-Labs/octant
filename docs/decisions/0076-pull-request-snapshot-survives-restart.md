# 0076. The pull-request snapshot survives host restart

**Status:** Accepted

## Context

0064 kept pull-request rows in memory so observation polls could never bloat the
event journal. That protected the journal, but it also discarded a successful
manual refresh whenever the host restarted. The Pull requests workspace then
looked empty until another GitHub request completed.

## Decision

- The bounded Project pull-request list snapshot is stored in a private,
  host-local cache file after every successful manual or automatic observation.
- The cache contains bounded rows, global and per-Project freshness, truncation
  flags, and the last successful refresh time. It does not contain pull-request
  detail bodies, diffs, comments, credentials, or tokens.
- Startup decodes the file through the same row and freshness contracts used at
  the server boundary. Malformed, oversized, or unknown-version content is
  ignored.
- GitHub revocation clears both the memory snapshot and the private file. Reads
  still filter restored rows through current Project and repository authority.
- The cache never enters the event journal. The only journaled refresh fact is
  the person's per-Project auto-refresh choice from 0064.
- The UI names that choice **Auto-refresh** and keeps it default-off per Code
  Project. Manual refresh remains available independently.

This is a scoped exception to 0064's process-local snapshot rule. Its cadence,
bounds, failure pacing, opt-in default, and no-poll-journaling rules remain.

## Consequences

- A manual refresh remains visible after an app or host restart without an
  immediate GitHub call.
- Restored facts show their recorded freshness and timestamp.
- The private cache can always be dropped and reconstructed from GitHub, so it
  is not part of journal replay or verified user-data backup semantics.

## Related

- 0002 Durable event journal and rebuildable projections
- 0039 Journal compaction of superseded observations
- 0064 Opt-in background refresh of the pull-request snapshot
