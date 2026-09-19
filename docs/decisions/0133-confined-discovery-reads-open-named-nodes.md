# 0133. Confined discovery reads open named nodes, never trees

**Status:** Accepted

## Context

0009 denies by default and enumerates the rest of the user's home as denied.
Three separate runtimes have since failed against that boundary for the same
underlying reason, and each was fixed on its own without stating a shared rule:

- The Apple toolchain could not drive the Simulator. `simctl` reaches
  CoreSimulatorService over XPC, and the installed runtimes live on the
  cryptex mount under `/private/var/run`, which the `/private` denial covers.
  Without that read every runtime resolved as "runtime profile not found" and
  `simctl list devices available` printed an empty device set while still
  exiting 0 — a silent failure a caller trusting the exit code reports as "no
  Simulator available" on a host with fourteen of them.
- OpenCode 2 could not list providers. Its config discovery resolves each
  bundled coding tool's home directory and treats a refusal as fatal, so the
  confined server answered 500 for `/api/provider` and `/api/model` in every
  posture.
- Confined Git could not run at all: `/usr/bin/git` is a shim that reads the
  xcode-select links under `/private`. Its fix shipped in two parts, also
  without a record, and reached past this class while doing so: alongside the
  shim links it opened the user's global git config and the linked-worktree
  metadata that points outside the bound root.

0115 and 0126 already carry exceptions of exactly this shape, each naming what
it opens. All three cases above shipped without a record, so the rule they
share was never written down. This record states it once, and names what it
does not reach.

A runtime is not asking to read the user's files. It is asking whether a path
exists and what it resolves to, so it can decide what to offer. That is a
narrower need than the denial was written to refuse, and it is the need this
record admits.

## Decision

This is a scoped exception to 0009's rule that the rest of the user's home is
enumerated as denied, and to its `/private` denial. It governs every future
re-allowance of that class.

- A discovery re-allowance names an **exact literal node**, never a subpath.
  The rule opens that node and leaves every entry inside it denied: a runtime
  may learn that `~/.claude` exists and resolve it, and may not read
  `~/.claude/settings.json`. A subpath re-allowance is admissible only for a
  system-owned tree that holds no user content, as the cryptex runtime mount
  does; the user's own directories never qualify.
- The grant is the **weakest verb that was measured to work**, and the
  measurement is recorded. `file-read-metadata` is the default. A stronger
  `file-read-data` on a directory vnode is admissible only where metadata was
  proven insufficient — Bun's `realpath` needs read-data on the directory node
  where Node's needs only metadata — and never on a regular file whose
  contents the runtime does not need.
- The set of named nodes is **closed, not representative**. Only paths the
  runtime actually probes are granted, and only when they already exist. Tool
  homes that happen to sit beside them stay denied.
- The re-allowance is **attached to the launch that needs it**, through
  `extraRules` or an explicit input flag, never added to the shared profile
  default. A launch that does not need the capability does not receive it.
- Re-allowances are **emitted after the denials**. Seatbelt resolves by last
  matching rule, so a rule emitted before the enumerated denials is silently
  overwritten. This is a correctness requirement, not a style preference.
- Reading a person's **configuration content** and reaching **outside the bound
  root** are not this exception. A runtime that needs the user's global
  configuration, or metadata belonging to a repository the thread is not bound
  to, is asking for something wider and takes its own record.

Every remaining rule of 0009 stands: deny-default, exact bound roots, the
sanitized environment, the write scoping, and Plan and Chat process denial.

## Consequences

- A runtime whose discovery probes other tools' homes starts under the same
  confinement as one that does not, and what it learns is limited to which of
  a named set of paths exist.
- Directory entry names inside a granted node stay unreadable, so the
  exception does not disclose what a person has installed beyond the closed
  set the record names.
- The silent-empty-result failure is the expected shape of this class: a
  denial reaches the caller as an empty catalogue and a success exit code, not
  as an error. Diagnosing one means reading the runtime's own log, and a fix
  is not proven by an exit code.
- Two allowances already in the tree fall outside this record, and it does not
  cover them retroactively. Confined Git reads the user's global git config and
  the files that config pulls in through `[include]`, and it canonicalizes
  linked-worktree metadata that points into a repository outside the bound
  root. Both are wider than an existence check on a named node — one is a
  person's configuration content, the other reaches outside the bound root, and
  this record excludes each by name. Both still need a record of their own.
  Saying so here is what keeps a later change from reading this record as their
  authority.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode (two rules scoped)
- 0115 Terminal cache ancestors expose only directory metadata
- 0126 Seatbelt opens trust evaluation and launcher symlink metadata
