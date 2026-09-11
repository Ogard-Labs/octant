# 0115. Terminal cache ancestors expose only directory metadata

**Status:** Accepted

## Context

Opening a configured zsh in either utility panel printed a permission error
while creating its cache. A native Seatbelt reproduction showed that
`mkdir -p` checks every parent even when those directories already exist.
The shared terminal-state read denial also denied that metadata, so the
command attempted to recreate an existing protected ancestor and failed.

## Decision

- Terminal launches allow `file-read-metadata` for each exact, canonical
  ancestor of the launch's own shell-state directory. They do not grant a
  recursive read root or any new write root.
- This is a scoped exception to 0092's named shell read-root rule for these
  directory metadata checks only. The person's configuration remains
  read-only, the bound root and own cache remain the only writable state
  outside private temporary storage, and Linux's managed-home policy stands.
- The shared terminal-state directory still cannot be listed. Other
  repositories' histories and caches remain unreadable and unwritable,
  including siblings created after the launch profile was prepared.
- Plan still refuses terminal creation. All other terminal confinement,
  network and lifecycle rules remain unchanged.

## Consequences

Shell-framework cache setup succeeds without a broad filesystem exception.
The native regression exercises the actual generated profile and proves
cache creation together with sibling listing, read and write refusals.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode
- 0092 The terminal reads the shell's own configuration
