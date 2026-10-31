# 0160. An Apple screen capture lands in a directory only its launch can write

**Status:** Accepted

## Context

`simctl io … screenshot` writes raw device pixels to a file before the host
reads it into an artifact. The file lived in the process-wide temporary root —
a root every confined launch reads and writes — so for the capture's lifetime
any other thread's confined command could read the screen of a Simulator it
was never granted.

Pointing the Apple port's whole temporary directory at a private folder was
measured and reverted before merge: `xcrun` and the Simulator services need
the host's real temporary and cache roots, and moving them broke every
confined Apple command ("Apple toolchain unavailable" on a host with Xcode).

## Decision

Captures move to a host-private directory under the host's own data root
(`<data>/apple-runtime/captures`, created `0700` on first use). It is the one
added write root: the screenshot launch carries it as a per-launch
`additionalWriteRoots` entry — the first caller of that grant, which the
confinement `prepare` already accepted but no launch could name — and no
other launch, Apple or otherwise, receives it. Every Apple launch also
carries the directory in the profile's `isolatedRoots` denial, which is
emitted after the broad launch-root grants: a checkout bound to an ancestor
of the data root (its own home, say) would otherwise re-allow the subtree
through its `cwd` read root. Seatbelt's last-match ordering then re-allows
the directory only for the launch whose `additionalWriteRoots` names it.

A subtree is acceptable here, where 0133 would prefer a literal node, because
the directory holds only files the host itself mints and sweeps: the capture
path is a per-attempt UUID name, and the host re-reads it with no-follow,
single-link, size-bound, PNG-signature checks before it becomes an artifact.
Nothing a captured Simulator writes can name or shape the path.

## Consequences

- A confined command on another thread can no longer read a Simulator's
  screen while a capture is in flight; the raw pixels never sit inside a root
  it can reach.
- The grant is per-launch, matching 0159's pattern: a future capture that
  needs more of the host fails as a new measured refusal and takes its own
  record rather than widening this one.
- Tests or hosts that keep the default temporary-directory capture location
  keep working unchanged — they simply keep the wider exposure, now with a
  named alternative.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode
- 0133 Confined discovery reads open named nodes, never trees
- 0159 A confined Apple test carries its measured grants
