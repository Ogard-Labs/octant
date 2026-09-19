# 0134. Confined Git reads the user's config and its worktree's metadata

**Status:** Accepted

## Context

0009 denies by default, enumerates the rest of the user's home as denied, and
binds Code work to one OS-confined directory. Git does not fit inside that
boundary on its own, and the reasons are not the narrow existence checks 0133
admits:

- Git treats a permission error on its global configuration as fatal, not as an
  empty result. A confined launch that cannot read `~/.gitconfig` fails with
  `fatal: unable to access '/Users/…/.gitconfig': Operation not permitted`
  before it does any work. That file is a person's configuration content, which
  0133 excludes by name.
- A linked worktree's `.git` is a file, not a directory, and it points at the
  main repository's `.git/worktrees/<name>`. Both that directory and the
  `commondir` it names sit outside the bound root, so a confined command in a
  worktree reports `fatal: not a git repository: (null)`. Reaching outside the
  bound root is the other thing 0133 excludes by name.

The fixes for both shipped without a record. They work, and the boundary they
draw is wider than any existing record admits, so it was never stated and never
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

This is a scoped exception to 0009's rule that the rest of the user's home is
enumerated as denied, and to its binding of reads to the bound root. It does not
supersede 0133; it covers what 0133 declines to cover.

- Confined Git may read the user's **global Git configuration**: `~/.gitconfig`
  and the `git` directory under `XDG_CONFIG_HOME`, plus the files those pull in
  through `[include]` and `[includeIf]`, followed to a bounded depth. The set is
  resolved from the configuration actually present, not from a representative
  list. No other configuration content in the home directory is opened.
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
  forgets is confined rather than widened. The grant tracks the policy in
  force, not the helper the caller reached for, so a Plan mutation is refused
  it even though it runs the writable path. Writing a merged tree into the
  object database is a write; reading history, status or a diff is not.
- A rule emitted through `extraRules` is **authority the caller granted**, not a
  detail of how the command is spelled. Where a launch declares a posture, the
  appended rules honor it rather than outrank it.

Every remaining rule of 0009 stands: deny-default, the sanitized environment,
the write scoping of the bound root, and Plan and Chat process denial.

## Consequences

- Confined Git runs on macOS for both ordinary checkouts and linked worktrees,
  which is what Code needs to stage, commit and show history at all.
- The user's Git identity and configured behavior reach the confined command, so
  commits carry the right author and the person's own settings apply. That is
  the point of the allowance and also its cost: this content is read inside a
  sandbox the person did not inspect.
- Reading history no longer implies any write authority outside the bound root,
  so an observation path cannot reach the parent repository's hooks.
- A person's configuration can name include paths anywhere, so a wider grant
  follows a wider configuration rather than a wider rule.
- Verified by generating the profile and reading its rules in order, not by
  running `sandbox-exec`. Live confirmation on macOS remains outstanding.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode (two rules scoped)
- 0133 Confined discovery reads open named nodes, never trees (this record
  covers the two cases 0133 excludes)
- 0017 Code Projects bind any folder
