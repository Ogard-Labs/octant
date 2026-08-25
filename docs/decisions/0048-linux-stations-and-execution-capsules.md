# 0048. Linux Stations isolate Code work in execution capsules

**Status:** Proposed

## Context

A headless Linux host can run the Octant server, but its Code work still lands
in host worktrees. Worktrees separate checkouts, not kernels, processes, Git
object stores, credentials, provider runtimes, or resource use. They cannot be
the confinement boundary for several issues running untrusted code at once.

The product language is also overloaded. "Remote" sometimes means a paired
device and sometimes the Machine that owns work. "Environment" names both a
connected host and a thread's execution summary. Mobile has no local host at
all. The execution owner and the controller need distinct names before a Linux
host becomes a first-class destination.

## Decision

- A **Device** controls work. A **Machine** owns threads, data, credentials, and
  execution. **This Mac** is the local desktop Machine, a **Remote Mac** is
  another paired macOS Machine, and a **Station** is a persistent headless
  Linux Machine. Existing `HostId` wire identity remains unchanged.
- "Remote" describes the relationship between a Device and a Machine. It is
  not a Machine kind. Desktop and mobile will present Devices separately from
  the Machine selected as the destination for new work.
- **Environment** remains the thread's execution-context summary. When the
  presentation migration lands, it no longer names a connected Machine. Until
  then, 0031 continues to govern existing host ownership and merged reads.
- Every Station Code thread owns one **execution capsule**. Every concurrent
  writing child AgentRun owns a distinct child capsule. Workspace receipts
  still grant authority; a receipt is not the OS confinement mechanism.
- A protected capsule treats dependencies, generated code, tests, and provider
  subprocesses as untrusted. The first backend is rootless Podman with gVisor
  `runsc` on `systrap`. Missing or unverified confinement fails closed; Octant
  never substitutes ordinary `runc` and still calls the result protected.
- A capsule has an independent clone and Git object store. It receives no host
  checkout bind mount, Git alternates, hardlinked object store, personal home,
  Docker socket, raw long-lived credential, or unrelated service authority.
- The existing confined host Git boundary produces an owner-only source bundle
  inside the Station's dedicated capsule-source root. The capsule driver refuses
  owner-readable paths outside that root, verifies identity and digest, then
  clones and verifies exports inside gVisor. The driver never runs Git directly
  on the Station.
- Provider CLIs and every mutable subprocess run inside the capsule. The
  journal, authority engine, and direct HTTP inference stay on the Station.
  Mutable provider runtimes are never reused across capsule identities.
- A Project owns a digest-pinned capsule recipe. The host admits work only when
  it can honor the declared CPU, memory, disk, and PID budget; otherwise work
  queues or refuses before a capsule starts.
- The entire persistent Podman VFS graph store for one capsule lives in its own
  fixed-size ext4 image, mounted by the unprivileged Station identity through
  `fuse2fs` at an owner-only mount point with `nodev` and `nosuid`.
  `allow_other` lets the rootless gVisor gofer enter that private tree; the
  mount-point permissions still exclude unrelated host accounts. Podman may
  make intermediate state directories traverse-only (`0711`) for the remapped
  gofer; those paths remain owned by the Station identity and never grant group
  or other read or write access. Backing images remain owner-only (`0600`). Image layers,
  dependencies, and the independent clone all count against the same hard disk
  ceiling. Podman's disposable runroot uses a short, owned directory below the
  Station identity's runtime directory, with the same no-read/no-write
  traverse-only allowance. Server-process recovery preserves it long enough to
  inspect and stop any surviving runtime, creates it only when absent, and
  deletes it through Podman's user namespace on release. It contains no capsule
  filesystem or source data. No capsule store is a host-checkout bind mount.
- gVisor's additional self-backed root overlay is disabled. Each rootfs is
  already an independent private VFS layer inside that capsule's fixed-size
  image, and direct propagation lets the host export broker read only the
  explicitly requested bundle through Podman after the in-capsule checks.
  Shared rootfs revalidation is enabled for that controlled copy boundary.
- The Station starts each Podman `no-conmon` and `runsc` capsule inside a
  transient scope owned by the Station identity's systemd user manager. That
  outer scope applies the CPU, memory, and PID limits. Rootless `runsc` ignores
  its unsupported duplicate cgroup setup. The driver reads the live sandbox
  process cgroup ancestry and refuses the capsule unless the effective finite
  limits are equal or narrower; independent Linux evidence checks the same
  boundary before the backend is accepted.
- Capsule egress is deny-default and later passes through a host-owned broker
  with destination, DNS, expiry, and audit checks. Selected preview ports pass
  through an authenticated thread-scoped host proxy, never a direct bind.
- The filesystem may persist across turns and Station restarts. Processes do
  not. Restart revalidates the owner, Project, recipe, provider, authority, and
  network grant before new work starts.
- Code returns through an explicit commit, Git bundle, patch, or named artifact
  with provenance and diff. Import and destruction require user confirmation;
  no capsule pushes, merges, or deletes itself as a side effect.
- The Station runs as a dedicated unprivileged `octant` OS user with no sudo,
  Docker group, personal home, or another service's credentials. Host secrets
  stay in a dedicated Secret Service collection unlocked with a host-bound
  encrypted systemd credential.
- A future **Disposable Desktop** is a provider-neutral graphical destination
  leased by one thread. E2B is the first planned provider. It receives only a
  named artifact, never the capsule checkout or host credentials, and is not a
  Station or an execution capsule.

## Consequences

- Linux Code support is intentionally incompatible until the complete capsule
  probe succeeds. A server that merely starts or can run an ordinary container
  is not a usable Station.
- Independent clones cost more disk and setup time than worktrees. They remove
  the shared Git store that would otherwise let one issue alter another.
- Per-capsule VFS stores duplicate image data and trade startup speed for a
  durable hard disk ceiling that does not grant the Station identity project-
  quota or block-device authority.
- Some provider CLIs cannot run until they accept brokered credentials. Octant
  reports that incompatibility instead of copying login state into the capsule.
- gVisor compatibility limits are visible Project-recipe facts. Firecracker or
  another backend may implement the same capsule contract later without
  weakening the protected posture.
- Devices, Machines, E2B streaming, LAN/Tailscale provisioning, and ordinary
  thread integration land as separate coherent changes after the isolation
  tracer proves the boundary.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode
- 0012 Mixed-provider subagents and agent runs
- 0013 Remote access: single host, paired devices, and mobile
- 0023 Bringing a run home
- 0031 Hosts as environments
- 0040 Collaboration: share a host or a git remote
