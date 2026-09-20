# 0144. A version read launches confined, with no root, no home, and no network

**Status:** Accepted

## Context

0009 says every Octant-spawned subprocess that can execute arbitrary code
launches through the shared confinement builder, with no unconfined fallback.
0143 records which runtime launches are wrapped and names the one launch no
family wrapped: before any confined launch, each family spawns the configured
executable for `--version`. Discovery goes further — it runs a descriptor's
version arguments against a candidate it found on `PATH` or in an approved
directory, so the executable is not even one the user named. The binary path is
user-configured and the candidate is host-found, which is exactly the case 0009
exists for.

0122 gave a readiness probe a named egress exception and said a probe keeps the
confinement it already had: chat-mode, no bound-root writes, no process exec or
fork. A version read had no confinement to keep. It also has no thread and no
managed home, so there is no root to bind and nothing a readiness probe was
given that fits it.

## Decision

- Every `--version` read of a provider executable prepares its launch through
  `prepareConfinedVersionProbe` (`apps/server/src/process/confinedVersionProbe.ts`),
  which wraps the shared builder. That is the six family reads — ACP, Claude,
  Codex, Oh My Pi, OpenCode, Pi — and the discovery scan. A host that cannot
  confine refuses the read as `incompatible`; nothing runs unconfined.
- A version read binds no project root and gets no managed home. One throwaway
  scratch directory is its working directory, its `HOME`, its `TMPDIR`, and the
  only path it may write, and it is removed when the read ends.
- Its environment is reduced in the helper, not by each family. A family builds
  the one it always built; the read keeps only a fixed set of inherited names
  (`PATH`, locale, user identity, terminal hints), what the family computed from
  the scratch directory, and the static guards the family names. Provider
  credentials, cloud keys, and a family's config-home variables
  (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `XDG_*_HOME`) are
  dropped, so a program that consults one falls back to `HOME`. A config-home
  variable left pointing at real provider state is not only a leak: the read
  cannot open it, and OpenCode failed its version read that way with
  `XDG_DATA_HOME` set, which reports the provider unavailable.
- Egress is `none`. 0122's `provider-endpoints-only` exists for a readiness
  check that must reach a provider's control plane to list models; a version
  string is local, so a version read is not covered by that exception and does
  not take it.
- Reads open the program's own install tree and nothing else beneath the user's
  home: the resolved program, its directory, the directory above it, the
  configured launcher's directory, and the outermost `node_modules` the program
  resolves out of when it has one. That is the whole dependency tree rather than
  the entry point's package, because a platform-split CLI keeps its native
  program in a sibling package that a project install or a Bun global hoists
  beside it and a symlinking manager places elsewhere in the tree; the
  package's own directory alone left such a launcher unable to start it, and the
  provider was reported unavailable. A computed root that is the user's home or an ancestor of
  it is dropped rather than granted, because the builder re-allows launch roots
  after its own denials and such a root would hand the home back. Each root is
  judged in both its lexical and its resolved spelling, since the builder
  canonicalises every root: a launcher directory that is a link to the home
  would otherwise pass on its own spelling and open the home once resolved.
- Process execution and fork stay allowed, which a Chat or Plan turn denies.
  This is a scoped exception to one sentence of 0122, that a probe launches
  with no process exec or fork; every other rule of 0122 stands. A provider's
  configured path is routinely a launcher rather than the program — an npm
  entry point that spawns the platform binary beside it, a version manager's
  shim that runs the real CLI through `/bin/sh` — and a denial there is silent:
  the read is reported `unavailable` and the provider disappears from the
  picker on a host where it is installed and working. A child the read starts
  inherits this profile and reaches no more than the read does, and the read
  leads its own process group and ends it when the read settles, so a program
  that forks a background process and exits does not leave it running after its
  scratch is gone. A descendant that starts a session of its own leaves the
  group, the same limit the runtime launches have.
- A confined launch may stat the directories on the way into the roots it was
  granted, even where those directories sit beneath a denied subtree. The
  builder emits metadata-only rules for them; neither the listing nor the
  contents of a denied ancestor open. Without this a program that canonicalises
  a path inside the directory it was just granted is refused at the `/private`
  component, which macOS puts above every temporary directory.
- The readiness probes that read a credential are not covered here: discovery's
  `authProbeArgs`, Claude's `auth status --json`, and the Oh My Pi connection
  check's RPC process. Each reads the provider's own credential state out of the
  user's home or needs a working provider process, so this confinement would
  report every installed provider unauthenticated or unreachable. Giving them a
  home they can read is a readiness-probe question under 0122, and they remain
  the unconfined provider probes the threat model names.

## Consequences

- A replaced or hostile provider executable reaches no project, no home beyond
  its own install tree, no network, and nothing writable but a directory that
  is thrown away — at the moment Octant first runs it, which until now was the
  moment it had the most reach.
- A version read no longer sees the user's real home, so a program that keeps
  state there answers out of a fresh one. Measured across the nine provider
  CLIs installed on the maintainer's host, every version read still succeeds
  and a full discovery scan reports the same versions in the same time.
- Version output is read from stdout. Codex, OpenCode and ACP had folded stderr
  into the same buffer, and a program given a throwaway home may explain what it
  could not set up there before it answers. OpenCode and ACP read stderr only
  when stdout carries no version, so a program that prints it there keeps
  working.

## Related

- 0009 Sandbox confinement and approvals
- 0122 Provider readiness probes reach provider endpoints (one rule superseded
  in scope)
- 0142 Confinement wraps a runtime that carries one thread's authority
