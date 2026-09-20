# 0126. Seatbelt opens trust evaluation and launcher symlink metadata

**Status:** Accepted

## Context

A provider installed as a launcher — Devin's `~/.local/bin/devin` resolving
through `_versions/current/bin/devin` — could not complete an ACP readiness
probe under the deny-default profile (0009). Two rules of the profile, both
correct on their own, combined to make the provider unusable:

- The private-home deny enumeration realpaths its allowed paths. A launcher's
  `current` symlink is not itself an allowed path, so the walk denied it.
  Resolving a link needs read-metadata on the link, so the kernel refused the
  exec of an otherwise allowed binary: `execvp … Operation not permitted`.
- A TLS client that verifies through Security.framework (Rust's
  `rustls-platform-verifier`, which Devin's CLI uses) needs the trust daemon
  and the public system root certificates. Deny-default closed both, so every
  certificate failed with `OSStatus -26276` and the ACP session could not
  reach the provider's own backend.

## Decision

This is a scoped exception to two rules of 0009 — that reads are scoped to the
bound root, provider home, runtime directories, and a private temp, and that
the rest of the user's home is enumerated as denied.

- A launch that may reach the network (the launch resolves egress to the OS
  `allow` value) may look up the `com.apple.trustd` and
  `com.apple.trustd.agent` services and read `/System/Library/Keychains` and
  `/System/Library/Security`. Those are the platform trust path and public
  root material. `/Library/Keychains` and every other default denial stay in
  place.
- A symlink that sits in a denied private-home path stays readable when its
  own target resolves onto an allowed path, or onto an ancestor of one,
  because resolving a link needs read-metadata on the link itself. Only the
  link's own target text is read, never followed: a link whose target is
  unrelated to the allowed set stays denied, and a broken link that points
  onto an allowed path grants link metadata only.
- Allowed executables and interpreters retain both their lexical launcher path
  and canonical target. Private-home deny enumeration must not deny the
  lexical parent needed by `/usr/bin/env` or another already-allowed launcher
  to open that exact interpreter. Sibling binaries remain denied unless they
  have their own allowlisted path.

Every remaining rule of 0009 stands unchanged: deny-default, the enumerated
home denials, exact bound roots, the sanitized environment, and Plan/Chat
process denial.

## Consequences

- A provider installed as a launcher (Homebrew, version managers, `~/.local/bin`
  shims) starts under the same confinement as a directly installed one.
- A provider process that verifies certificates through Security.framework can
  evaluate them without opening private keychains or secret stores.
- The trust allowance is keyed to network reachability, so an offline launch
  keeps the trust path closed.
- The symlink allowance exposes link metadata and nothing else; the target
  tree's own allow and deny rules still decide what can be read through it.

## Related

- 0009 Sandbox confinement and approvals (two rules scoped)
- 0122 Provider readiness probes reach provider endpoints
- 0140 A Plan turn is confined by Octant (the same read rule scoped again)
