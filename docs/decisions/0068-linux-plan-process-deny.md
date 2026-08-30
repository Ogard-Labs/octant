# 0068. Linux Plan process denial uses seccomp

**Status:** Accepted

## Context

0009 requires Plan (and Chat) to deny writes and process execution at the OS
sandbox, not only in policy. 0057 implements that sandbox on Linux with
Bubblewrap. Bubblewrap loads a seccomp program before it execve's the confined
command, so a filter that blocked `execve` would prevent the launch itself.
The first Linux implementation overlaid host executable search paths with
tmpfs and re-bound the launch binary. That hid shells from `PATH` but did not
stop `fork`/`clone`, so a process that still had an interpreter could spawn a
child.

## Decision

- 0009 and 0057 remain Accepted. This record names the Linux mechanism for
  `allowProcessExec: false` / `allowProcessFork: false`.
- When either flag is false, keep the tmpfs overlay of host executable search
  paths and the read-only re-bind of the launch binary.
- When `allowProcessFork` is false, load a seccomp filter that:
  - allows `clone` only with `CLONE_THREAD` (pthreads);
  - returns `ENOSYS` for `clone3` so libc falls back to `clone`;
  - returns `EPERM` for `fork` and `vfork` on architectures that have them.
- When `allowProcessExec` is false, the same filter returns `EPERM` for
  `execveat`. It cannot deny `execve`: that syscall is how Bubblewrap starts
  the command.
- The filter is a compiled classic BPF program passed as `--seccomp FD`.
  Launch argv stays `{ command, args }` by wrapping `bwrap` in `/bin/sh` so
  the fd can be opened without changing spawn sites. Missing `/bin/sh` fails
  closed as `incompatible`.
- The filter is arch-specific (`x64` and `arm64`). Other Linux architectures
  fail closed.
- This is not identical to macOS omitting `(allow process-exec)`. A Linux
  Plan process can still `execve` an absolute path that remains visible
  (the launch binary, `/proc/self/fd/...`). It cannot fork a child to keep
  running as a shell.

## Consequences

- Plan Git and Chat/Plan ACP on Linux fail closed for process creation the
  way 0009 requires, without breaking the first execve.
- Spawn sites keep consuming `{ command, args }`.
- A later Landlock execute allowlist or a helper that installs a second
  filter after exec could close the remaining self-execve hole; it is not
  this change.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode
- 0057 Linux confinement uses Bubblewrap as a scoped exception to the
  Seatbelt-only implementation
