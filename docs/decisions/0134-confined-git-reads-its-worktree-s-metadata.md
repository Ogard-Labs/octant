# 0134. Confined Git reads its worktree's metadata

**Status:** Accepted

## Context

0009 denies by default, enumerates the rest of the user's home as denied, and
binds Code work to one OS-confined directory. Git does not fit inside that
boundary on its own, and the reason is not the narrow existence checks 0133
admits: a linked worktree's `.git` is a file, not a directory, and it points at
the main repository's `.git/worktrees/<name>`. Both that directory and the
`commondir` it names sit outside the bound root, so a confined command in a
worktree reports `fatal: not a git repository: (null)`. Reaching outside the
bound root is one of the two things 0133 excludes by name.

The user's global configuration is the other, and it is settled the opposite
way. Git treats a permission error on `~/.gitconfig` as fatal rather than as an
empty result, so the first confined launches died before doing any work. That
was answered by not reading it at all: every confined Git launch runs with
`GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, and a commit the
checkout's own config cannot name takes its author from the host's own profile
instead. The profile still emits a read allowance for those paths, left over
from the approach that was replaced; Git never opens them, so it grants nothing
and is reach to remove rather than a boundary to keep.

The worktree fix shipped without a record. It works, and the boundary it draws
is wider than any existing record admits, so it was never stated and never
reviewed. This record states it.

It also records a defect that the missing record helped hide. The worktree
metadata rules granted `file-write*` unconditionally. They reach the profile
through `extraRules`, which is appended last, and Seatbelt resolves by last
matching rule — so those allows overrode the history launch's own write denies
on the same two paths, although that launch sets `writeBoundRoot: false` and
names them in `additionalDenyWritePaths`. Reading history therefore carried
write authority over the parent repository's refs, objects and hooks. Observed
by generating the profile for a real linked worktree: deny on line 45, allow on
the same subpath on line 51; deny on line 46, allow on line 62.

## Decision

This is a scoped exception to 0009's binding of reads to the bound root. It does
not supersede 0133; it covers the one case of the two that 0133 declines to
cover and Octant needs.

- Confined Git may read the **metadata its own worktree names**: the `gitdir`
  that the bound root's `.git` file points at, and the `commondir` that
  directory names. Nothing else outside the bound root is opened, and the parent
  repository's working tree stays denied.
- Because Git canonicalizes a path component by component, every **ancestor** of
  those two paths is granted `file-read-metadata` and nothing more; the walk
  stops at the first ancestor it cannot stat. Metadata on an ancestor discloses
  that it exists, not its listing or its contents.
- **Write on that metadata is refused by default and opted into per launch.**
  These rules are appended last, so a write allow emitted here outranks
  whatever posture the launch itself declared — including Plan's, which 0009
  keeps read-only always. The default is therefore read-only: a caller that
  genuinely writes the metadata asks for it and says why, and a caller that
  forgets is confined rather than widened.
- The grant tracks **the policy in force, not the helper the caller reached
  for**, so a Plan mutation is refused it even though it runs the writable path.
- A port that is not policy-aware may not ask for it at all, because the grant
  would reach every caller it has. Observing mergeability runs
  `merge-tree --write-tree`, which writes the merged tree into the object
  database; it quarantines that output in the launch's own temporary directory
  and reads the real objects through an alternate, the way Git quarantines an
  incoming push, so observation stays read-only for every caller.
- A rule emitted through `extraRules` is **authority the caller granted**, not a
  detail of how the command is spelled. Where a launch declares a posture, the
  appended rules honor it rather than outrank it.

Confined Git reads no configuration from the user's home. Every remaining rule
of 0009 stands: deny-default, the sanitized environment, the write scoping of
the bound root, and Plan and Chat process denial.

## Consequences

- Confined Git runs on macOS for linked worktrees as well as ordinary
  checkouts, which is what Code needs to stage, commit and show history at all.
- Reading history, status, a diff or mergeability no longer implies any write
  authority outside the bound root, so an observation path cannot reach the
  parent repository's hooks.
- The person's own Git settings do not apply inside the sandbox, and their
  identity reaches a commit through Octant's profile rather than their
  configuration. That is the cost of not opening their home.
- The unused global-config read allowance stays in the profile until it is
  removed in its own change; it widens no behavior while Git is told not to
  read it, and narrowing the sandbox is its own deliverable with its own
  evidence.
- The bound root itself remains writable on observation launches, which is
  wider than these paths and is not narrowed here.
- Verified by generating the profile and reading its rules in order, and by
  proving that a linked worktree's mergeability check adds no object to the
  repository it shares. Live confirmation under `sandbox-exec` on macOS remains
  outstanding.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode (one rule scoped)
- 0133 Confined discovery reads open named nodes, never trees (this record
  covers the one case of the two that 0133 excludes)
- 0017 Code Projects bind any folder
