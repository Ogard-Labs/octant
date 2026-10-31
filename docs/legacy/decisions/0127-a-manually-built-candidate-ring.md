# 0127. A manually built candidate ring

**Status:** Accepted

## Context

0034 established two rings: `stable` for tagged releases and `preview` for the
scheduled build of `main`. Testing a branch before it merges still means
checking it out and packaging locally, which cannot produce the linux-x64
artifact at all — cross-host packaging is refused. The workflow's manual
dispatch could not help either: it published to the live preview feed, so a
throwaway branch build would have been offered to every install following the
nightly ring.

## Decision

- Add a third ring, `candidate`. A `workflow_dispatch` run of the preview
  workflow builds whichever ref it was started on, signs and notarizes exactly
  as a nightly does, publishes the prerelease archive, and publishes the feed
  under `<base>/candidate/<platform>-<arch>.json`. Clicking the button is the
  intent, so a dispatch always builds.
- A candidate carries a `-candidate.…` prerelease tag, so the build's ring is
  still read from its own version and the ordering rules of 0034 are unchanged:
  a candidate sorts below the release it leads to, and no ring offers a version
  that is not strictly newer.
- The nightly's "did `main` move" comparison counts only `-preview.…` tags. A
  candidate tag names a ref `main` may never contain, so treating it as the
  ring's baseline would answer the wrong question.
- This partially supersedes 0034's "Two rings, one key, and the ring inside the
  signature" enumeration of exactly two rings. Everything else in that bullet
  stands unchanged — one key signs every ring, the ring stays inside the
  signature and is checked against the ring the app asked for, and each ring is
  its own feed address. Every other rule in 0034 stands.

## Consequences

- A person can point an install at the candidate ring and update-test a branch
  build through the real feed path, including the signature, hash, and
  wrong-ring refusals.
- A manual run publishes a signed feed like the rings do; the candidate feed
  simply has no schedule and no followers unless someone opts in.
- The candidate feed is last-writer-wins: two dispatches race the way the
  matrix already tolerates, and the newest `candidate.<date>.<run>` wins by
  version ordering.

## Related

- [0034](0034-signed-updates.md) — signed updates, feed trust, ring separation
  (partially superseded as scoped above).
- [0058](0058-cross-platform-desktop.md) — the release matrix the candidate
  build runs on.
