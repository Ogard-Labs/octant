# 0056. Linux confinement uses Bubblewrap as a scoped exception to the Seatbelt-only implementation

**Status:** Accepted

## Context

ADR 0009 requires every Octant-spawned subprocess that can execute arbitrary
code to launch through one shared macOS Seatbelt profile builder with a
deny-default profile, and it explicitly forbids an unconfined fallback. That
keeps Work, Code, shell commands, repository tests, Git helpers, and ACP
provider processes confined, but it also means any host without `sandbox-exec`
reports `incompatible` and refuses to run agents.

Headless Linux Stations need the same execution surfaces. Linux has no
`sandbox-exec`, but it does have unprivileged user namespaces and the
Bubblewrap (`bwrap`) tool, which can build a fresh root, unshare PID, network,
IPC, UTS, user, and CGroups namespaces, mount a private `/proc` and `/dev`, bind
read-only system directories, and expose only selected writable roots plus a
private tmpfs. The policy semantics of ADR 0009 — bound root, provider home,
private temp, deny-default, Plan read-only, and no unconfined fallback — can be
expressed with those primitives, but the _mechanism_ is different.

## Decision

- ADR 0009 remains Accepted. Every rule in that record stands, **except** the
  implementation detail that the shared confinement builder is a macOS Seatbelt
  profile. This ADR supersedes that single platform-specific mechanism.
- On macOS, the shared confinement builder continues to use `sandbox-exec`.
- On Linux, the shared confinement builder uses Bubblewrap (`bwrap`) with:
  - `--unshare-all` so the child cannot see or affect host processes, the host
    network namespace (unless the thread policy allows egress), IPC, or UTS.
    That flag includes `--unshare-cgroup-try`, so cgroup-namespace isolation is
    best effort and must not be treated as guaranteed;
  - `--new-session` and `--die-with-parent` to detach the child from the host
    TTY/session and terminate it when the launcher exits;
  - `--proc /proc` and `--dev /dev` to provide a private kernel pseudo-fs view;
  - read-only binds for `/usr`, `/bin`, `/lib`, `/lib64`, `/sbin`, `/etc`,
    `/run/systemd/resolve` (when network is allowed, so DNS resolves), and any
    other host directories required by the runtime but not writable;
  - writable binds for the bound root, the provider home/runtime directory, and
    any additional write roots declared by the caller;
  - a private writable `--tmpfs /tmp` (and `/var/tmp` when present) so a caller
    that passes `/tmp` as its temporary directory never binds the host temp.
    A dedicated temporary directory is still bound, after that tmpfs, so only
    that path comes from the host. Deny-path tmpfs overlays are remounted
    read-only; the private `/tmp` tmpfs is not;
  - a per-shell `HOME` set to the provider's runtime directory, so the real
    home directory never needs to be writable;
  - mounts sorted by target depth before emission, so a parent bind does not
    shadow a child writable bind;
  - `--remount-ro /` after the writable binds, which makes the synthetic root
    read-only without recursively remounting the writable tmpfs or binds
    underneath it;
  - `--share-net` only when the resolved network egress policy is not `none`;
  - deny paths overlaid with an empty source (directory or file) when they
    overlap any mount, including read-only binds from `readRoots` or
    `privateHomeAllowPaths`;
  - missing or unusable `bwrap` fails closed as `incompatible`, exactly like a
    missing `sandbox-exec`; there is no unconfined fallback.
- The `SeatbeltConfinementPort` name is historical; it is the shared choke point
  and dispatches to the platform-specific backend. No caller bypasses it.
- `AcpConfinementPort` and `PiConfinementPort` route `deny-default` / bounded
  confinement through the same shared builder on Linux, so Devin, Codex,
  OpenCode, Kilo, Grok, Mistral Vibe, and the bounded `pi` path are confined
  consistently with Work and Code.
- `immutable-managed-profile` (Kimi Code's managed profile mode) remains
  macOS-only and fails closed on Linux; it is not replaced by an unconfined
  alternative.
- 0054's consequence that Work and Code remain incompatible on Linux is
  superseded for this Seatbelt-equivalent path. This backend is interim:
  0048 capsules remain the stronger Station isolation layer and stay unwired.

## Consequences

- A Linux Station can run the same `SeatbeltConfinementPort`-confined Work,
  Code, shell, test, Git, and ACP provider paths as a Mac, using the same
  policy inputs and the same `incompatible` fail-closed behavior when the tool
  is unavailable.
- The builder must sort mounts and handle deny-path overlays explicitly, because
  `bwrap`'s bind semantics differ from Seatbelt's path rules.
- Network egress is still two-level (`none`/`allow`). Finer-grained allowlists
  continue to be enforced by brokered tools, not by `bwrap` itself.
- Bubblewrap is a simpler kernel boundary than gVisor capsules, so a Linux host
  can become a usable Station before ADR 0048 is fully implemented.
- Hosts must install `bubblewrap` (`bwrap`) and have unprivileged user
  namespaces available. Missing either is reported honestly instead of silently
  degrading.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode
- 0048 Linux Stations isolate Code work in execution capsules
- 0031 Hosts as environments
- 0006 ACP agent drivers as one generic stack with per-provider profiles
