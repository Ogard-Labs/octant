# Remote SSH environments

This topic specification owns how a Code thread runs on a machine the host
reaches over SSH: what an SSH target is, how the host connects to it, how it
proves its confinement before any work is admitted, what happens when the
connection drops, where the record of that work lives, and how this differs from
a paired Octant host and from a hosted relay. Architecture owns the boundaries it
builds on: [modes and checkout binding](../architecture.md#modes-chat-work-and-code),
[persistence](../architecture.md#persistence), and
[security and authority](../architecture.md#security-and-authority).

**Delivery state.** Accepted 2026-10-26. Slices 2, 3, 4, and 5 are built. Slice 2
is the admission policy and contracts: the schemas in
`packages/contracts/src/sshTarget.ts` and the pure decision in
`packages/domain/src/sshTargetAdmissionPolicy.ts`. Slice 3 is the executor,
transport, and attestation in `apps/server/src/sshTarget/`: the executor behind
`octant executor --stdio`, the framed protocol in
`packages/contracts/src/sshExecutorProtocol.ts`, the host connection service,
the local administration routes, `octant ssh-target`, and Linux canaries.
Slice 4 binds a Code Project to a remote root from this machine and reads its
Files, Git status, and diff through the executor
([Remote-bound Projects and reads](#remote-bound-projects-and-reads)), and
journals targets, attestation digests, and bindings
(`packages/contracts/src/sshTargetEvents.ts`). Slice 5 runs the native
harness's file tools and commands for a remote-bound Project's turn through the
executor, with their egress decided and journaled on this host
([Native harness on a target](#native-harness-on-a-target)): the remote tool
set (`forRemoteCode` in `apps/server/src/harness/nativeHarnessComposition.ts`,
`apps/server/src/sshTarget/sshRemoteHarness.ts`) and the executor's launches,
file tools, and streams. The Code turn runtime does not yet compose that tool
set for a thread, and no thread can be created in a remote-bound Project, so
no product route reaches a target's tools; that step, reconnecting on its own,
and restart recovery of remote turns are not built. Slice 6 is built in part:
the provider-sdk process-placement seam, its conformance harness, and this
host's admission of a placed runtime from its driver's declaration
([Provider runtimes on a target](#provider-runtimes-on-a-target)). No
driver declares remote placement yet, the executor cannot yet start a
runtime process, and so no runtime has been launched on a target. Slice 7 is
built: a person's terminals and managed worktrees on a remote-bound Project,
under the same admission
([Terminals and managed worktrees](#terminals-and-managed-worktrees)),
Settings › SSH targets, and the Project picker's listing; its packaged
desktop smoke on a Mac remains. Slice 8 is not built. Remote SSH
environments are authorized post-preview work as of 2026-10-26, when the
maintainer unlocked the parked backlog and accepted the
[maintainer decisions](#maintainer-decisions) below. That authorizes this design
and its delivery slices; it does not change the
[Current Release Boundary](../architecture.md#current-release-boundary), which a
separate change updates.

## Outcome

A person binds a Code Project to a folder on another machine they can already
reach with `ssh`. Threads in that Project run there: Git, file reads and edits,
commands, tests, and the agent's tools act on the remote folder, under the same
approval posture and OS confinement the thread would have on this Mac. This host
keeps the thread, its journal, its approvals, and its credentials. The remote
machine is the thread's hands, never an authority.

Before any work is admitted, the remote must prove that it confines launches the
way this host would. When it cannot, admission refuses with a reason and a
recovery the person can perform. That refusal is the acceptance criterion this
design is built around.

## Terms

- **SSH target.** A remote machine this host has registered: an SSH destination
  (as the person would type it after `ssh`), a pinned host key, and the path of
  the executor on it. The remote user and platform are facts each connection
  attests, not part of the registration. An SSH target is
  not a host, a Machine, or a paired device. It has no journal, identity key,
  listener, or credential store of Octant's.
- **Executor.** A small Octant process on the SSH target, started by this host
  over one SSH session and speaking only on that session's standard input and
  output. It launches confined processes and performs file operations on request,
  and does nothing on its own initiative.
- **Remote root.** The folder on the SSH target a Code Project binds, as a local
  Code Project binds a directory on this Mac.
- **Attestation.** The executor's evidence, checked by this host, that it can
  confine a launch in a given posture as this host would. It is evidence for one
  connection and is never carried to the next.

"Environment" is not used for the entity because it already names a connected
host in multi-host views and a thread's execution summary.

## What exists today

- **Confinement port.** Every Octant-launched tool process goes through
  `ProcessConfinementPort` (`apps/server/src/process/seatbeltProfile.ts`):
  Seatbelt on macOS, Bubblewrap on Linux (`process/linuxConfinement.ts`), the Plan
  seccomp filter (`process/linuxProcessDenySeccomp.ts`), and the proxied egress
  forwarder (`process/proxiedNetworkEgress.ts`). The port supports macOS and
  Linux and refuses every other platform. On Linux the backend check is presence
  only (`requireLinuxConfinement`): an executable `bwrap` passes, and a kernel
  that refuses its namespaces fails later, at launch.
- **Runtime confinement matrix.** Which provider runtimes Octant wraps, and in
  which posture, is the table under
  [Sandbox](../architecture.md#security-and-authority), pinned by
  `process/providerProcessConfinement.test.ts`. Codex in every posture and Claude
  outside Plan rest on the runtime's own sandbox.
- **Provider launch seam.** `ProviderAcquireInput.projectRoot` in
  `packages/provider-sdk/src/driver.ts` is a host path, and each runtime module
  (`apps/server/src/providers/claudeProcess.ts`, `codexProcess.ts`,
  `acpProcess.ts`, `openCodeProcess.ts`, `piProcess.ts`) spawns a local process
  itself. Since slice 6 the acquisition can carry a remote placement that a
  driver declares support for; no in-tree driver declares it.
- **Code environment reads.** `apps/server/src/codeEnvironmentService.ts` and
  `gitEnvironmentPort.ts` observe a checkout through a local Git process.
- **Harness egress.** The native harness runs commands on `proxied` egress: a
  host proxy decides each connection under the
  [harness tool egress rules](../architecture.md#harness-tool-egress-rules)
  (`decideToolEgress` in `packages/domain/src/toolEgressPolicy.ts`) and journals
  the decision; harness inference leaves from the server process.
- **Child environment.** `apps/server/src/childProcessEnvironment.ts` strips the
  broker and bridge-secret variables from every child.
- **Headless artifact.** `scripts/package-headless.ts` builds a self-contained
  Linux or macOS install of `bin/octant` and the server, which verifies every
  listed file before it runs.
- **SSH today.** Octant creates and supervises no SSH connection. A user-managed
  `ssh -L` tunnel to the listener is compatible and grants nothing
  ([remote access](../decisions/0013-remote-access-and-mobile.md)); confined
  launches deny `~/.ssh` and `/etc/ssh`.

## Settled by existing specifications

These rules already hold and this design does not reopen them:

- Code binds exactly one directory; Plan is always read-only; Full access only
  when explicitly remembered for that Project; agents never mark a thread Done.
- Authority is checked on this host before any effect. A tool call is a
  petition. Remote clients never exceed host, mode, provider, Project, or thread
  authority.
- The journal on this host is authoritative and projections are rebuildable.
- Hosts never trust each other, and no mutation is queued for an unreachable
  destination ([0059](../decisions/0059-multi-host-federation.md)).
- Missing confinement fails closed, and a fail-closed refusal names a recovery.
- New capabilities reach providers through published seams; a capability a seam
  cannot express is a seam change of its own.
- Provider credentials stay in the host credential service; no Octant account,
  cloud service, relay, or telemetry.

## Approved design

### Scope

Code only. Chat and Work are not offered on an SSH target: Chat has no
filesystem, and Work's confinement and document adapters are not part of this
design. A Code Project is either local or bound to one remote root on one SSH
target; it never mixes them, and a Project's binding never changes kind. Remote
targets are Linux and macOS, the two platforms the confinement port supports;
any other platform is refused `unsupported-platform`.

### Registering an SSH target

Only a local window or the local CLI (the desktop bridge secret) can register,
re-pin, or remove an SSH target, as for listener administration. A paired device
can run threads in an existing remote-bound Project under that Project's
authority, and cannot add a target, accept a changed host key, or bind a new
remote root.

Registration connects once, shows the host key fingerprint the remote presented,
and pins it only when the person confirms it. Octant keeps its pins in its own
owner-only known-hosts file under the data directory and connects with that file
alone, so a later change to the person's own known-hosts file never re-trusts a
target. A changed key refuses every connection `host-key-changed` until the
person confirms the new key from a local window. A destination may not begin
with `-` or hold whitespace or a control character, because it is one argument
of the SSH client and a leading `-` would be read as an option such as
`-oProxyCommand`. Its user and host may not begin with `-` either, and it holds
no shell metacharacter such as `;`, `$`, `|`, a quote, or a backtick, because
the client substitutes the host into a configured `ProxyCommand`; OpenSSH 9.6
refuses the same names itself, and older clients pass them on.

These rules settle how registration reads and pins a key, each in the
fail-closed direction:

- **Reading the key logs in nowhere.** The probe connects with every
  authentication method off and asks for no command (`-N`), accepting the new
  key only into a fresh file of its own, so it ends at "permission denied". The
  host holds the key it read for ten minutes, for one confirmation: a
  fingerprint that does not match, or a second use, refuses and pins nothing.
- **The person confirms the fingerprint.** `octant ssh-target add` and
  `repin` show it and pin only on a typed `yes`, or on `--fingerprint` given
  beforehand and equal to the one presented; without a terminal and without
  that flag nothing is pinned. A re-pin probe must name the target's own
  destination (`destination-mismatch` otherwise).
- **One pin file per target.** Each target's known-hosts file holds exactly its
  pinned key for every name (`*`), so the person's configuration may resolve
  the destination to any host name, port, or jump host without the pin
  depending on which name the client looks up, and the file never vouches for
  another target. The registration and the file are owner-only.
- **A registration remembers no attested fact.** It holds the destination, the
  pinned key, and the executor path. The remote user and platform are facts of
  each connection's attestation and are shown only while that connection holds
  one.

### Transport

One SSH connection per target, owned by a host service in `apps/server`. The host
runs the system OpenSSH client with a fixed argument list. Nothing a thread,
model, or remote produces reaches its arguments or environment. The client
inherits only `HOME`, `USER`, `LOGNAME`, `PATH`, `SSH_AUTH_SOCK`, `TMPDIR` and the
locale, never the server's whole environment: a person's `SendEnv` pattern would
otherwise forward provider keys exported in their shell to any target whose
`sshd` accepts them. Options given on the command line take precedence over the
person's SSH configuration, and these are always set:

| Option                                                | Why                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `ForwardAgent=no`, `ForwardX11=no`                    | The remote never gains the person's SSH identity or display     |
| `ClearAllForwardings=yes`                             | A configured port forward cannot open a path into this Mac      |
| `PermitLocalCommand=no`                               | A configured local command never runs on this Mac               |
| `StrictHostKeyChecking=yes`, `UserKnownHostsFile=<…>` | Only the pinned key is accepted, from Octant's file             |
| `BatchMode=yes`, `-T`                                 | No password or passphrase prompt reaches Octant; no remote PTY  |
| Remote command: the executor's absolute path only     | The remote shell receives no interpolated data, only the binary |
| `--` before the destination                           | No destination can be read as an option, whatever the schema    |

Slice 3 settled the rest of the list, each against a configured behavior that
would otherwise weaken a row above: `GlobalKnownHostsFile=/dev/null`,
`KnownHostsCommand=none`, `VerifyHostKeyDNS=no`, `UpdateHostKeys=no`,
`CheckHostIP=no`, and `HashKnownHosts=no` keep Octant's pin file the only voice
for the target's key; `ControlMaster=no` and `ControlPath=none` keep a shared
master, checked under other rules, from carrying the session;
`RemoteCommand=none` keeps a configured command from replacing the executor;
`ForwardX11Trusted=no` and `Tunnel=no` close the remaining forwarding paths;
`EscapeChar=none` keeps frame bytes from controlling the client; and
`ServerAliveInterval=15` with `ServerAliveCountMax=3` turns a silent session
into a lost one. The known-hosts path is quoted, with `%` doubled, because
OpenSSH splits that option's value on whitespace into several files and expands
`%` tokens in it: unquoted, a data directory under macOS's `Application
Support` named `~/Library/Application` as a second known-hosts file, which the
probe wrote every key it read into and every session then trusted. A path
holding a quote, backslash, or control character is refused.
`apps/server/src/sshTarget/sshClientArguments.ts` holds the list, and its test
pins it. The remote command is the executor path followed by
the fixed words `executor --stdio`, and the executor path is an absolute path
whose segments hold only letters, digits, `.`, `_`, `+`, and `-`, so the
target's login shell passes it through unchanged.

The person's own configuration (destination alias, user, port, `ProxyJump`,
identity file) still applies. The SSH client runs outside the thread sandbox: it
holds no thread authority, and it must read the person's SSH configuration and
reach their agent socket. It inherits `childProcessEnvironment`'s stripped
environment.

Over that one session, host and executor exchange length-prefixed JSON frames,
each decoded against a versioned schema in `@octant/contracts` on both sides. A
frame has a bounded size, and each launched process gets its own channel with
flow control, so one noisy command cannot starve another. Requests go from host
to executor; the executor sends only replies, process output, exit status, and
connection-head questions for egress (below). The executor cannot start a turn,
ask for approval, call an app tool, or write to the journal.

The protocol (`packages/contracts/src/sshExecutorProtocol.ts`) carries the
introduction, the attestation, since slice 4 the reads of a bound root,
since slice 5 the native harness's file tools, its commands, a `cancel` for
the command in flight, and the byte streams of a proxied command's
connections, and since slice 7 a person's terminals and the creation and
removal of managed worktrees. These rules settle what the paragraph above
leaves open:

- **Framing.** A frame is a four-byte big-endian length and that many bytes of
  UTF-8 JSON, at most 1 MiB. A longer frame, a body that is not JSON, or a
  value that does not decode ends the session; a stream that lost its framing
  is never resynchronized.
- **Login-shell output.** The target's login shell can print text before the
  executor starts. The executor writes a fixed preamble before its first frame,
  and the host discards at most 64 KiB before it, unread; more refuses.
- **Introduction first.** The executor's first frame names its build, protocol,
  and whether its install verified, in a shape no protocol version changes. The
  host asks nothing of an executor whose introduction differs from this host in
  any of the three, and holds the connection as `executor-version-mismatch`; the
  policy refuses that state with the same reason. Requests run one at a time;
  a second while one runs is answered `busy`. The host writes the next request
  only after the last was answered, and a frame that does not decode, a second
  introduction, or a reply that answers no request in flight ends the session.
- **A request that is not answered ends the session.** A read the executor has
  not answered within a minute ends the session, so a late answer can never be
  read as the reply to the request after it. A reply that would exceed the
  frame bound, such as a diff of control characters whose JSON escapes outgrew
  it, is answered `too-large` instead.
- **Protocol 1 gained the reads, then the harness.** The read requests, in
  slice 5 the file tools, commands, `cancel`, and streams, and in slice 7 the
  terminal and worktree requests and terminal frames, joined protocol 1
  before any build with protocol 1 shipped, so the version did not change; the
  exact build match still refuses any executor of another build.
- **Terminals are frames with their own windows.** Opening a terminal is a
  request that answers at once (`terminal-opened`); the shell then lives
  beside the requests, so a command or a read never waits for it. This host
  names each terminal with a new, higher id; the executor refuses an id that
  is not new and a ninth open terminal. The executor sends at most 256 KiB of
  a terminal's output that this host has not granted back, in chunks of at
  most 64 KiB, and holds the shell while it waits; this host grants the room
  back once its bounded transcript took the bytes. Output past the window, or
  for a terminal this host never opened, ends the session. A shell that exits
  sends what it printed, then `terminal-exited`.
- **A command holds the session's one request.** Requests still run one at a
  time, so while a command runs (up to its ten-minute bound) the target's
  reads and other tool calls wait their turn; the host waits for a command's
  reply a minute past its timeout before it ends the session. A `cancel`
  names the request in flight and stops it, and the command then answers
  `cancelled`; a `cancel` for any other id is ignored.
- **Streams are channels with their own windows.** A proxied command's
  connections are streams beside the requests, not requests: the executor
  opens odd ids, one per connection the command makes to its forwarder, and
  this host opens even ids, one per connection its proxy asks the target to
  make (`dial`). Either side sends at most 256 KiB on a stream the other has
  not taken off it, in chunks of at most 64 KiB, and the reader grants room
  back as it reads, so a stalled connection holds a bounded amount and
  starves neither the others nor the requests. Data past the window, a
  stream id that was never opened or is reused, or a stream opened while no
  proxied command runs ends the session; frames for a stream either side
  already closed are dropped. `resolve` and `dial` are answered only while a
  proxied command runs, and every stream closes when it ends.
- **Why a session failed.** The client's own message is the only evidence of a
  refused key, so "host key verification failed" or "remote host identification
  has changed" reads as `host-key-changed`. The remote shell's 126 or 127 reads
  as `executor-missing`. The client's 255, a session killed, or no introduction
  within a minute (or no attestation within three) reads as `target-unreachable`.
  Any other exit before an introduction means the program at the executor path
  is not an executor this host can speak to, and reads as
  `executor-version-mismatch`. An exit after a matching introduction is a lost
  session and reads as `target-unreachable`.
- **When it connects.** The host connects on registration, re-pin, and an
  explicit connect, and a connection that ends is held as `target-unreachable`
  with no attestation. Reconnecting on its own, with bounded backoff, arrives
  with the remote threads the Code turn runtime starts, which give it a reason
  to; slice 5 built the tools those threads run, not the threads. Until then a
  remote-bound Project whose session was lost refuses reads
  `target-unreachable`, and the person connects again
  (`octant ssh-target connect`); nothing reconnects unasked.

**Rationale: an executor, not plain `ssh` commands.** Running each operation as
`ssh target <command>` was rejected. Each call would be a command string parsed
by the remote login shell, so every path and argument becomes a quoting and
injection surface. It could not apply Octant's confinement without shipping
profiles as shell text, could not verify a file's identity between check and
read, and would reconnect for every call. SFTP was rejected because it reads and
writes without Octant's confinement. Running a full Octant host on the remote is
federation, below.

### Executor delivery and identity

The executor is the `octant executor --stdio` command of the headless install on
the SSH target. This host refuses `executor-version-mismatch` unless the executor
reports exactly this host's build version and protocol version, and the executor
verifies its own install the way the headless server already does before it
answers. The refusal names the install command for the matching version.
Octant does not upload the executor
([decision 1](#maintainer-decisions)). The headless artifact ships the executor
as its own bundle, `lib/server/sshTarget/executorMain.mjs`, which loads none of
the server and opens no store. An executor run from a source checkout has no
install to verify and reports the development version, which only a development
host matches, so a packaged host never admits one.

The executor runs as the logged-in remote user, never root: a session whose
remote user is uid 0 is refused `remote-root-user`, because a root executor's
confined children can undo their own confinement. It creates one owner-only
runtime directory per session for scratch, temporary files, and the egress
forwarder, removes it when the session ends, and sweeps stale ones at start. It
opens no network listener: the one socket it listens on is a proxied
command's forwarder, a Unix socket in a fresh owner-only directory of its
runtime directory, open only while that command runs. A socket path longer
than the kernel takes (107 bytes) is refused and the command reports
unavailable, because Node binds a longer one cut short without a word. The
runtime directories sit under one
`octant-executor-<uid>` folder in the target's temporary directory; a folder of
that name the remote user does not own, that is a link, or that others can
enter is refused rather than used, and the canaries then report inconclusive.

### Confinement attestation and admission

On every connection, before the first request that could launch a process or
touch the remote root, the host asks the executor to attest. The executor reports
facts, and the host decides. The decision is a pure domain policy in
`packages/domain`, so the refusal rules are testable without SSH.

Facts:

1. **Executor identity.** Build and protocol version equal this host's, and the
   install verified.
2. **Platform and user.** macOS or Linux, CPU architecture, non-root uid.
3. **Backend.** `sandbox-exec` on macOS; on Linux an executable `bwrap`, working
   unprivileged user namespaces, and, for postures that need the Plan seccomp
   filter, an x64 or arm64 CPU with an executable `/bin/sh`.
4. **Canaries.** For each posture the Project can use, the executor launches a
   probe through its own `ProcessConfinementPort`, built from the same source as
   this host's, with that posture's grants. The probe tries what the posture
   forbids and must be refused each time:

| Posture                              | The probe must fail to                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Plan                                 | write inside the remote root; exec or fork after start; open a network socket                          |
| Approval-gated and auto-accept-edits | write outside the remote root; read `~/.ssh`; connect anywhere except through the executor's forwarder |
| Every wrapped posture                | read a sibling folder of the remote root, or another session's executor runtime directory              |

A posture whose canaries all fail is attested for this connection. Full access
has no wrapper to attest; it still needs facts 1 and 2 and Full access remembered
for that Project, as locally.

**Admission.** Every launch on an SSH target, and every file operation on its
remote root, is admitted only when the host holds a passing attestation for this
connection and the posture the request runs in. Otherwise it is refused before
any effect with one of these reasons, each with the recovery the person sees:

| Refusal                       | Recovery shown                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `host-key-changed`            | Confirm the new key from a local window, after checking it                          |
| `executor-missing`            | Install the headless Octant of this version on the target (command)                 |
| `executor-version-mismatch`   | Install the matching version (command)                                              |
| `remote-root-user`            | Register the target with a non-root user                                            |
| `unsupported-platform`        | None on this target; use a Linux or macOS machine                                   |
| `confinement-backend-missing` | Install bubblewrap on the target (command)                                          |
| `user-namespaces-unavailable` | Enable unprivileged user namespaces for this user on the target                     |
| `plan-filter-unavailable`     | Plan on Linux needs an x64 or arm64 CPU and an executable `/bin/sh` on the target   |
| `confinement-canary-escaped`  | Names the posture and the action that succeeded; contact the target's administrator |
| `not-attested`                | Names the posture and any probe that did not report a refusal; reconnect to attest  |
| `runtime-not-attestable`      | Choose a runtime Octant confines on remote targets (below)                          |
| `full-access-not-remembered`  | Remember Full access for this Project from a local window, or choose a narrower one |
| `target-unreachable`          | Reconnect when the target is reachable                                              |
| `target-removed`              | None for new work; the Project's threads stay readable on this host                 |

The attestation result, its facts digest, and the postures it covers are
journaled with the target (below), so a refusal can be explained later. Nothing a
failed attestation covered is retried with weaker grants.

The policy is `decideSshAdmission` in
`packages/domain/src/sshTargetAdmissionPolicy.ts`. Its input is what the host
knows at the moment of the request: its own build and protocol version, whether
the target is still registered, the connection's state, the attestation it holds,
the posture and whether Full access is remembered, and what the request would run
(a file operation, one of Octant's own launches, or a provider runtime). These
rules settle what the tables above leave open, each in the fail-closed direction:

- **Only a probe that reported a refusal passes.** A probe reports `refused`,
  `escaped`, or `inconclusive`. An inconclusive probe, a missing one, a posture
  the report does not cover, and a probe reported twice with any copy other than
  `refused` all refuse `not-attested`, because none of them shows the posture
  confines. A new reason was needed: `confinement-canary-escaped` would claim an
  escape nobody saw.
- **One escape refuses the whole connection.** Every posture launches through the
  same executor and backend, so an escape in one is not evidence Octant can
  discount in another. Any escaped probe refuses every request on that
  connection, Full access included, naming the posture and probe that escaped.
- **An attestation counts only for its own connection.** Each attestation names
  its connection; one from an earlier session, or none, refuses `not-attested`.
- **Full access** must be remembered for the Project
  (`full-access-not-remembered` otherwise, since a session-only grant is not the
  explicit choice the local rule requires) and needs facts 1 and 2, and no
  escape; it needs no backend or canaries.
- **Provider runtimes** are admitted only where Octant wraps them in the requested
  posture, the driver declares remote placement, and the runtime opens no
  loopback tool listener on the target. Octant wraps no runtime in Full access,
  so every provider runtime refuses `runtime-not-attestable` there. The native
  harness is not a runtime on the target: its tools are Octant's own launches.
- **Plan's process filter** on Linux needs an x64 or arm64 CPU and `/bin/sh`.
  Without them Plan refuses `plan-filter-unavailable`, a reason of its own
  because the bubblewrap recovery would be wrong; other postures do not need it.
- **Order.** Reasons that reconnecting cannot change come first: a removed
  target, Full access not remembered, a runtime that cannot be attested. Then the
  connection, the attestation's connection, identity, platform, user, any escape,
  the backend, and the requested posture's canaries.

**What attestation proves, and what it does not.** Every fact is the executor's
own report, because this host cannot inspect the target. Reported by an
unaltered executor, it shows that this connection's executor is the matching
Octant build and that confinement held against the canaries on that kernel,
under a non-root user. An executor altered by the remote user or root can report
anything, including a passing attestation; attestation does not detect that,
which is why altering the executor is outside the threat model below. It does not prove
anything against the remote's root or kernel, exactly as local confinement proves
nothing against this Mac's root. A remote administrator can read the remote root
and alter the executor; the person's choice of target is the trust in that
administrator. Octant says so on registration rather than calling the target
verified.

**Rationale: canaries, not presence.** Locally, a present `bwrap` is enough
because a launch that cannot get its namespaces fails closed at launch. On an
unknown remote kernel the same failure would surface mid-turn as a broken tool.
Canaries turn it into an up-front refusal with a recovery, and they also catch a
backend that starts but does not confine, which a presence check cannot.

The Linux canaries as slice 3 built them (`executorAttestation.ts`) settle these
details, each in the fail-closed direction:

- **A refusal must be the probe's own report.** Each probe is this build's
  runtime running a fixed probe program through the executor's
  `ProcessConfinementPort`. It prints a per-launch nonce and its verdict; a
  launch that fails to start, times out, or prints anything else is
  `inconclusive`.
- **A forbidden action must be possible unconfined.** Before each probe the
  executor checks, as itself, that the action would succeed without
  confinement: the folders exist and are writable, `~/.ssh` exists and can be
  listed, `/bin/sh` runs, and the SSH server's own address (from
  `SSH_CONNECTION`) accepts a connection. Otherwise the probe is `inconclusive`,
  because a refusal could not be told from an impossible action. A target
  without `~/.ssh` therefore cannot attest the writing postures.
- **The network probes dial the SSH server.** It is the one address certain to
  be listening on the target, so a probe that cannot reach it was stopped by its
  confinement, and the executor needs no listener of its own.
- **Canaries prove grants on a scratch root.** The canaries prove the posture's
  grants against a scratch root, its sibling folder, a folder outside it, and
  a stand-in for another session's runtime directory, all in the executor's
  own owner-only directory, even after Projects bind remote roots: a probe that
  escaped would otherwise write into the person's folder, and the grants have
  the same shape for every root. One attestation covers every Project on the
  connection. Probes read no file's contents back.
- **Writing postures probe through a forwarder.** Since slice 5 the writing
  postures' commands run `proxied`, so their probes run proxied too, each
  through a forwarder directory of its own (probes run at once, and a launch
  writes its forwarder's script into that directory). Nothing listens on the
  probes' sockets, so the probe that connects around the forwarder proves
  that nothing else leaves the capsule; a target whose SSH server answers on
  the forwarder's own port (3128) cannot show that and is inconclusive. The
  canaries run with the grants the launches use, so attestation follows
  whatever those grants become. On macOS, Seatbelt's `proxied` rule names a
  loopback port the executor would have to listen on, so the writing postures
  do not attest on a macOS target until slice 8 settles its forwarder.
- **No canaries as root.** A uid 0 executor launches no probe: the host refuses
  `remote-root-user` before it looks at canaries, and a root launch would only
  add risk.

### Remote-bound Projects and reads

Slice 4 binds a Code Project to a folder on a registered target and reads it.
These rules settle what binding and reading need, each in the fail-closed
direction:

- **Binding is local, and resolves the folder on the target.** Only a local
  window or the local CLI binds (`octant ssh-target bind`), through the local
  administration routes. The executor resolves the path to its canonical
  folder, and the journal records that canonical path, the target, and the
  name. A Project's binding never changes: one binding event per Project, and
  a second under the same id is refused.
- **A remote-bound Project is its own record until threads run there.** Its
  events are the `ssh-remote-project` aggregate, apart from local Projects, so
  no local Files, Git, terminal, or provider path can read a remote root as a
  folder on this Mac. The composer's Project picker lists it (slice 7) but
  does not offer it for a thread; remote threads join it to the Project list.
- **Reads outside a turn run in Plan.** Binding, listing, and reading a file
  are file operations, and Git status and diff are Octant's own launches; each
  is admitted only when this connection holds a passing Plan attestation, the
  read-only posture. The admission decision and the request are made in one
  step on the session that was admitted, so a request never travels on a
  later session. A Project on a target that never attested, whose session was
  lost, whose canary escaped, or that was removed reads nothing, and the
  refusal carries the admission reason and its recovery.
- **The executor keeps every path inside the bound root.** Paths are relative
  (the same schema local Code reads use) and are checked on both sides. The
  executor resolves each with the local containment sequence, so a symbolic
  link whose target leaves the root is refused `outside-root` on the target,
  and a listing leaves such an entry and `.git` out. A file is read from a
  handle that must be the object containment resolved. A root that now
  resolves elsewhere than where it was bound is refused `root-moved`.
- **Some folders are never a root.** `/`, and a folder that holds or sits
  inside the remote user's `~/.ssh` or the executor's runtime folder, are
  refused `root-not-confinable`. Reads are confined by containment rather than
  the sandbox, so a root that held the SSH keys would let Files read them.
  Other credential folders (`~/.aws`, `~/.config/gh`) are not listed: the home
  folder that holds them is already refused, only a local window or the local
  CLI binds, and no list of credential folders can be complete.
- **Git runs with Plan's grants and starts nothing else.** Git status and diff
  run through the executor's `ProcessConfinementPort` with Plan's grants: no
  write to the root, no process after Git itself, and no network. The
  file-system monitor, external diff drivers, text conversion, the pager, and
  submodule recursion are off, because each would start another program, and
  every path is a literal name, never pathspec magic. A clean filter the
  checkout names cannot be turned off by name; the no-process grant is what
  keeps it from running, and the loopback smoke test reads a checkout whose
  configuration names a program for each of these. Git's discovery stops at
  the bound root (`GIT_CEILING_DIRECTORIES` is its parent, `GIT_WORK_TREE` the
  root), so a root with no repository of its own reads as none rather than as
  a repository in a folder above it the person did not bind, whatever the
  confinement would let Git read.
- **Every read is bounded.** A listing is one directory level and at most
  1,000 entries; a file at most 256 KiB, sent base64-encoded; a diff at most
  256 KiB of text after decoding, since bytes that are not UTF-8 grow as they
  decode; a status at most 2,000 entries. A cut listing, diff, or status says
  it is truncated; a larger file is refused `too-large`.
- **No paired device reads a target in this slice.** The reads sit on the local
  administration routes, beside binding, until remote-bound Projects join the
  product routes with their threads.

### Native harness on a target

Slice 5 gives a remote-bound Project's Code turn its hands on the target. The
composition's `forRemoteCode` offers the tools `forCode` offers, with the file
tools and the shell acting on the target
(`apps/server/src/sshTarget/sshRemoteHarness.ts`); inference, approvals,
questions, the task list, the goal, and every authority check stay on this
host. These rules settle what the slice needs, each in the fail-closed
direction:

- **A turn's tools are bound to one session.** They are composed only when the
  target holds a session that admits file work in the turn's posture, and
  every later call names that session: a call on a target whose session ended
  refuses (`target-unavailable` for a file tool, an unavailable shell) and is
  never sent on the next session, even one that attested again. When the
  session ends the turn is told once (`onTargetDisconnected`); its runner
  interrupts it with `target-disconnected` and aborts its calls, which
  withdraws an approval or question still waiting, and the command running on
  the target died with the executor. Nothing is retried or queued.
- **Each call is admitted in the posture of that moment.** A file tool is a
  file operation and a command is one of Octant's own launches; both ask the
  admission policy with the turn's posture as it stands at the call, as a
  local thread's narrowed turn does. Plan runs no command: the harness offers
  none, the shell refuses one, and the protocol cannot name Plan for one.
- **The file tools run the local class on the target.** The executor runs the
  native harness's own file system class against the bound root, so a read,
  write, edit, glob, or grep resolves and contains every path on the target
  and returns what it returns locally. Each tool set is its own reader: an
  edit needs a read by the same thread on the same session, so a thread reads
  again after a reconnect. A result too large for a frame refuses
  `file-too-large`.
- **Commands run as local harness commands do.** `/bin/sh` runs a script the
  executor wrote in its own script directory, through the same owned-process
  port, confined with the posture's attested grants; its environment is built
  on the target. Approval-gated and auto-accept-edits commands run `proxied`,
  Full access with the writing postures' grants and the target's own network,
  as on this host; a host without egress rules runs the networked postures'
  commands offline rather than open. A reply carries the last 192 KiB of each
  output stream.
- **Egress is decided where it is journaled.** A proxied command's launch
  starts this host's own egress proxy, under the thread's and Project's rules,
  before the command runs. Each connection the command makes to its forwarder
  on the target crosses the session as a stream into that proxy, which reads
  it as a local command's: the token, the rule match, the TLS server name, the
  decision before every chunk, rule expiry and revocation, the private-address
  check, and the batched records and summary are all its own. The proxy's
  lookup and connection are asked of the target (`resolve`, `dial`), so the
  name resolves with the target's resolver and only an allowed connection is
  opened, from the target, to an address this host checked.

**Rationale: the whole connection, not only its head.** The design first had
the forwarder send only each connection's head for this host to decide.
Deciding a head is not all the proxy does: it decides again before every chunk
so an expired or revoked rule closes its tunnels, checks the TLS server name
against the name it allowed, checks every resolved address, and tallies and
journals what passed. Splitting that between two machines would have copied
the proxy's most security-sensitive code into the executor, or left those
checks out on targets. Carrying the bytes keeps one implementation and one
record; the cost is that a command's traffic crosses the SSH session twice,
which bounds its throughput by the session's.

### Terminals and managed worktrees

Slice 7 gives a person a shell on a remote-bound Project's target and
managed worktrees there (`apps/server/src/sshTarget/sshRemoteTerminalService.ts`,
`executorTerminals.ts`, `executorWorktrees.ts`), and the surfaces that reach
them: Settings › SSH targets and the composer's Project picker. These rules
settle what the slice needs, each in the fail-closed direction:

- **Only a local window or the local CLI.** Terminals and worktrees sit on
  the local administration routes beside binding, as a local Project terminal
  is local-window only: a remote-bound Project has no thread whose approvals
  could gate a paired device's shell. A terminal belongs to the window that
  opened it; another window's command on it is refused `unauthorized`.
- **A terminal is one of Octant's own launches, approval-gated.** Opening one
  asks the admission policy for an Octant launch in Ask for approvals, the
  posture a local Project terminal gets without remembered Full access, which
  a remote-bound Project cannot have yet. Plan opens no terminal. The decision
  and the opening are one step on the admitted session, and the terminal
  belongs to that session: when it ends, the shell died with the executor,
  the terminal ends `target-disconnected`, and nothing reconnects it or queues
  its input. A refusal carries the admission reason's recovery sentence
  (`describeSshAdmissionRefusal` in `packages/domain/src/sshTargetRecovery.ts`).
- **A terminal is offline.** A terminal has no thread, so no egress rules a
  proxy could decide its connections under, and a networked posture without
  rules runs offline rather than open, as harness commands do. Fetching and
  pushing from a remote terminal wait for a design that gives it rules.
- **A shell is confined as a harness command is.** The executor runs the
  remote user's login shell (`SHELL` when it is an executable absolute path,
  else `/bin/sh`) on a pseudo-terminal through its `ProcessConfinementPort`
  with the posture's attested grants and the command launches' read rules.
  Its home is an owner-only folder of the session's runtime directory, so the
  remote user's own dotfiles are not read and history ends with the session;
  its environment is built on the target. In a managed worktree, the
  repository's own `.git` is granted only through Git's reciprocal
  linked-worktree record, as for a local linked worktree. The pseudo-terminal
  module is loaded only when a terminal opens, so an executor without it
  answers everything else and reports the terminal unavailable.
- **The record says who opened which shell, never what it printed.** A
  terminal's start (Project, worktree, window, target, and connection) and
  its end (stopped, exited, `target-disconnected`, or `host-restarted`) are
  `ssh-remote-terminal` events; a restart ends every terminal still recorded
  as running as `host-restarted`. A terminal answers in a local Project
  terminal's shape, so the same terminal surface draws either.
- **A managed worktree sits beside the root, on its own branch.** Its folder
  is `<parent of root>/.octant-worktrees/<Project>/<name>` and its branch
  `octant/<name>`, from the root's checked-out commit, as a local managed
  worktree sits beside its repository. The name is lowercase letters, digits,
  and inner hyphens, so it is one folder and one branch segment. The executor
  derives the folder from the bound root itself, so this host never names a
  path to write; both folders above the worktree must be the remote user's
  own real folders, owner-only, and never links, or creation refuses
  `worktree-failed`.
- **The root must be its repository's top level.** `git worktree add` records
  the worktree in the repository's `.git`; a root inside a larger repository,
  or a root that is itself a linked worktree, keeps that record outside the
  root, where no grant reaches. Such a root refuses `not-repository-root`.
- **Git writes the worktree with the approval-gated grants, and runs no
  hook.** Creating and removing a worktree are Octant launches admitted in Ask
  for approvals, the person at a local window being the approval as for a
  terminal. Git may write the root and the Project's worktree folder and
  nothing else, with no network and `core.hooksPath=/dev/null`. Git starts
  its own subprocesses to check a worktree out, so the launch keeps the exec
  grant: a filter the checkout's configuration names can still run, inside
  the confinement an approval-gated command gets.
- **Removal keeps anything Git would keep.** Removal is Git's own `worktree
remove` without force: a worktree holding a change, an untracked file, or a
  lock is kept and refuses `worktree-dirty` or `worktree-failed`. The branch
  and its commits stay. A worktree folder the person already deleted leaves
  only Git's record, which the same `worktree remove` drops; `worktree prune`
  is never run, because it would also drop the record of every other worktree
  whose folder is missing, such as the person's own on an unmounted volume.
  Removing a target deletes no worktree on it.
- **A worktree is its Project's, and its folder is a root.** Creation and
  removal are `ssh-remote-worktree` events naming the connection whose
  executor acted; the journal keeps the canonical folder the executor
  reported. A read or a terminal in a worktree names that folder as its root,
  so every containment, `root-moved`, and `root-not-confinable` rule of a
  remote root holds there. A worktree named for another Project refuses
  `unknown-worktree`.
- **Settings › SSH targets is a desktop window's.** The page sits in
  Settings' Advanced group and reaches the local routes through the desktop's
  main process, which alone holds the bridge secret and forwards only the
  named operations to their fixed paths. It shows each target's connection,
  remote user and platform while attested, fingerprint, and what each confined
  posture admits now with the refusal's recovery; it adds, connects, re-pins,
  and removes targets, binds a folder, creates and removes worktrees, and
  opens a terminal in the root or a worktree. It shows one terminal and lists
  none, so opening another or leaving the page stops the one shown rather
  than leave a shell nothing can reach again. A key is pinned only after the
  person confirms the fingerprint in a dialog that also says what the pin and
  the attestation do not prove. Any other window shows where to do it.
- **The Project picker lists a remote-bound Project without offering it.**
  In Code, the composer's picker lists remote-bound Projects under "On SSH
  targets" with their `destination:folder`, disabled with the reason that
  threads on SSH targets are not available yet, and offers "New Project on an
  SSH target…", which opens Settings › SSH targets at binding. A thread is
  never started in a local Project in their place.

### Provider runtimes on a target

Equivalent confinement means the remote reaches the local matrix, not a stronger
one. A runtime is admitted on an SSH target only in a posture where Octant itself
wraps it, because only then can the canaries speak for it:

- **Native harness.** Admitted. Inference stays on this host with this host's
  credentials, exactly as today. Its tools (shell, file edits, tests) run through
  the executor. Harness egress decisions stay on this host: the executor's
  forwarder carries each connection over the session to this host's proxy,
  which decides it with `decideToolEgress` and journals the decision, and only
  an allowed connection is opened, from the target
  ([Native harness on a target](#native-harness-on-a-target)). A decision this
  host cannot journal refuses, as locally.
- **Runtimes Octant wraps** (ACP, OpenCode, Pi; Claude in Plan). Admitted once
  the provider-sdk process-placement seam (slice 6) exists and the driver declares
  remote support, with one condition: a runtime whose app-tool transport is a
  loopback listener on the target is refused until that listener is reviewed for
  other users on the target.
- **Runtimes on their own sandbox** (Codex in every posture, Claude outside
  Plan). Refused `runtime-not-attestable`, because Octant cannot verify that the
  runtime's own sandbox works on the target's kernel
  ([decision 2](#maintainer-decisions)).

A driver that does not declare remote support reports the capability unsupported
for remote-bound Projects. Nothing falls back to running the provider locally
against remote files.

Slice 6 built the seam in `packages/provider-sdk/src/driver.ts` and
`processPlacement.ts`, its conformance in `processPlacementConformance.ts`,
and this host's admission of a placed runtime
(`admitProviderRuntime` in `apps/server/src/sshTarget/sshTargetConnectionService.ts`).
These rules settle what the seam needs, each in the fail-closed direction:

- **The placement rides the acquisition.** `ProviderAcquireInput.placement`
  is a host-supplied remote placement; absent means this host, as every
  driver launches today. With a placement, `projectRoot` is the bound root as
  the target names it, never a folder on this host.
- **A driver declares, and the host reads only the declaration.**
  `ProviderDriver.remotePlacement` names the postures in which the runtime
  runs under Octant's confinement and how app-managed tools reach it (`stdio`,
  `loopback-listener`, or `none`). The executor wraps every placed launch, so
  the runtime counts as Octant-wrapped exactly in the postures it declares;
  Full access is not a posture it can name. A driver without the declaration,
  a posture it leaves out, and a loopback listener all refuse
  `runtime-not-attestable` before the connection is asked about.
- **An undeclared driver never sees a placement.** Every acquisition that
  carries one goes through `acquireProviderConnection`, which refuses it
  `unsupported` before the driver is called when the driver declares no
  posture, or when the mode is not Code. The Code turn runtime already
  acquires through it (`codeOperationRuntime.ts`). A driver written before the seam
  reads `projectRoot` as a folder on this host, so handed a remote root it
  would run the runtime here against a path that names something else.
- **A placed launch names a program and its arguments, nothing more.** The
  driver gives the runtime's absolute path on the target and its arguments.
  The working directory is the bound root and the environment is built on the
  target, so the seam has no field through which a folder or a credential of
  this host could cross. A placed process is its standard streams and how it
  ended (exited, or lost with its session); it stops when the scope it was
  launched in closes.
- **Conformance holds the claim.** A driver that declares nothing must be
  refused `unsupported` with nothing launched on the target or this host. A
  driver that declares placement must, in every posture it declares, run a
  turn whose runtime started only through the placement, at an absolute path;
  must fail the turn, not run here, when the target refuses the launch; and
  must stop every process it placed when its scope closes. A declaration that
  names no posture, or one twice, fails.

The executor does not yet start a runtime process, and no in-tree driver
declares placement. Starting one is its own change: a protocol request for a
long-lived confined process whose standard streams are a session stream, the
grants a runtime needs beyond a command's (its own home on the target, its
binary's folder, and the target's own account state, read-only), and the
network a placed runtime gets, which locally is open under the
provider-endpoint policy and on a target is not yet decided. A wrapped
runtime's driver (ACP, OpenCode, or Pi) then declares placement and passes
this conformance against the loopback target before the real-provider smoke.

### Credential custody

- **SSH keys.** Octant never reads, stores, or asks for an SSH private key or
  passphrase. Authentication is the system SSH client's, through the person's
  agent or key files. Agent forwarding is off for every target.
- **Provider credentials.** Never sent to an SSH target. The native harness keeps
  inference on this host. A provider runtime on a target signs in with the
  target's own account state, which the person set up there; Octant's host-driven
  sign-in does not target a remote.
- **Git and other remote credentials.** A remote checkout's fetch and push use
  the target's own Git credentials, under the thread's posture on the target.
  Octant forwards nothing for them.
- **Host secrets.** The bridge secret, broker tokens, Keychain references, and
  the host identity key never cross the session. Every executor launch builds its
  environment on the target and inherits nothing from this host's environment.

### Data placement and lifecycle

| Data                                                      | Lives                                    | Lifecycle                                                  |
| --------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| Threads, turns, approvals, tool results, egress decisions | This host's journal                      | As any Code thread                                         |
| Target registration, pinned key, attestation results      | This host's journal; pin file owner-only | The pin file is removed with the target                    |
| Connection state (connected, attesting, lost)             | This host's memory                       | Not journaled, like listener observation                   |
| Remote root, managed worktrees                            | The target                               | The person's files; Octant never deletes them on removal   |
| Executor runtime directory                                | The target, owner-only                   | Removed at session end; stale ones swept at the next start |
| A provider runtime's own session files                    | The target, in that runtime's own home   | Provider-owned, as locally                                 |

Every event about remote work is appended by this host, under the thread's actor,
with the target's id as provenance. The executor holds no journal, projection, or
database. Target address, remote user, and remote paths are personal data and are
handled as a local Project root path is in diagnostics and export.

These rules settle how slice 4 records targets, each in the fail-closed
direction:

- **The journal is the record; the pin file is a copy.** Registration,
  re-pin, attestation, and removal are `ssh-target` events. The client reads
  keys only from a file, so each connection first writes the target's
  owner-only pin file from the journaled key; an edited or stale file never
  decides which key a session trusts. Removal deletes the pin file, and a
  removed target's bound Projects keep their records and refuse new work
  `target-removed`. Slice 3's file registry never shipped, so nothing imports
  it.
- **An attestation is journaled as a digest and decisions.** Each connection's
  attestation is recorded as the SHA-256 of its facts as their schema encodes
  them, the connection, and the decision for each confined posture. The
  journaled result explains a refusal later and never admits anything.
- **Diagnostics, export, and the data map name no target.** The data map lists
  the pin folder and SSH target connections as outbound traffic. Diagnostics
  show only how many target and binding events the journal holds. The host
  export carries each target as its registration time, bound Project ids, and
  last attestation's digest and decisions, without destination, host key, or
  executor path, and each remote-bound Project as a Project's identity without
  its folder. It carries no managed worktree or remote terminal: a
  worktree's record is its folder on the target, and a terminal's is a window
  and a session, none of which leaves this host.

Removing a target is local-only, refuses while a thread in one of its Projects is
running, and removes the registration and pin. Its Projects' threads stay
readable on this host, and new work in them refuses `target-removed`.

### Disconnect, reconnect, and restart

This host owns the connection and every process on the target.

- **The executor dies with its session.** It exits when its standard input
  closes, and every process it launched exits with it (Bubblewrap's die-with-parent
  on Linux, the process group on macOS). Nothing keeps running on the target
  unseen.
- **A lost connection ends work honestly.** Running turns stop as interrupted
  with the reason `target-disconnected`; pending approvals and questions are
  withdrawn; nothing is queued for later delivery. The thread shows the
  interruption, and the person resumes it.
- **Reconnect is the host's.** The service reconnects with bounded backoff while a
  remote-bound Project is open or has a thread waiting to resume, and re-attests
  before admitting anything. A new attestation never inherits the last one.
- **Resume.** A provider session with a resume cursor resumes when the runtime's
  own session files survived on the target; otherwise the host rebuilds history in
  a fresh session, as for any host-owned resume.
- **Host restart** is a disconnect: recovery marks in-flight remote turns
  interrupted from the journal.

## Different from a paired host and from a hosted relay

|                    | SSH target                                      | Paired Octant host (federation)                              | Hosted relay                      |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------ | --------------------------------- |
| What runs remotely | The executor, only while this host is connected | A full Octant server, always                                 | Nothing of the person's           |
| Authority          | This host only; the executor holds none         | Each host is its own authority; hosts never trust each other | None; ciphertext only             |
| Journal            | This host's                                     | Each host its own; clients merge reads                       | None                              |
| Threads appear     | In this host's sidebar, as local threads        | Under the remote host, in all-hosts views                    | Not applicable                    |
| Credentials        | Stay on this host; target uses its own          | Each host's own                                              | None                              |
| Network path       | The person's SSH reach, outbound from this host | HTTPS listener on the remote, paired device keys             | An Octant-operated service        |
| Remote needs       | SSH login, the headless install, confinement    | Listener, certificate, pairing                               | Not applicable                    |
| Status             | This design, accepted 2026-10-26                | Built, under 0059                                            | Not in scope; no evidence of need |

Choose a paired host when the other machine should own its threads, keep working
while this Mac sleeps, or be reached from a phone. Choose an SSH target when the
code and toolchain live elsewhere but the thread, its record, and its credentials
should stay here. An SSH target is never reachable by another Octant host or a
paired device except through this host, and it creates no network listener a
relay could front.

## Threat model

| Threat                                                       | Holds because                                                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| A man in the middle presents another server                  | Only Octant's pinned key is accepted; a change refuses until confirmed locally                                   |
| The target uses the person's SSH identity elsewhere          | Agent forwarding is always off; no key or passphrase reaches Octant                                              |
| The target opens a path into this Mac                        | All forwardings cleared; the executor has no channel except replies on its session                               |
| Remote output tries to act as authority                      | Frames are schema-decoded data; the executor cannot start turns, approve, call tools, or journal                 |
| Workspace content injects instructions                       | Same as a local Project: tool results are data with provenance, every tool call passes host policy               |
| A path or argument escapes into a remote shell               | The remote command is a fixed absolute path; every path and argument travels as frame data                       |
| A file is swapped between check and read                     | The executor opens a handle and verifies identity, as local confined reads do                                    |
| Confinement silently missing on the target                   | Canaries per posture before admission; any escape refuses                                                        |
| An older or altered executor                                 | Exact version match and install verification; altering it needs the remote user's or root's access, out of scope |
| Another user on the target reaches the executor or its tools | No network listener; runtime directory and forwarder owner-only; loopback tool transports refused until reviewed |
| Provider or host credentials leak to the target              | None are sent; inference for the native harness stays on this host                                               |
| Work continues unseen after a disconnect                     | Executor and children die with the session; turns stop as interrupted; nothing is queued                         |
| The remote's root or kernel is hostile                       | Not defended, as on this Mac; registration says the target's administrator is trusted with the remote root       |
| A remote device gains a new path through a target            | Targets are administered only locally; a device acts under the Project's existing authority                      |

## Maintainer decisions

The maintainer accepted these on 2026-10-26. Each states the rule; the
alternatives considered and the reason for the choice follow it.

1. **Executor delivery.** The person installs the headless Octant of the
   matching version on the target, and Octant prints the command. This reuses
   the existing headless artifact, adds no Linux payload to the macOS app, and
   keeps Octant from installing software on someone else's machine unasked.
   Deferred: Octant uploading its own executor bundle over the session into a
   versioned directory and checking its digest; it can follow without changing
   the protocol.
2. **Runtimes on their own sandbox** (Codex, Claude outside Plan). Refused on
   targets until a runtime-specific attestation exists. This is the only option
   that satisfies "refuses when confinement cannot be proven equivalent".
   Rejected: accepting the runtime's own readiness report, which proves nothing
   Octant checked; and wrapping them in Octant's sandbox on targets only, which
   risks breaking their sign-in and tools.
3. **Agent forwarding.** Never. A Git push from the target uses the target's
   own credentials. Rejected: a per-target opt-in with a warning. A brokered
   push from this host, if wanted, is its own design.
4. **Provider credentials on a target.** Never sent. Rejected: an API key
   injected per launch over the session, which puts the key in reach of the
   target's administrator and of any process that escapes.
5. **Disconnect behavior.** The executor and its processes die with the
   session, so work never runs unseen. Rejected for now: surviving a bounded
   grace period for reattachment, which needs its own reattachment
   authentication and is a later change if dogfood asks for it.
6. **SSH configuration.** Octant honors the person's SSH configuration with
   Octant's overrides above, so aliases, jump hosts, and hardware keys work as
   the person set them up. Rejected: an Octant-written configuration only.
7. **Version skew.** The executor must match this host's build exactly.
   Rejected until the protocol has a second version: a compatible protocol
   range.
8. **Remote preview ports.** Out of scope for the first delivery: the agent
   Browser reaches the target's dev servers only at addresses this Mac can
   already open. Deferred: forwarding chosen ports through an authenticated host
   proxy.

## Delivery plan

Each slice is one reviewable change with its own evidence. "Container" means an
agent can implement and verify it in a Linux container with OpenSSH installed and
`sshd` on loopback as the target; no account, hardware, or maintainer action.

1. **This specification.** Accepted by the maintainer on 2026-10-26 with every
   decision above as written. Docs checks only.
2. **Admission policy and contracts.** Container. SSH target, attestation facts,
   and the admission decision as contracts and a pure domain policy. Accepted when
   focused domain tests show admission refuses for every unproven fact and
   posture in the tables above, admits only with a passing attestation for the
   requested posture, and refuses Full access unless remembered. This slice proves
   the issue's acceptance criterion at the policy level. Built 2026-10-26; its
   evidence is `sshTargetAdmissionPolicy.test.ts` and `sshTarget.test.ts`.
3. **Executor, transport, and attestation.** Container. `octant executor --stdio`,
   framed protocol, the host connection service with the fixed SSH options, pin
   confirmation from a local window and the CLI, and Linux canaries. Accepted when
   an end-to-end test against loopback `sshd` attests and refuses with the named
   reason for each of: missing `bwrap`, a fake confinement whose canary escapes,
   a changed host key, a version mismatch, and a root login; a test asserts the
   SSH argument list; registration from a paired device is refused. Verification
   includes server route negatives and `git diff --check`. Built 2026-10-26; its
   evidence is `sshTargetLoopback.smoke.test.ts` (the system client, a loopback
   `sshd`, and the bundled executor; it runs as root on Linux with OpenSSH server
   and bubblewrap installed, and skips elsewhere), `sshClientArguments.test.ts`,
   `sshTargetAdministrationRoutes.test.ts`, and
   `sshTargetConnectionService.test.ts`, which covers the host side against a
   stand-in client wherever `sshd` is absent.
4. **Remote-bound Code Projects and reads.** Container. Bind a remote root
   (local-only), Files, Git status, and diff through the executor, each admitted
   by slice 2's policy. Accepted when a Project on an unattested target refuses
   creation and reads, and an attested one lists files and Git status from the
   target. Journal replay test for target and binding events. Built 2026-10-26;
   its evidence is `sshTargetLoopback.smoke.test.ts` (binding through a link,
   files, a file, Git status, and diff read from the loopback target, a link
   out of the root refused, and binding and reads refused after the session
   ends, after removal, and on a target whose canary escaped),
   `sshTargetConnectionService.test.ts` (the same admission against a stand-in
   client, with no read frame sent when refused), `executorReads.test.ts`,
   `sshTargetStore.test.ts` (journal replay of target and binding events, the
   pin written from the journal, and export and diagnostics without target
   details), and `sshTargetAdministrationRoutes.test.ts`. The projection
   tables are migration 86.
5. **Native harness on a target.** Container. Harness shell, edits, and tests run
   through the executor with approvals; egress heads decided and journaled on this
   host; disconnect interrupts the turn with `target-disconnected` and queues
   nothing. Accepted by a harness turn against loopback `sshd` with a local model
   stub, plus the disconnect test. Built 2026-10-26 as the remote tool set and
   the executor's side of it; the Code turn runtime composing it for a thread,
   thread creation in a remote-bound Project, reconnecting on its own, and
   restart recovery of remote turns remain (see the delivery state). Its
   evidence is `sshTargetLoopback.smoke.test.ts` (a native harness turn over a
   model stub that reads, edits, tests, and fetches on the loopback target with
   approvals, its allowed and refused destinations decided and journaled on this
   host, Plan offering no write or command, and the disconnect test: a command
   killed with its session, an approval withdrawn, the turn interrupted, and
   nothing run on the next session), `sshTargetConnectionService.test.ts` (a
   turn's tools bound to their session, told once when it ends, and sending
   nothing on the next), `executorStreams.test.ts`, `executorSession.test.ts`,
   `executorReads.test.ts` (Git discovery fenced at the bound root), and
   `sshExecutorProtocol.test.ts`.
6. **Provider-sdk process placement.** Container for the seam and conformance
   tests; real-provider smoke needs provider sign-in on a target (maintainer).
   Extend `ProviderAcquireInput` with a host-supplied placement that drivers
   declare support for; drivers without it report remote unsupported. Accepted by
   provider-sdk conformance and one wrapped runtime launched on a target. Built
   2026-10-26 in part: the seam, its conformance, and admission from a driver's
   declaration. Its evidence is `processPlacementConformance.test.ts` (a driver
   that places its runtime passes; one that runs here, in any declared
   posture, falls back here on a refusal, leaks a placed process, or declares
   no posture fails; an undeclared driver and a Chat or Work acquisition are
   refused before anything launches), `acpConformance.test.ts` (each ACP profile reports placement
   unsupported and launches nothing), and `sshTargetConnectionService.test.ts`
   (a placed runtime admitted only in a declared posture, and refused
   `runtime-not-attestable` for no declaration, an undeclared posture, Full
   access, or a loopback tool listener). Launching a wrapped runtime on a
   target remains, as the executor's own change before a driver declares
   placement; see
   [Provider runtimes on a target](#provider-runtimes-on-a-target).
7. **Terminals, managed worktrees, and Settings.** Container for behavior and
   rendered QA in a browser; desktop packaged smoke needs a Mac (maintainer).
   Remote terminals and worktrees under the same admission, the SSH targets
   Settings page and Project picker per `DESIGN.md`, and the user guide.
   Built 2026-10-27 ([Terminals and managed worktrees](#terminals-and-managed-worktrees));
   the packaged desktop smoke on a Mac remains. Its evidence is
   `sshTargetLoopback.smoke.test.ts` (on the loopback target, a managed
   worktree created beside the root with no hook run, its Git status read, a
   confined shell in it that commits there and cannot write beside it, a
   worktree holding an untracked file kept and a clean one removed with its
   branch, a shell and what it started killed with its session and recorded
   `target-disconnected`, and a target whose canary escaped opening no
   terminal and making no worktree), `sshTargetConnectionService.test.ts`
   (terminals and worktrees only where the approval-gated posture attested,
   refused before any frame elsewhere, and a terminal ended with its
   session), `executorTerminals.test.ts` (the output window, the shell held
   while it waits, the exit after the last output, the terminal limit and new
   ids), `sshTargetStore.test.ts` (journal replay of worktrees and terminals,
   each terminal ended once), `sshTargetAdministrationRoutes.test.ts`,
   `sshExecutorProtocol.test.ts`, `sshTargetCommand.test.ts`,
   `sshTargetControls.test.ts` (desktop), and the web
   `SshTargetsSettingsSection.test.tsx` and `ComposerProjectSelector.test.tsx`.
   The projection tables are migration 87.
8. **macOS targets.** Needs a second Mac reachable by SSH (maintainer). Seatbelt
   canaries and the same end-to-end evidence as slice 3 against a macOS target.

## Verification

Prose alone needs no test. Each slice's verification is listed with it. The
policy (slice 2) and the canary refusals (slice 3) are the evidence for the
acceptance criterion; a remote that is merely reachable proves nothing.
