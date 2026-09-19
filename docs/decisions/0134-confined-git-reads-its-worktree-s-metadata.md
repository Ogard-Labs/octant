# 0134. Confined Git reads its worktree's metadata

**Status:** Accepted

## Context

0009 denies by default, enumerates the rest of the user's home as denied, and
binds Code work to one OS-confined directory. Git does not fit inside that
boundary on its own, and the reason is not the narrow existence checks 0133
admits: a linked worktree's `.git` is a file, not a directory, and it points at
the main repository's `.git/worktrees/<name>`. Both that directory and the
`commondir` it names sit outside the bound root, so a confined command in a
worktree reports `fatal: not a git repository: (null)`.

The user's global configuration is the other case 0133 excludes, and it is
settled the opposite way. Git treats a permission error on `~/.gitconfig` as
fatal rather than as an empty result, so the first confined launches died
before doing any work. That was answered by not reading it at all: every
confined launch runs with `GIT_CONFIG_GLOBAL=/dev/null` and
`GIT_CONFIG_NOSYSTEM=1`, and a commit the checkout's own config cannot name
takes its author from the host's own profile. The profile still emits a read
allowance for those paths, left over from the approach that was replaced; Git
never opens them, so it grants nothing and is reach to remove.

Both fixes shipped without a record, so the boundary they draw was never stated
and never reviewed. 0133 says in its consequences that confined Git is left
unresolved and that both blockers still need their own decision, which was
already untrue when it was accepted. An `Accepted` record is not edited in
place, so 0133 points here and this record is where the boundary stands.

The missing record also helped hide a defect. The worktree metadata rules
granted `file-write*` unconditionally, and they reach the profile through
`extraRules`, which is appended last. Seatbelt resolves by last matching rule,
so those allows overrode the history launch's own write denies on the same two
paths, although that launch sets `writeBoundRoot: false` and names them in
`additionalDenyWritePaths`. Reading history therefore carried write authority
over the parent repository's refs, objects and hooks. Observed in a generated
profile for a real linked worktree: deny on line 45, allow on line 51.

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
  These rules are appended last, so a write allow emitted here outranks whatever
  posture the launch itself declared — including Plan's, which 0009 keeps
  read-only always. A caller that genuinely writes the metadata asks for it and
  says why; a caller that forgets is confined rather than widened.
- **Only a non-Plan mutation launch may emit that allow.** Because the appended
  rule outranks the posture, Plan cannot be protected by the confinement it
  declares; the caller withholds the grant instead, asking for write only when
  the policy in force is not Plan. The grant tracks **the policy in force, not
  the helper the caller reached for**, so a Plan mutation is refused it even
  though it runs the writable path.
- A port that is not policy-aware may not ask for it at all, because the grant
  would reach every caller it has. Observing mergeability runs
  `merge-tree --write-tree`, which writes the merged tree into the object
  database; it quarantines that output in a temporary directory and reads the
  real objects through an alternate, the way Git quarantines an incoming push,
  so observation stays read-only for every caller.
- **A launch names every directory it writes outside the bound root**, including
  one the caller just made. On Linux a shared host temporary root is replaced by
  a private tmpfs rather than bound, so an unnamed directory under it does not
  exist for the confined process at all.
- A rule emitted through `extraRules` is **authority the caller granted**, not a
  detail of how the command is spelled. Where a launch declares a posture, the
  appended rules honor it rather than outrank it.

Confined Git reads no configuration from the user's home. Every remaining rule
of 0009 stands: deny-default, the sanitized environment, the write scoping of
the bound root, and Plan and Chat process denial.

## Consequences

- Confined Git runs **on macOS** for linked worktrees as well as ordinary
  checkouts, which is what Code needs to stage, commit and show history at all.
  Reading history, status, a diff or mergeability no longer implies any write
  authority outside the bound root, so an observation cannot reach the parent
  repository's hooks.
- These allowances are Seatbelt rules, and Linux confinement refuses any launch
  that carries one, so a linked worktree is not usable there at all: every Git
  command in it fails before it runs. An ordinary checkout emits no such rule
  and is unaffected. Saying the same thing in Bubblewrap mounts is outstanding
  and is its own change, sequenced by 0058.
- The person's own Git settings do not apply inside the sandbox, and their
  identity reaches a commit through Octant's profile instead. That is the cost
  of not opening their home. The unused read allowance on those paths stays
  until it is removed in its own change, with its own evidence.
- The bound root itself remains writable on observation launches, which is wider
  than these paths and is not narrowed here.
- Verified by generating the profile and reading its rules in order, and by
  proving that a linked worktree's mergeability check adds no object to the
  repository it shares. Live confirmation under `sandbox-exec` remains
  outstanding.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode (one rule scoped)
- 0133 Confined discovery reads open named nodes, never trees (this record
  covers the one case of the two that 0133 excludes, and corrects its
  consequence that both are unresolved)
- 0017 Code Projects bind any folder
