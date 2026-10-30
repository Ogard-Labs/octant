# Remote SSH environments

This topic specification owns how a Code thread runs on a machine the host
reaches over SSH: what an SSH target is, how the host connects to it, how it
proves its confinement before any work is admitted, what happens when the
connection drops, where the record of that work lives, and how this differs from
a paired Octant host and from a hosted relay. Architecture owns the boundaries it
builds on: [modes and checkout binding](../architecture.md#modes-chat-work-and-code),
[persistence](../architecture.md#persistence), and
[security and authority](../architecture.md#security-and-authority).

**Withdrawn 2026-10-29 (maintainer decision): out of scope.** An agent that
needs another machine uses its own provider tools, and Octant on a person's
other computers joins a hub. The entry points are removed: Settings › SSH
targets, the remote Projects sidebar group, the composer and Project selector
offers, the desktop bridge, and the `octant ssh-target` and `octant executor`
commands. The runtime, its seams, and its stored data are removed next; until
then the server code below stays but nothing reaches it. The rest of this
document describes the feature as it was built.

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
file tools, and streams. Since 5b a Code thread can be created in a
remote-bound Project through the Code commands, and the Code turn runtime
composes that tool set for a native-harness thread there, and since 6d's
prerequisites a placed ACP agent's thread, refusing every other provider
before anything launches
([Remote-bound Code threads](#remote-bound-code-threads),
`apps/server/src/sshTarget/sshRemoteCodeThreads.ts`). A local desktop window
lists remote-bound Projects in the Code sidebar and the composer, binds to
one, and starts and uses its threads
([In a local window](#in-a-local-window)); a paired device reaches them
under the Project's authority. A restart interrupts a remote turn it cut
off as `target-disconnected`, and a target is not removed while a thread on
it holds a turn. When an attested session drops, the host reconnects on its
own with bounded backoff and re-attests
([Disconnect, reconnect, and restart](#disconnect-reconnect-and-restart)).
Slice 6 is built in part:
the provider-sdk process-placement seam, its conformance harness, and this
host's admission of a placed runtime from its driver's declaration
([Provider runtimes on a target](#provider-runtimes-on-a-target)), and
since 6b the executor's runtime launches
([Runtime placement](#runtime-placement), accepted 2026-10-27): a confined
runtime process beside the request slot on a stream of its own, its home,
binary, and account-state checks, the runtime canaries, and its egress
through a proxy of its own on this host, journaled
(`apps/server/src/sshTarget/executorProcesses.ts`,
`executorRuntimeGrants.ts`, `providerRuntimeEgress.ts`). Since 6c the ACP
driver declares placement for a profile whose whole launch can be stated on
a target, starts its agent only through the placement at the path the
person set for that provider instance on the target, and runs its client
file and terminal requests through the executor
(`apps/server/src/providers/acpPlacement.ts`, `createRemoteCodeAcpClientTools`
in `apps/server/src/code/codeAcpClientTools.ts`,
[As built in 6c](#as-built-in-6c)). Since 6d's prerequisites a placed
launch also carries the profile's fixed variables and the Project entries
it denies, GitHub Copilot's profile is placed, and the Code turn runtime
starts a remote-bound thread's ACP agent through the placement
([Before 6d](#before-6d)), which a local window's composer offers where
the target's status lists the agent placeable and the person set its path
there; the real-provider smoke (6d) is next. Slice 7 is
built: a person's terminals and managed worktrees on a remote-bound Project,
under the same admission
([Terminals and managed worktrees](#terminals-and-managed-worktrees)),
Settings › SSH targets, and the Project picker's listing; its packaged
desktop smoke on a Mac remains. Slice 8 is built: a macOS target attests
every confined posture through Seatbelt, its proxied launches reaching this
host's proxy through a per-launch loopback forwarder that admits only that
launch's egress token (maintainer decision 9,
[macOS targets](#macos-targets)); the run against a second Mac is the
maintainer's. Remote SSH
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
`EscapeChar=none` keeps frame bytes from controlling the client;
`LogLevel=ERROR` keeps a configured `LogLevel QUIET` from silencing the lines
that tell a changed key or a refused sign-in from an unreachable host
([Why a session failed](#transport)); and `ServerAliveInterval=15` with `ServerAliveCountMax=3` turns a silent session
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
- **Protocol 2 placed processes.** `start-process`, `stop-process`,
  `process-started`, `process-ended`, and the launch a forwarded connection
  names joined as protocol 2 ([Runtime placement](#runtime-placement), R1).
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
- **Streams are channels with their own windows.** A proxied launch's
  connections are streams beside the requests, not requests: the executor
  opens odd ids, one per connection the launch makes to its forwarder, each
  naming that launch's request id, and this host opens even ids, one per
  connection its proxy asks the target to make (`dial`) and one per process
  it places. Either side sends at most 256 KiB on a stream the other has
  not taken off it, in chunks of at most 64 KiB, and the reader grants room
  back as it reads, so a stalled connection holds a bounded amount and
  starves neither the others nor the requests. Data past the window, a
  stream id that was never opened or is reused, or a stream that names no
  running launch ends the session; frames for a stream either side
  already closed are dropped. `resolve` and `dial` are answered only while a
  proxied launch runs; a launch's forwarded streams close when it ends, and
  the dialed ones when no proxied launch is left.
- **Why a session failed.** The client's own message is the only evidence of a
  refused key, so "host key verification failed" or "remote host identification
  has changed" reads as `host-key-changed`. Under `BatchMode` a key or agent
  that no longer signs in is the client's "Permission denied (…)" and 255,
  which reads as `authentication-refused`; the remote shell's own permission
  error exits 126 instead. Both lines print at `LogLevel=ERROR`, which the
  client is always given: under a configured `LogLevel QUIET` neither printed,
  so a changed key read as unreachable and was retried as one, which the
  loopback smoke, whose client configuration is quiet, now refuses. The remote shell's 126 or 127 reads
  as `executor-missing`. Any other 255 from the client, a session killed, or no introduction
  within a minute (or no attestation within three) reads as `target-unreachable`.
  Any other exit before an introduction means the program at the executor path
  is not an executor this host can speak to, and reads as
  `executor-version-mismatch`. An exit after a matching introduction is a lost
  session and reads as `target-unreachable`.
- **When it connects.** The host connects on registration, re-pin, and an
  explicit connect, and a connection that ends takes its attestation with it.
  An attested session that drops is reconnected by the host on its own, with
  bounded backoff, under the rules in
  [Disconnect, reconnect, and restart](#disconnect-reconnect-and-restart);
  a connection that never attested, and one this host ended itself (a
  connect, re-pin, removal, or shutdown), is not.

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
opens no network listener: the only sockets it listens on are proxied
launches' forwarders, one per command or placed runtime, each a Unix socket in
a fresh owner-only directory of its runtime directory, open only while that
launch runs. A socket path longer
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
| `target-reconnecting`         | None needed: names the attempt and when the next starts; connect to try at once     |
| `authentication-refused`      | Make `ssh` to the target sign in without a prompt from this Mac, then connect       |
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
  loopback port, so each proxied probe there gets a loopback forwarder of its
  own, as a proxied launch does ([macOS targets](#macos-targets)); it admits
  a token no probe holds, so a probe that reached it would still get nowhere.
- **macOS probes read as the launches do.** Seatbelt denies by default and
  grants reads by path, where Bubblewrap mounts the system and binds the
  executable, so a probe given only its own folder died before it could
  report, and every probe on a macOS target was `inconclusive`. Each command
  probe now carries the launches' broad read under the profile's denials
  (`allowFileReadStar`, which Bubblewrap ignores) and, on macOS, its
  runtime's folder beside the home denial, as a launch carries its binary's
  folder. Measured on this Mac's Seatbelt (macOS 27): every Plan probe then
  reports `refused`, and one run with Plan's write, exec, fork, and network
  granted reports each of those `escaped`.
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
- **A remote-bound Project is its own record.** Its events are the
  `ssh-remote-project` aggregate, apart from local Projects, so no local
  Files, Git, terminal, or provider path can read a remote root as a folder
  on this Mac. Its threads are ordinary Code threads on a `remote-root`
  checkout ([Remote-bound Code threads](#remote-bound-code-threads)), which
  a local window starts from the composer
  ([In a local window](#in-a-local-window)).
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
- **No paired device reads a target's Files or Git.** The reads sit on the
  local administration routes, beside binding. A paired device reaches a
  remote-bound Project only through its threads' turns
  ([Remote-bound Code threads](#remote-bound-code-threads)).

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

### Remote-bound Code threads

Since 5b a remote-bound Project holds Code threads, and the Code turn
runtime (`apps/server/src/code/codeOperationRuntime.ts`) runs their turns
with the tool set above (`apps/server/src/sshTarget/sshRemoteCodeThreads.ts`),
or, since 6d's prerequisites, with a placed ACP agent's client tools over
the same hands.
These rules settle what the step needs, each in the fail-closed direction:

- **A remote thread is an ordinary Code thread on a `remote-root` checkout.**
  It lives on this host's journal as any Code thread and is created through
  the same Code commands (`prepare-code-project-checkout`, then
  `create-code-thread`). Its checkout is the `remote-root` kind of
  `CodeCheckoutIdentity`, with no head, and its binding revision, repository,
  and checkout ids are digests of the Project's binding (Project, target,
  and canonical root), so a thread created against one binding never names
  another. No local root authority resolves it, because none knows the
  Project: a local Files, Git, terminal, test, or checkpoint path reaches
  nothing.
- **Only turns run.** A remote thread's start, answers, and cancel run; every
  other Code operation (terminals, tests, Git, files, pull requests) is
  refused `unavailable` before any root is resolved. A turn takes no
  checkpoint and records no changed files, and no Git process of this host
  observes the path, which on a target names nothing here (and on a loopback
  target would name the very folder).
- **The remote tool set is the turn's whole tool set.** For a placed ACP
  agent that set is its client file and terminal tools over the same remote
  hands (`remoteHandsForCode` in
  `apps/server/src/harness/nativeHarnessComposition.ts`); the agent's own
  tools are its own. Browser, Computer,
  Canvas, Apple and Android tools, repository tests and Git through the Code
  service, language tools, delegation, and extensions' tools each read or act
  on this host, so none joins a remote turn. A send that selects Browser or
  Computer is refused, and a remote thread cannot start from a fork, whose
  session seeding acts here. Nor is a remote thread forked: a fork starts
  from files this host's Git captures, so its fork point is refused
  `unavailable` before any capture.
- **The native harness or a placed ACP agent runs, checked before anything
  launches.** A turn whose provider is not the native harness is refused
  before its runtime is acquired when its driver declares no placement in
  the turn's posture (admission's `runtime-not-attestable` and its
  recovery), when it declares one but is not an ACP agent (the client tools
  admit a write or a terminal without asking, and only an ACP agent asks the
  person first through its own permission requests), or when the person has
  set no runtime path for the provider instance on that target (with the
  `octant ssh-target runtime` sentence). Otherwise the turn binds the
  agent's client tools to the target's session and takes a placement on
  that same session, in the thread's posture, at that path; the turn
  acquires its provider with that placement and no other, so the agent
  starts only on the target. Nothing runs on this host against the remote
  path instead. A remote-bound Project has no provider policy of its own, so
  this check is its policy.
- **No Full access yet, and no Auto-accept edits.** Full access on a target
  must be remembered for the Project, and a remote-bound Project has nowhere
  to remember it, so a thread is not created holding it, even for this
  session; Auto-accept edits would write with no checkpoint to return to
  ([rationale](#in-a-local-window)). The host refuses either posture when a
  thread is created, when its access is raised, and at turn time. A start,
  or an answer that continues a turn, that would run in either posture is
  refused `unauthorized` before anything binds to the target or is
  journaled, with the same sentence telling the person to choose a narrower
  posture. That posture is the thread's as the asking window holds it, its
  session grant included, narrowed by the turn's own request; a retried
  start is narrowed by the posture its durable start recorded instead, since
  that is the one it runs in. A thread created before the create-time rule
  can still hold Auto-accept edits; its turns run only when they ask for Ask
  for approvals or Plan, and a turn's closing decision is not offered on it,
  because answering one starts a turn in the thread's own posture. Lowering
  the thread's access lets any of these run. Admission's
  `full-access-not-remembered` stays the target's own refusal behind this
  one.
- **Project authority is a local Project's.** A local window reaches a
  remote-bound Project's threads only while its workspace names that Project,
  and a paired device under the Project's authority, as for a local Project.
  A paired device cannot add a target, bind a root, or read the root's Files
  or Git, which stay on the local administration routes. The harness's
  authority over a call is the thread's binding (the derived root and
  checkout), and each call still asks the target's admission.
- **A lost session stops the turn.** When the session the turn's tools are
  bound to ends, the runtime stops the turn as interrupted with
  `target-disconnected`, aborting its calls; a session lost before the turn
  is taken on refuses the start. A new turn binds only to a session that
  attested anew; while the host reconnects one is refused
  `target-reconnecting` before anything launches, naming the attempt.
- **A connector or plugin is refused, not dropped.** Its tools run on this
  host, so a send that selects one on a remote thread is refused before any
  extension is resolved or started, and no pinned extension starts for a
  remote turn.
- **A restart interrupts a remote turn.** A restart ends every session, so
  restart reconciliation (`reconcileCodeRestart` in
  `apps/server/src/persistence/codeProjection.ts`) marks a remote-bound
  thread's running or waiting provider turn interrupted with
  `target-disconnected`, where a local one is left waiting for a resume. A
  restart starts every target at `not-connected` and starts no reconnect, so
  the next turn binds only to a session the person connected and that
  attested anew.
- **A restart withdraws what the turn waited on.** A native-harness
  approval or question a remote thread's lead left pending is settled
  `expired` and journaled when the harness session store replays at
  start-up, the step that already settles a subagent's parked requests
  (`NativeHarnessSessionStore`, told which threads run on a target by their
  remote-root checkout). An answer that comes later is refused
  `withdrawn` ("withdrawn before anyone answered it", never "already
  decided"), so nothing is decided against the interrupted turn, and
  a second start finds nothing left to settle. A local thread's lead
  approval still waits for the person's resume, which settles it.
- **A remote thread's session is not compacted.** Its runtime starts on the
  target only through the placement a turn binds on the target's session,
  and a compaction binds none, so a compaction of a remote-bound thread is
  refused `runs-on-ssh-target` before anything is journaled or reserved, and
  the Code runtime's compaction session opens nothing for a remote root
  rather than hand out the target's path with no placement. The context
  popover says so in place of the button. Rejected for now: compacting
  through a turn's placement, which would bind the target's session for a
  request that runs no tool.
- **A target in use is not removed.** Removal ends the target's session, so
  the administration route refuses it `target-in-use` while a thread on one
  of the target's Projects holds a turn (prepared, running, or waiting on
  the person), checked in the same step as the removal.
- **Not built.** Compacting a remote thread's session; observing a remote
  thread's delivery target, so nothing marks one Done from Git evidence; and
  listing remote threads in the sidebar's activity and status arrangements,
  which show the Project tree's local Projects only.

#### In a local window

A desktop window reads its remote-bound Projects and their targets' status
through its main process (the local administration routes), every five
seconds while it has any and every thirty while it has none, and every
surface below shows only what that read and the Code bootstrap report. The
host binds the window, creates the thread, and admits each turn and call
itself; the window grants nothing. These rules settle what the step needs,
each in the fail-closed direction:

- **A window binds with no folder of this host.** The shell service reads
  remote-bound Projects from the SSH target store. A Code draft that names
  one binds the window's Code context to it with `boundRoot` null, so Files,
  Browser, and every other root-backed surface fail closed, and the binding
  survives bootstrap. A remote thread opens only its own view (`code-overview`):
  its terminal, Git, test, file, pull-request, Apple, and Browser tabs do not
  resolve, and a Project tab stays local-only, since the Project overview
  reads the local catalog.
- **The sidebar lists them apart.** In Code, the sidebar shows "On SSH
  targets" under the local Projects: each Project's name, its
  `destination:folder`, whether its target is connected, and its threads.
  Choosing a Project opens a new thread's composer in it, which is the
  binding; its threads are no longer listed as unfiled.
- **The composer offers only what the host runs.** The Project picker
  offers remote-bound Projects under "On SSH targets". For one, the
  composer names the folder on the target and offers the bound folder only
  (no branch, worktree, or Start from origin); Plan and Ask for approvals
  only, with nothing remembered for the Project; the native harness's
  models, and a placed agent's where the target's status offers it
  ([Before 6d](#before-6d)), with every other
  provider listed unavailable with the reason; and no Browser, Computer, or
  connector, each shown blocked if typed. It offers no Start while the
  host's status of the target refuses the chosen posture
  (`remoteCodeTurnReadiness` in `packages/domain/src/sshTargetRecovery.ts`
  reads the connection and the admission the host reported), or, for a
  placed agent, refuses that agent's runtime in it
  (`remotePlacedAgentReadiness`), and says why.
  The thread is created through `prepare-code-project-checkout` and
  `create-code-thread` on the `remote-root` checkout; the planner refuses a
  managed worktree there.
- **The thread view keeps only the turn.** A remote thread names
  `destination:folder` where a local one names its branch, and offers no
  fork, merge-back, checkpoint, rewind, restore, `@` path mention, scaffold,
  workspace preset, changed-files count, or pull request. Raising its access
  stops at Ask for approvals. While the host reports its target unable to take
  the next turn's posture, the thread says why and offers no send until the
  host reports it back. Its other tabs say the operation is not available on
  an SSH target (the host's own refusal sentence), and the dock keeps only
  Side Chat, Document, Canvas, Plan, and Agents. The board names its
  checkout "On an SSH target".
- **A window that cannot read SSH targets decides nothing.** Only a desktop
  window reads them. Any other window lists no remote-bound Project and gates
  no send on a target's status; the host refuses what it must.

**Rationale: Ask for approvals, not Auto-accept edits.** Admission would
admit Auto-accept edits on a target that attests it, but a remote turn takes
no checkpoint, so an edit accepted without review has no way back on the
target. The window offers Plan and Ask for approvals, and each write there is
approved. The host enforces the same rule: `create-code-thread` on a
`remote-root` checkout refuses Auto-accept edits and Full access, and
`change-code-thread-access` on such a thread refuses raising it to either,
before any approval is consulted, and a turn, or an answer that continues
one, in either posture is refused before anything binds to the target
(`remoteCodeThreadPostureRefusal` in
`packages/domain/src/sshTargetRecovery.ts`, applied in
`apps/server/src/code/codeService.ts` and
`apps/server/src/code/codeOperationService.ts`).

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
- **The Project picker lists remote-bound Projects.** In Code, the
  composer's picker lists them under "On SSH targets" with their
  `destination:folder` and offers them for a thread
  ([In a local window](#in-a-local-window)), and offers "New Project on an
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
- **The placement names the runtime.** `ProviderRemoteProcessPlacement.executable`
  is the path the person set for the provider instance on that target
  (R2); a driver launches exactly it, the host refuses a launch of any other
  path, and conformance fails a driver that names one of its own.
- **A placed launch names a program and its arguments, and what its profile
  fixes.** The driver gives the runtime's absolute path on the target, its
  arguments, its home-relative account state, variables set to the driver's
  own constants (a value holds no `/`, and no name the target sets itself,
  the loader's, the proxy's, Octant's, or an account-state path's), and the
  bound root's entries the runtime may neither read nor write. The working
  directory is the bound root and the environment is built on the target, so
  the seam has no field through which a folder of this host could cross, and
  none is for a credential. A driver asks `placedLaunchExpressible`
  (`packages/provider-sdk/src/processPlacement.ts`) whether a target accepts
  what it would declare. A placed process is its standard streams and how it
  ended (exited, or lost with its session); it stops when the scope it was
  launched in closes.
- **Conformance holds the claim.** A driver that declares nothing must be
  refused `unsupported` with nothing launched on the target or this host. A
  driver that declares placement must, in every posture it declares, run a
  turn whose runtime started only through the placement, at an absolute path;
  must fail the turn, not run here, when the target refuses the launch; and
  must stop every process it placed when its scope closes. A declaration that
  names no posture, or one twice, fails.

Since 6b the executor starts a runtime process: a protocol request for a
long-lived confined process whose standard streams are a session stream, the
grants a runtime needs beyond a command's (its own home on the target, its
binary's folder, and the target's own account state), and the network a
placed runtime gets, all settled under [Runtime placement](#runtime-placement).
A driver reaches it through the placement this host hands it
(`placement` in `apps/server/src/sshTarget/sshTargetConnectionService.ts`).
Since 6c the ACP driver declares it for a profile that can be placed, and an
ACP profile backed by a fixture agent passes this conformance against the
loopback target in every posture it declares
([As built in 6c](#as-built-in-6c)); the real-provider smoke follows.

### Runtime placement

**Status: accepted by the maintainer on 2026-10-27, with every decision as
recommended; 6b (the executor's runtime launches) is built.** This section
answers the three choices slice 6 left open. Each **Decision** names its rule
and the rejected alternatives; the rest follows from rules above. The rules
6b settled on the way close the section, under
[As built in 6b](#as-built-in-6b).

#### R1. A placed process beside the request slot

**Decision R1: a `start-process` request
that answers at once and leaves a process running on a stream of its own.**

- **Request.** `start-process` names the bound root, the posture, the
  network (R3), the egress token when proxied, the executable's absolute path
  on the target, its arguments (at most 64, each at most 4 KiB, no NUL), the
  account-state grants (R2), and a host-chosen even stream id. The executor
  checks and launches it through its `ProcessConfinementPort` with the posture's
  attested runtime grants (R2), then replies `process-started` with that
  stream, or `refused` with a reason, before any process output. The request
  slot is free again as soon as it replies, so reads, file tools, and commands
  keep running one at a time beside the process.
- **Streams.** The process's standard input and output are that one stream,
  in both directions, under the existing windows (256 KiB, 64 KiB chunks,
  credits). Standard error is not streamed: the executor keeps its last
  64 KiB and sends it with the end. The executor sends `process-ended` with the
  stream, the exit code or signal, and that tail when the process exits; the
  host's `stop-process` sends the process group a terminate, then a kill after
  five seconds. A stream that names no running process, or a process stream
  used after its end, ends the session, as a stray stream does today.
- **Bounds.** At most four placed processes per session, because a runtime
  connection is leased per thread root and posture, not per turn. A fifth is
  refused `busy` and the driver fails the launch; nothing queues.
- **Lifetime.** A placed process dies with its session, as every executor
  launch does (die-with-parent on Linux, the process group on macOS). It ends
  when the driver's scope closes. A posture change ends it, because its grants
  were chosen for the posture it started in; the driver acquires again.
- **Proxied connections name their launch.** `stream-open` gains the request
  id of the launch whose forwarder accepted the connection, because a command
  and placed processes can now be proxied at once and each has its own proxy
  identity on this host. A forwarder exists while its launch runs; `resolve`
  and `dial` are answered while any proxied launch runs, each tied to its
  launch's proxy.
- **Protocol version.** This changes protocol 1's frames after builds with it
  shipped, so it is protocol 2. The exact build match already refuses any
  executor of another build, so no compatibility path is added.

Recommended because a runtime lives for a session of many turns, while the one
request slot exists so that a late answer can never be read as the reply to
the next request; a stream beside the slot keeps that property and needs only
the framing and flow control slice 5 already proved.

Rejected:

- **Running the runtime as a `run-command`.** It would hold the only request
  slot for the runtime's whole life, so the Project's reads and every other
  tool call would wait, and the ten-minute command bound would kill it.
- **A second SSH session per runtime.** Each session needs its own
  attestation (up to three minutes) and its own SSH handshake, which with a
  hardware key means another touch for every runtime; the one-connection rule
  also keeps one owner for every process on the target.
- **Answering requests concurrently in general.** It removes the one-at-a-time
  rule that keeps replies unambiguous, for every request, to serve one that
  does not need it.

#### R2. Runtime grants on the target

**Decision R2: the local wrapped runtime's
grant shape, rebuilt on the target, with the binary and account state checked
there.** A placed runtime gets a posture's command grants (Plan's for Plan,
the writing postures' otherwise), with these differences, which match what
`acpProcess.ts` grants a wrapped runtime on this host:

- **Its own home.** One owner-only folder per provider instance and
  remote-bound Project, under `octant-runtime-homes` in the remote user's state
  directory (`$XDG_STATE_HOME`, or `~/.local/state`), is `HOME` and the
  runtime's only write root outside the bound root. It persists across sessions
  so a provider's resume cursor can find its session files, as the data table
  says. A folder there that the remote user does not own, that is a link, or
  that others can enter is refused, as the runtime directory is. Octant never
  deletes it on its own; removing the target leaves it, as it leaves the
  remote root. Keyed by Project so one root's sessions never read another's.
- **Its binary's folder.** The executor resolves the executable to its real
  path and grants read on that folder and its parent, as locally. It refuses
  `runtime-binary-not-confinable` when the binary is not a regular executable
  file, lies inside the bound root (the repository would choose what runs),
  inside `~/.ssh` or the executor's folders, or in a folder anyone but the
  remote user or root can write. The path comes from the person's per-target
  setting for that provider instance, recorded from a local window with the
  target, never from the model, the remote root, or the target's own report.
- **Account state.** The paths the driver's profile already declares for its
  sign-in on this host (for ACP, `hostAuthentication`), at the same path
  relative to the target user's home. Each is read-only, unless the same
  profile's local launch writes it (a directory whose sign-in refreshes a
  token in place), in which case it is writable on the target too. A path that
  is or holds `~/.ssh`, the bound root, or the executor's folders is refused.
  The driver names the variable that points the runtime at it; the executor
  sets its value, and names starting `OCTANT_`, `SSH_`, `LD_`, or `DYLD_`,
  and `PATH`, `HOME`, and `TMPDIR`, are refused.
- **Process grants.** As the local matrix: Plan cannot write the root, exec,
  or fork (beyond a profile's declared child server re-exec); the writing
  postures can, as the runtime's own built-in tools need.
- **Seam.** `ProviderPlacedLaunch` gains `accountState`, at most four
  home-relative paths (no `..`, never absolute) each with its access and an
  optional variable name. A home-relative path cannot name a folder of this
  host, so the seam keeps its rule that nothing of this host crosses. Since
  6d's prerequisites it also carries `fixedVariables` and
  `deniedRootEntries` ([Before 6d](#before-6d)).
- **Attested.** Two canary rows join the attestation, run with the runtime
  grant shape against a scratch home and a scratch account-state folder:
  a placed runtime in Plan must fail to write the root or its account state
  when declared read-only, exec or fork, read `~/.ssh`, or read a sibling of
  its home; in the writing postures it must fail to write outside the root and
  its home, read `~/.ssh`, or read another runtime home. A posture whose
  runtime rows did not all report a refusal refuses placed runtimes
  `not-attested` while commands in that posture may still be admitted.

Recommended because it is the local matrix's grant on the target, nothing
wider, and every new grant is one the canaries prove before admission.

Rejected:

- **Account state always read-only**, the earlier sketch. A runtime whose
  sign-in refreshes a token in its own folder would fail mid-session with an
  error the person can only clear by signing in on the target again, and the
  local launch already lets it write that one folder.
- **The remote user's whole home readable.** It exposes `~/.ssh`, cloud
  credentials, and every other runtime's state to a process an injected prompt
  can steer.
- **A home in the per-session runtime directory.** It is removed at session
  end, so no provider session could resume after a reconnect.

#### R3. The network a placed runtime gets

**Decision R3: `proxied` through this
host's proxy, public destinations only, journaled.** In every posture a
driver declares, Plan included, a placed runtime runs on `proxied`: its
forwarder carries each connection over the session to a proxy of its own on
this host, as slice 5's commands do. That proxy decides with a runtime rule
of its own: any public destination is allowed, and the private-address check
refuses loopback, private, link-local (the cloud metadata address among them),
and single-label names, under every rule. Thread and Project rules do not
apply and no proposal is raised, because inference must not wait on a rule.
Launches and decisions are journaled as a proxied command's are, on a
`provider-runtime-egress` aggregate naming the thread, provider instance, and
target. The runtime's traffic taints no thread: it is the runtime's own, as
locally; a tool result still taints under its own rules. A runtime that does
not honour the proxy variables cannot reach its provider and fails its turn;
nothing falls back to `allow`.

Recommended because the network a target sits in is not this Mac's. Locally a
wrapped runtime's `allow` reaches the internet and this Mac's own loopback,
which its confinement already covers. On a target, `allow` would also reach the
target's private network and, on a cloud machine, the instance metadata
service, whose role credentials an injected prompt could take, and Octant
would keep no record of it. Allowing every public host keeps a runtime working
without a per-provider endpoint list nobody maintains yet. Residual: a runtime
can still send what it reads to any public host, as it can locally; its
traffic crosses the SSH session twice, so its throughput is the session's.

Rejected:

- **`allow`, the target's own network, as the local matrix materializes
  provider-endpoints-only.** Simplest, and equal to the local grant, but it
  opens the target's private network and metadata service, and leaves no
  record.
- **The thread's and Project's harness rules.** Inference would stop at a
  proposal on every new provider host, and a tainted thread's suspended rules
  would cut off its own model.
- **A provider-endpoint list per driver.** No such list exists for local
  runtimes; inventing one for targets first would make a remote runtime fail
  where the same runtime works here, on hosts (sign-in refresh, model
  catalogues) the list missed. If local runtimes later move to such a list,
  targets follow in that change.
- **`none`.** A runtime with no network cannot reach its model.

On macOS targets `proxied` reaches this host's proxy through the launch's
token-gated loopback forwarder ([macOS targets](#macos-targets)), as the
writing postures' commands do, so a placed runtime is admitted there under
the same runtime canaries as on Linux.

**Plan, as built: proxied through a nested capsule (maintainer decision,
2026-10-27).** A Plan runtime runs on `proxied` as R3 says. Linux confinement
starts a proxied launch's command from its forwarder, which needs the fork
and exec Plan's process filter denies, so for a process-denied launch the
forwarder alone runs outside the filter and starts a nested Bubblewrap that
keeps every mount of the capsule, takes a pid namespace and `/proc` of its
own, and loads Plan's filter onto the runtime
(`apps/server/src/process/linuxConfinement.ts`). The forwarder's fork and
exec of that nested capsule is the whole loosening: the runtime keeps Plan's
read-only root and every other Plan restriction, cannot start a process
(fork and `execveat` are refused, which the `runtime-fork-after-start` and
`runtime-exec-after-start` canaries prove in the nested capsule), and cannot
see or trace the forwarder. Residual, as for every Plan launch: the filter
does not refuse `execve`, so the runtime can replace itself with a program
its capsule shows (its binary's folders and interpreter, the forwarder's
runtime, Bubblewrap, which cannot clone there, or a file with an execute bit
in what it may write); host program folders stay masked. The outer capsule
leaves `/proc/sys` uncovered, because the kernel refuses a new `/proc` under
a covered one (measured on bubblewrap 0.9.0); the nested capsule covers its
own, and only the forwarder sees the outer one. On a root host the nested
capsule cannot map its uid and the runtime never starts, and the executor
refuses a root target anyway. Rejected: running Plan offline, as 6b first
built it, which left a Plan runtime unable to reach its model; and allowing
fork and exec to the whole Plan capsule, which would let the runtime start
programs.

#### Which runtimes first

**Decision R4: ACP first, with its
client file and terminal capabilities only.** An ACP agent speaks its protocol
on standard input and output, so `appToolTransport: "stdio"` is true of it. On
a target its client file and terminal requests run through the executor's file
operations and commands, admitted per call as slice 5's tools are; its HTTP
MCP bridge is a listener and is not offered, so app-managed tools that need it
report unsupported for remote-bound Projects. OpenCode on a target runs as an
ACP profile (its own ACP mode), not through its loopback server API, and Pi
waits until its tool bridge has a transport that is not a loopback listener.
Rejected: OpenCode's local-server adapter (a loopback HTTP listener on the
target, which admission refuses); Pi's loopback bridge (the same).

#### Placement threat model

| Threat                                                                   | Holds because                                                                                                                                       | Residual                                                           |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A long-lived process makes replies ambiguous                             | It is a stream beside the request slot; requests stay one at a time; a stray process stream ends the session                                        | None                                                               |
| The repository chooses the runtime binary                                | The path is the person's per-target setting; a binary inside the bound root, or in a folder others can write, is refused                            | The target's administrator can replace any binary, as stated above |
| The runtime reads the remote user's keys or other runtimes' state        | `~/.ssh` stays denied; homes are per instance and Project; account state is only the profile's declared paths; canaries prove each before admission | A runtime reads its own account state, as locally                  |
| The runtime reaches the target's private network or the metadata service | `proxied`; the private-address check refuses loopback, private, and link-local destinations                                                         | Any public host is reachable                                       |
| Runtime traffic leaves no record                                         | Launches and decisions journaled on this host on their own aggregate                                                                                | Hosts and counts, not content                                      |
| A runtime keeps running unseen                                           | It dies with the session; a scope close or posture change stops it                                                                                  | None                                                               |
| Another user on the target reaches the runtime                           | No listener: stdio over the session; the forwarder is an owner-only Unix socket; loopback tool transports refused                                   | Root on the target, as stated above                                |
| A runtime home or account-state path is swapped for a link               | Owner, mode, and link checks before each launch; the grant is the resolved folder                                                                   | A swap after the check is the remote user's own act, out of scope  |
| Many runtimes exhaust the session                                        | Four placed processes per session, per-stream windows, standard error kept as a bounded tail                                                        | One slow runtime is bounded by its window                          |

#### Placement delivery

Each is its own reviewable change with this section updated in place.

- **6b. Executor runtime launches.** Container.
  - Protocol 2 with `start-process`, `stop-process`, `process-started`,
    `process-ended`, and launch-tagged `stream-open`; the runtime home, binary,
    and account-state checks; the runtime canary rows; the placed launch in
    `sshTargetConnectionService.ts`'s placement; and the runtime egress rule
    and its records on this host.
  - _Accepts when:_ against loopback `sshd`, a fixture runtime placed in Plan
    and approval-gated echoes over its stream while reads and a command run
    beside it; it cannot write outside its root and home, read `~/.ssh`, or
    reach the target's loopback or a private address, and its allowed public
    connection is journaled on this host; a binary inside the root, a
    world-writable folder, a linked home, and a fifth process are refused; a
    lost session ends it, and nothing runs on the next session.
  - _Verify:_ protocol, executor, connection-service, and loopback smoke tests;
    `git diff --check`.
  - _Built 2026-10-27_ (`executorProcesses.ts`, `executorRuntimeGrants.ts`,
    `providerRuntimeEgress.ts` in `apps/server/src/sshTarget/`). Its evidence
    is `sshTargetLoopback.smoke.test.ts` (a fixture runtime under Bubblewrap
    on the loopback target, in Plan and approval-gated, echoing while a read
    and a command run beside it and reaching a public name through its
    journaled proxy in both, the Plan one refused starting its own binary or
    a shell; refused a write outside its root and home,
    `~/.ssh`, the target's loopback, a private name, and an address, and its
    allowed public connection and refusals journaled here; a binary inside
    the root or in a world-writable folder, a linked home, and a fifth
    runtime refused; a runtime killed with its session and the old placement
    refused on the next), `executorProcesses.test.ts` (the reply before any
    output, the end after the last output, stop and session end, the bound,
    and each check before a launch), `sshTargetConnectionService.test.ts` (a
    runtime placed only where its posture's runtime canaries passed, refused
    before any frame elsewhere and without a runtime proxy, and ended with its
    session), `sshTargetAdmissionPolicy.test.ts` and `toolEgressPolicy.test.ts`
    (the runtime canary table and the runtime rule),
    `nativeHarnessEgressProxy.test.ts` (the proxy under the runtime rule), and
    `sshExecutorProtocol.test.ts`.
- **6c. ACP declares placement.** Container.
  - The ACP driver declares Plan, approval-gated, and auto-accept-edits with
    `stdio`, launches through the placement, and routes its client file and
    terminal requests through the executor.
  - _Accepts when:_ an ACP profile backed by a fixture agent passes the
    placement conformance against loopback `sshd` in every declared posture:
    started only through the placement at an absolute path, failing the turn
    when the target refuses, stopping every placed process when its scope
    closes; and a client file write in Plan is refused before the executor.
  - _Verify:_ provider-sdk placement conformance, ACP conformance, and the
    loopback smoke.
  - _Built 2026-10-27_ (`acpPlacement.ts` and the placed path of
    `acpDriver.ts` in `apps/server/src/providers/`,
    `createRemoteCodeAcpClientTools` in `apps/server/src/code/codeAcpClientTools.ts`,
    and the per-target runtime path; [As built in 6c](#as-built-in-6c)).
    Its evidence is `sshTargetLoopback.smoke.test.ts` (an ACP profile backed
    by a fixture agent passing placement conformance against the loopback
    target in Plan, approval-gated, and auto-accept-edits, every agent it
    placed gone from the target afterwards and none started here; the agent
    in the bound root, signed in with the target's own account state; in
    Plan a client write refused with no request reaching the executor and a
    read answered through it; in approval-gated a write and a terminal run on
    the target through the executor), `acpConformance.test.ts` (that profile
    passing placement conformance against a stand-in target, launching the
    person's path with the profile's arguments and account state, no placed
    agent kept for a later session, and every shipped profile reporting
    placement unsupported), `acpPlacement.test.ts` (which profiles and
    postures can be placed, the account state, an agent refused for its
    version or identity, and a session refused before any
    launch in an undeclared posture, with bridge tools, or for a key-signed
    instance), `codeAcpClientTools.test.ts` (a client write or terminal in
    Plan refused before the target is asked, reads run after run, writes,
    terminals as one command, kill, and the working folder and variables
    refused), `processPlacementConformance.test.ts` (a driver launching a
    path of its own fails), `sshTargetConnectionService.test.ts` (no
    placement without the person's path, and a launch of another path or
    after the path changed refused before any frame), `sshTargetStore.test.ts`
    (runtime paths replayed from the journal, dropped with their target, and
    left out of the export), `sshTargetAdministrationRoutes.test.ts`, and
    `sshTargetCommand.test.ts`.
    The projection table is migration 88.
- **6d. Real-provider smoke.** Maintainer.
  - _Accepts when:_ one real ACP agent, signed in on a Linux target with its
    own account state, runs a Code turn on a remote-bound Project from this
    Mac: it reads and edits the remote root, its inference leaves through this
    host's proxy and is journaled, and a reconnect resumes or rebuilds its
    session. The result is recorded here with the agent, the versions, and the
    target's distribution.
  - _Before it can run:_ GitHub Copilot's profile is placeable and the Code
    turn runtime composes a remote-bound Project's ACP thread
    ([Before 6d](#before-6d)), and a local window's composer offers the
    agent for a remote Project once its path is set on the target
    (`octant ssh-target runtime`). What remains is the maintainer's run.

#### As built in 6b

6b settled these details the decisions above leave open, each in the
fail-closed direction:

- **Plan runs proxied through a nested capsule** (maintainer decision,
  2026-10-27). See the end of R3: the forwarder alone runs outside Plan's
  process filter, and the runtime keeps it.
- **Stopping is a frame, not a request.** `stop-process` names the stream
  and travels beside the request slot, so a stop never waits behind a
  ten-minute command. One for a stream that never carried a process ends the
  session; one that crosses the process's own end is ignored.
- **The end is the stream's last word.** The executor sends a runtime's
  output, then `stream-end`, then `process-ended`, and never closes the
  stream with `stream-close`: a close reaching this host first would discard
  output it has not read yet. Neither side closes a process stream on its
  own when both directions end. A frame on that stream after
  `process-ended` ends the session.
- **The stream id is taken as the request is written.** A start waiting
  behind another request takes its even id only when it goes out, so a
  connection a proxy asked for meanwhile cannot take a higher id first and
  make it look reused.
- **Only the request id tags a connection.** `stream-open` names its launch;
  `resolve` and `dial` do not, and are answered while any proxied launch
  runs, each tied on this host to the proxy that asked. A launch's forwarded
  connections close with it; the dialed ones close with their proxy, or when
  no proxied launch is left.
- **Runtimes on macOS (as of 2026-10-28).** As built in 6b the policy
  refused a provider runtime on a macOS target `runtime-not-attestable`, and
  the executor reported the runtime canaries there `inconclusive`. Since
  maintainer decision 9 a macOS target runs the runtime canaries through
  Seatbelt and a loopback forwarder, and admission treats it as a Linux
  target ([macOS targets](#macos-targets)).
- **The runtime canary rows.** A placed runtime is admitted only where its
  posture's command probes and these runtime probes all reported a refusal:
  in Plan, writing the root, writing read-only account state, exec, fork,
  reading `~/.ssh`, reading another runtime's home, and connecting around the
  proxy, each run proxied in the nested capsule a Plan runtime gets; in the
  writing postures, writing outside the root and home, writing
  read-only account state, reading `~/.ssh`, reading another runtime's home,
  and connecting around the proxy. An escape in any of them refuses the whole
  connection, as any escape does. The probes run with the same grant
  function the launches use (`runtimeLaunchGrants`), against a scratch home
  and a scratch account state in the session's own folder. No deny cover is
  put over `~/.ssh`: the capsule never mounts the home, and a cover would
  only mount an empty folder there, which the canary rightly read as an
  escape.
- **The binary's folders.** The binary is its resolved path, and that file,
  its folder, and every folder above it must belong to the remote user or
  root; the binary and its folder must be writable by no one else, and a
  folder above may be writable by others only with its sticky bit. Its
  folder may not be, hold, or sit inside the bound root, `~/.ssh`, the
  executor's folder, or the runtime homes; its parent is granted read-only
  only when it holds none of those and is not the home or above it.
- **The home's folders.** The home is
  `<state>/octant-runtime-homes/<Project>/<provider instance>`, where
  `<state>` is `XDG_STATE_HOME` when absolute, else `~/.local/state`. Each
  of its three folders is made owner-only if missing and must be a real
  folder of the remote user's that no one else can enter; the resolved home
  may not overlap the bound root, `~/.ssh`, or the executor's folder.
- **Account state.** Each path must exist, belong to the remote user, and
  resolve inside the home but not to the home itself, and may not overlap
  `~/.ssh`, the bound root, the executor's folder, or the runtime homes; the
  grant and the variable's value are the resolved path. A variable may not be
  named twice, and besides the names R2 refuses, any name holding `PROXY`, and
  `SHELL`, `USER`, and `LOGNAME`, are refused, so account state cannot
  redirect the runtime's proxy.
- **One posture per placement.** A placement is made for one posture. A
  launch, and every write to a placed runtime, reads the thread's posture,
  and another one stops the runtime and fails with `interrupted`, so the
  runtime is acquired again in the new posture.
- **No proxy, no networked runtime.** A host without a runtime proxy (any
  platform but macOS and Linux) places no runtime in any posture, rather
  than run it offline or on the target's own network.
- **What the records hold.** The runtime egress aggregate is
  `provider-runtime-egress`, one per launch: `launch-started` names the
  thread, Project, provider instance, target, and session; decisions and the
  summary carry the proxy's own entries, without a thread's taint.

Not built in 6b, and named here so a later change owns it: summarizing a
runtime egress launch that a host restart left open (as
`thread.egress-launch-incomplete@1` does for commands), and removing a
thread's runtime egress records when the thread is purged. The person's
per-target binary setting R2 names is built in 6c.

#### As built in 6c

6c settled these details the decisions above leave open, each in the
fail-closed direction:

- **A profile is placed only where its whole launch can be stated there.**
  A placed launch carries a program, its arguments, and home-relative
  account state, so an ACP profile opts in with `remote` (its arguments on a
  target), and `acpRemotePlacement` declares nothing for one whose local
  launch sets a guard or a variable, writes a managed file, reads a host
  path, denies a path in its sign-in folder or the root, or refuses
  Projects by their files: each would be silently left behind on the
  target. Postures the profile refuses, and Plan for an agent that forks a
  child server, are left out. In 6c every shipped profile set guards or
  variables, so none was placed; [Before 6d](#before-6d) carries guards and
  denied root entries and places the first real profile. Rejected: dropping
  what the seam cannot carry, which would run an agent on a target with its
  own project configuration, auto-update, or extension loading that Octant
  turns off here.
- **Account state is the sign-in folder one variable names.** The profile's
  `hostAuthentication` folder, at the same path under the target user's
  home, read-write as the local launch grants it, and named by the one
  variable the profile points the agent at it with. A placed agent's `HOME`
  is its own runtime home, so a folder no variable names would never be
  found; a credential file the local launch links into its managed home, a
  variable whose value is not the folder itself, a folder outside the home,
  and entries denied inside it are not stated, and the profile is not
  placed.
- **No key crosses.** An instance that signs in with an API key or a browser
  sign-in here declares nothing and is never placed, because provider
  credentials never reach a target (decision 4).
- **The agent's version is its own answer.** No version probe runs on the
  target, so the version is the one the agent's `initialize` answer
  reports; one that reports none Octant can compare, one below the
  profile's minimum, or another agent is refused `incompatible`, and the
  placed process is stopped with the start's scope.
- **The runtime path is the person's, journaled.**
  `ssh-target.runtime-binary-set@1` records one path per provider instance
  on a target, set only from a local window's administration route or
  `octant ssh-target runtime`, at most 64 per target, and removed with the
  target. `placement` hands no placement for an instance without one; the
  placement carries it, and a launch naming any other path, or made after
  the person changed it, is refused before any frame. The path names a
  file on the target, so the host export and diagnostics leave it out, as
  they leave out the executor path. Settings › SSH targets shows no control for it
  yet; a local window reaches it through the route, and the CLI is the
  person's way in until that page gains one.
- **Client requests run as the remote harness's own calls.** A placed ACP
  session's client tools are `createRemoteCodeAcpClientTools` over the
  turn's remote harness binding: a read or write is its file tool on the
  bound root, and a terminal is one harness command through the executor,
  each admitted in the turn's posture at that call on the session the turn
  holds. Plan offers only the read; a write or a terminal the agent asks
  for anyway is refused by the driver before the tool set, which refuses it
  again before anything reaches the target. The executor answers a command
  only once it ended, so a terminal's output reads empty and without an
  exit status until then, and its wait returns both. A terminal's working
  folder must lie inside the bound root, and its variables may not name
  `PATH`, `HOME`, `TMPDIR`, or a proxy, because a proxied command's proxy
  variables carry its launch's egress token.
- **A placed agent is never kept.** Locally a completed session of a
  release that passed warm-reuse evidence keeps its agent for the next
  turn. A placed agent was admitted, and its egress is recorded, for one
  placement's thread and posture, so it stops with its session instead, and
  a placed session never takes up a kept agent, which runs on this host.
- **No tool bridge on a target.** The HTTP MCP bridge is a listener, so a
  placed session refuses app-managed tools that need it `unsupported`
  before anything launches, whatever this host's platform.
- **The output reader never holds the stop.** A placed process's output
  ends only once the process does, so the agent's output reader is asked
  to stop with the scope rather than waited for; waiting for it before the
  launch's own release hung against the loopback target.

Not built in 6c, and named here so a later change owns it: the Code turn
runtime composing a remote-bound Project's ACP thread (built before 6d,
below), a Settings › SSH targets control for the runtime path, and clearing
a path short of removing the target.

#### Before 6d

6d needs one real profile that can be placed, a Code turn that starts it,
and a composer that offers it. Every shipped profile's local launch fixes
guard variables and denies Project entries a placed launch could not carry
after 6c, so the seam carries both first, as its own step. These rules
settle each, in the fail-closed direction:

- **Fixed variables are the driver's constants.** `ProviderPlacedLaunch`
  gains `fixedVariables`, at most 32, and `start-process` carries them. A
  value holds no `/` and no control character, so it names no folder of this
  host; a name follows the account-state variable's rules (no `OCTANT_`,
  `SSH_`, `LD_`, or `DYLD_` prefix, nothing with `PROXY`, and not `PATH`,
  `HOME`, `TMPDIR`, `SHELL`, `USER`, or `LOGNAME`), and a name an
  account-state path's variable already takes is refused by this host
  before any frame and by the executor. The executor sets them first, so
  every variable it sets itself (`LANG` included) wins over one of the same
  name. The protocol version is unchanged: the executor's build must equal
  this host's, and a start without the fields reads as before.
- **Denied root entries are covered on the target.** `deniedRootEntries`,
  at most 32, each relative to the bound root and never climbing out of it
  (no absolute path, empty segment, `.`, or `..`). The executor covers each
  one that exists when the runtime starts, for reading and writing, with the
  same Linux deny cover a local launch uses (`additionalDenyReadPaths` and
  `additionalDenyWritePaths`). A missing entry is skipped, as a local Linux
  launch skips it, because Bubblewrap would make it as its mount point in
  the person's root; one made mid-session is covered from the next launch.
- **A profile's guards and denied Project entries travel as both.** The ACP
  driver states a profile's guards as `fixedVariables` and its
  `forbiddenRootEntries` as `deniedRootEntries`, checked with
  `placedLaunchExpressible`; a guard the target would refuse (a value
  holding `/`, a name the target sets itself) declares nothing. Denials
  inside the sign-in folder (`hostDeniedEntries`, `forbiddenEntries`) and
  host reads still declare nothing.
- **The home and its default folders are the target's.** The target sets
  `HOME` to the runtime's home and no XDG folder, so a local launch that sets
  `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, or
  `XDG_STATE_HOME` to the managed home or its default folder under it
  (`.config`, `.cache`, `.local/share`, `.local/state`) names the same folders
  there and is left to the target. Any other variable still declares
  nothing.
- **GitHub Copilot is the first placed profile.** Its local launch is a
  guard (`NO_COLOR`), `HOME` and `XDG_CONFIG_HOME` under its home, its sign-in
  folder `~/.copilot` named by `COPILOT_HOME`, and Project entries it would
  otherwise load (skills, settings, hooks, MCP and language-server files), so
  its whole launch carries over in Plan, Ask for approvals, and Auto-accept
  edits. Rejected: Grok Build, whose `initialize` answer reports no version
  for a placed start to compare; Goose and GLM Agent, whose sign-in variable
  names the folder's parent; and Gemini CLI and Qwen Code, which refuse
  Projects by reading the root's files here.
- **The Code turn places the thread's agent.** See
  [Remote-bound Code threads](#remote-bound-code-threads): the turn binds
  the agent's client tools and a placement on one session and acquires its
  provider with that placement alone.
- **The window offers what the turn would place.** A target's status
  (`SshTargetStatus`, the answer a window already polls) gains
  `placeableRuntimes`, at most 64: each enabled provider instance whose
  driver, built as the Code turn runtime builds it, passes the turn's own
  check (an ACP agent that declares placement), with that runtime's
  admission now in each confined posture (the turn's
  `admitProviderRuntime` call, so an undeclared posture and an unproven
  runtime canary refuse there as in the turn) and whether
  the person set its path on the target (`runtimePath`, read from the same
  runtime paths the placement reads). `placeableRuntimesOn` in
  `apps/server/src/sshTarget/sshRemoteCodeThreads.ts` computes it beside
  `bindPlacedAcpTurn`. The composer offers such an agent's models beside the
  harness's only when the status lists it, its runtime is attestable in a
  posture a remote thread offers, and its path is set; an agent listed
  without a path is shown unavailable with the command that sets it
  (`octant ssh-target runtime <target> <provider instance> <path>`, the
  ids filled in), which is also the sentence the turn's placement refuses
  with, spelled out above the agent's models in the picker. Every other
  provider stays unavailable. Start is offered only while the runtime's
  admission in the chosen posture is admitted, and a remote thread's own
  view reads the same for its agent. Postures are unchanged: Plan and Ask
  for approvals. Rejected: a separate endpoint for placeable agents, which
  a window would have to poll beside the status it already reads, and
  offering every ACP agent with the host deciding at Start, which would
  offer what the turn refuses.
- **Evidence.** For the seam: `executorProcesses.test.ts` (fixed variables
  set beside the executor's own and never over them, only existing denied
  entries covered, and a fixed variable naming an account-state variable
  refused), `sshTargetConnectionService.test.ts` (both carried in the
  request, and a path value, a target-set name, an account-state name, or an
  entry above the root refused before any frame),
  `sshExecutorProtocol.test.ts` (the wire bounds), and
  `processPlacementConformance.test.ts` (`placedLaunchExpressible` agreeing
  with them). For the profile and the turn: `sshTargetLoopback.smoke.test.ts`
  (a Code thread on a remote-bound Project whose turns run a fixture ACP
  agent through the Code turn runtime against the loopback target: acquired
  only through the placement, nothing started here, the agent signed in with
  the target's account state, its guard set, its Project's denied
  `.mcp.json` empty to it while the rest of the root reads, its client read
  and write on the target as the target's user, a Plan turn's write refused
  and nothing written, and no thread created holding Full access or
  Auto-accept edits; without the cover the denied file was read),
  `acpPlacement.test.ts` (Copilot alone among shipped profiles placed, guards
  and denied entries carried, home defaults left to the target, and other
  variables still refused), `acpConformance.test.ts` (Copilot passing
  placement conformance with its guard, denied entries, and sign-in folder),
  `sshRemoteCodeThreads.test.ts` (a placed ACP turn bound to its client
  tools and a placement in the thread's posture, Plan offered only the read,
  a missing runtime path refused with the tools released, a placed runtime
  that is not an ACP agent refused before binding, and a target
  in use found only from a thread on its binding), `codeProjection.test.ts`
  (a remote turn running or waiting at a restart interrupted
  `target-disconnected`, a settled one untouched, and a second
  reconciliation adding nothing), and `sshTargetAdministrationRoutes.test.ts`
  (removal refused `target-in-use` while a thread runs, then allowed). For
  the window: `sshTargetConnectionService.test.ts` (a status lists an ACP
  agent with its path set and one without, each admitted in every posture,
  and no provider that declares no placement or is not an ACP agent; a
  closed connection's agents refused `target-unreachable`; a macOS target's
  agent admitted in the postures its driver declares; and the turn's
  placement refusing the pathless agent with the window's sentence),
  `sshTargetRecovery.test.ts` (the offer and the readiness from a status),
  and `CodeComposerAdapter.test.tsx` (the agent offered beside the harness
  and a thread started on it, a pathless agent disabled with the command
  spelled out, and no Start while its runtime is refused in the posture),
  and `CodeThreadWorkspace.test.tsx` (a thread on the agent offers no send
  while its runtime is refused in the posture or its path is missing).
  The restart withdrawal and the compaction refusal are proved by
  `leadApprovalAttention.test.ts` (a remote lead's approval and question
  settled `expired` and journaled at start-up, an answer to either refused,
  and a second start settling nothing more), `sessionCompaction.test.ts` (a
  remote thread refused `runs-on-ssh-target` with nothing journaled and no
  session opened), `codeOperationRuntime.test.ts` (no compaction session
  opened for a remote root), `contextCompaction.test.ts`, and
  `ComposerContextMeter.test.tsx` (the popover's line in place of the
  button).

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
| A provider instance's runtime path on a target            | This host's journal                      | Removed with the target; never exported                    |

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
readable on this host, and new work in them refuses `target-removed`. The
refusal while a thread runs is not built yet: removal today ends that turn
`target-disconnected`.

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
- **Reconnect is the host's.** When an attested session drops (the client
  exits, the network is lost, a request goes unanswered, or the executor
  breaks the protocol), the connection service reconnects on its own and
  re-attests before admitting anything. A new attestation never inherits the
  last one. Built in `apps/server/src/sshTarget/sshTargetConnectionService.ts`,
  paced by `packages/domain/src/sshTargetReconnectPolicy.ts`. These rules
  settle it, each in the fail-closed direction:
  - **Each attempt is a first connection.** It writes the pin file again from
    the journal's key, starts the same fixed client with
    `StrictHostKeyChecking=yes`, waits for a matching introduction, and asks
    for the whole attestation. Nothing of the dropped session (its
    attestation, its turns' tools, its terminals, a placed runtime) is
    carried to the new one, and no attempt is made with a weaker pin or
    fewer probes.
  - **Bounded, with jitter.** At most eight attempts after one drop, the
    first after one second and each later wait doubled up to a minute, each
    varied by up to a fifth either way; about three minutes in all.
  - **A count survives a flapping target.** A reconnected session must hold a
    minute before a later drop starts a fresh count; one that drops sooner
    continues the count that opened it, so a target that attests and drops
    again and again still stops after eight attempts.
  - **Honest while it lasts.** The target's status reads `reconnecting` with
    the attempt and the next attempt's time (`reconnect` in
    `SshTargetStatus`). Every request on the target, every posture, is
    refused `target-reconnecting` with the attempt and that time, so a new
    turn, a tool call, a read, a terminal, or a worktree change is refused
    before any frame instead of waiting. Turns that were running stopped as
    interrupted when the session dropped (above). Settings › SSH targets,
    which reads the targets every five seconds while it lists any (showing
    no answer to a read sent before a later action or a later shown read, so
    a removed target never reappears), the
    sidebar, the composer, and `octant ssh-target list` show the state and
    the next attempt's time on the reader's clock.
  - **Stops where only the person can help.** A changed host key, a refused
    sign-in (`authentication-refused`), or a missing or mismatched executor
    stops after that attempt, as does a target still unreachable after the
    last, and an attempt that breaks before it ends in a state (the pin file
    cannot be written), which also ends any session it opened. The status then reads that state with `reconnect` stopped and the
    attempts made, and nothing tries again until the person connects. A
    reconnected session whose attestation refuses (an escaped canary, a
    missing backend) is a session: it is held, admits nothing its
    attestation does not prove, and nothing reconnects it.
  - **The person's action wins.** A connect, re-pin, or removal cancels a
    reconnect under way or stopped, and its own outcome stands; a connect
    starts a fresh count. Shutting the server down cancels every reconnect.

  **Rationale.** Reconnecting after any attested session's drop, rather than
  only while a remote-bound Project is open or a thread waits to resume,
  needs no knowledge of windows in the connection service, which owns the
  session; the bound on attempts caps what an idle target costs. A changed
  key is never retried in the hope that the pinned one returns, which would
  turn a refused man in the middle into a polling loop. No existing backoff
  helper fit: the provider endpoint retry is shaped by `Retry-After` and
  streamed output, the cache backoff starts at thirty seconds with no
  jitter or bound on attempts, and the service restart backoff has no
  jitter.

- **Resume.** A provider session with a resume cursor resumes when the runtime's
  own session files survived on the target; otherwise the host rebuilds history in
  a fresh session, as for any host-owned resume.
- **Host restart** is a disconnect: recovery marks in-flight remote turns
  interrupted from the journal and withdraws the native-harness approvals
  and questions they left pending (built; see
  [Remote-bound Code threads](#remote-bound-code-threads)). Connection state
  is not journaled, so a restarted host starts no reconnect; the person
  connects the target.

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
9. **A proxied launch's forwarder on a macOS target** (accepted 2026-10-28).
   Each proxied launch gets a loopback listener of its own on a random port,
   which admits a connection only when its first request presents that
   launch's egress token, and closes with the launch
   ([macOS targets](#macos-targets)). Seatbelt cannot put a launch in a
   network namespace of its own, so the token takes the namespace's place:
   another user of the Mac can reach the port and nothing behind it.
   Rejected: offline writing postures on macOS, which would leave commands
   and runtimes there without a network; and a Seatbelt-specific listener
   out of other users' reach, which Seatbelt's `localhost:<port>` rule cannot
   express.

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
   the executor's side of it, and on 2026-10-27 (5b) as thread creation in a
   remote-bound Project and the Code turn runtime composing the tool set for
   a native-harness thread there
   ([Remote-bound Code threads](#remote-bound-code-threads)), and the same
   day as a local window's binding, sidebar, composer, and thread view
   ([In a local window](#in-a-local-window)); restart recovery of remote
   turns and refusing a target's removal while one runs were built before
   6d ([Before 6d](#before-6d)), and reconnecting on its own after that
   ([Disconnect, reconnect, and restart](#disconnect-reconnect-and-restart)),
   whose evidence is `sshTargetConnectionService.test.ts` (against the
   stand-in client with an injected clock: a dropped session reconnected,
   re-attested from the journal's pin, and a turn bound to the new session
   while the old one's calls stay refused; a turn started while reconnecting
   refused with the attempt; a changed host key, a refused sign-in, and a
   reconnected session whose canary escaped each stopping at once; the waits
   and the stop after eight attempts; a flapping target stopping; and no
   reconnect after removal or shutdown), `sshTargetReconnectPolicy.test.ts`,
   `sshTargetAdmissionPolicy.test.ts`, `sshTargetRecovery.test.ts`, the web
   `SshTargetsSettingsSection.test.tsx`, and `sshTargetLoopback.smoke.test.ts`
   (a turn stopped when the executor dies, the next refused while the host
   reconnects, and, once the host reconnected on its own to the loopback
   `sshd`, the thread's next turn running on the new session). The
   window step's evidence is `shellService.test.ts` (a Code draft binds the
   window with `boundRoot` null, the binding survives bootstrap with Files
   unavailable, a remote thread's view opens and its terminal is refused),
   `codeOperationService.test.ts` (a connector refused before any extension
   resolves), `codeThreadCreate.test.ts`, and the web tests of the sidebar
   group, Project picker, composer, thread view, Code workspace tabs, dock,
   and board. 5b's evidence is
   `sshTargetLoopback.smoke.test.ts` (a Code thread created in a
   remote-bound Project through the Code service and its harness turn run
   through the Code turn runtime over a model stub: a read, an edit, a test,
   and a fetch on the loopback target with approvals, egress decided and
   journaled here, no Git of this host called, Full access refused at
   creation, another Code operation and a fork refused, and a turn narrowed to Plan
   offered no write or command; a runtime without placement and one with it
   refused before either is acquired; a paired device creating no Full
   access thread and writing nothing in Plan, and a window bound elsewhere
   refused; and a turn stopped `target-disconnected` when the executor dies,
   a new turn refused while the target is away, and nothing run on the next
   session) and `sshRemoteCodeThreads.test.ts` (the derived checkout, and
   the provider refusals before anything is composed). The earlier
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
   access, or a loopback tool listener). The executor's runtime launches are
   built as 6b under [Runtime placement](#runtime-placement), with its
   evidence there, and the ACP driver's declaration as 6c, with its
   evidence there; the real-provider smoke (6d) remains.
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
   Built 2026-10-28 ([macOS targets](#macos-targets)); the run against a
   second Mac remains.

#### macOS targets

A macOS target attests every confined posture: its canaries run through
Seatbelt with the grants Octant's own launches carry (see the macOS probes
rule under
[Confinement attestation and admission](#confinement-attestation-and-admission)),
so binding a root, Files, Git status and diff, Plan, approval-gated and
auto-accept threads, terminals, managed worktrees, and placed runtimes are
admitted there under the same policy as on a Linux target. A Plan turn and a
harness turn on a macOS target are not yet shown end to end through the turn
runtime; the parts they use are, below.

**The forwarder (maintainer decision 9, accepted 2026-10-28).** Seatbelt's
`proxied` rule names one loopback TCP port, and Seatbelt cannot give a launch
a network namespace of its own, so on macOS the executor
(`apps/server/src/sshTarget/executorLoopbackForwarder.ts`, used by
`ExecutorEgress` in `executorLaunches.ts`) gives each proxied launch, a
command or a placed runtime, this forwarder in place of Linux's Unix socket:

- **A port of its own.** A listener on `127.0.0.1` at a port the system
  picks, opened before the launch starts; the launch's profile allows
  outbound to `localhost:<that port>` and nothing else, so the launch reaches
  no other loopback port and no other address.
- **Its token on every connection.** The launch's egress token, which this
  host's proxy already requires and which only the launch's proxy variables
  carry, must be presented as `Proxy-Authorization: Basic octant:<token>` in
  each connection's first request head, compared in constant time
  (`timingSafeEqual`, as the host's proxy compares it). A connection with no
  token, another token, a head that does not parse, or one larger than
  32 KiB is answered `407` and closed; one that has not sent its head within
  10 s is dropped; past 32 connections still owing a head, new ones are
  dropped at once. Nothing of a refused connection reaches this host.
- **Then forwarding.** An admitted connection becomes the launch's stream to
  this host, its first head included, where the launch's proxy checks the
  token again on every request, decides, and journals, as on Linux.
- **It closes with the launch.** The listener stops and every connection it
  forwarded or still holds closes when the command ends or the runtime
  stops, and with the session.

Another user of the target can connect to the port while the launch runs,
and gets a `407` and nothing else; the token is unguessable (32 random
bytes) and worthless once the launch ends. Attestation's proxied probes on
macOS each get a forwarder of their own that admits a token no probe holds,
so the probe that connects around it (to the SSH server's loopback port)
proves another port is refused. Linux is unchanged: its forwarder stays a
Unix socket in an owner-only directory, behind the capsule's own network
namespace.

Evidence (macOS only; CI runs Linux and skips them):
`executorAttestation.test.ts` (every Plan probe refused; every probe of the
writing postures and every runtime probe of each posture refused, the
network ones through a loopback forwarder; a writing capsule given the
network reporting the connection around its forwarder `escaped`; a capsule
granting Plan's write, exec, fork, and network reporting each `escaped`)
and `sshTargetMacLoopback.smoke.test.ts` (the bundled executor behind a
stand-in client on this Mac: every confined posture attested and admitted,
and a placed runtime admitted in each; an approval-gated command run
proxied, reaching a stand-in for this host's proxy with its token while a
request with no token or another token is refused `407` before it reaches
the host and a connection to another loopback port is refused by Seatbelt,
the forwarder closed with the command; a placed runtime in Plan and
approval-gated doing the same, Plan unable to write its root; a managed
worktree and an approval-gated terminal in it that commits there and writes
nowhere beside it; binding a root and reading its files, Git status, and
diff through Seatbelt-confined Git; `/usr/bin/git status` working in that
terminal and in a proxied command while `/private/var/select` and
`/private/var/db` stay unlistable; refusing a root that holds `~/.ssh`;
removing its runtime directory with the session). On every platform,
`executorLaunches.test.ts` shows the forwarder refusing no token, another
token, and a malformed head without a frame to the host, forwarding the
token's connection with its first request as a stream naming the launch,
and no longer listening once the launch ends. Not yet shown: the same
through a real `sshd` on a second Mac, which is the maintainer's run.

**Git's shim.** `/usr/bin/git` on macOS is the `xcode-select` shim, which
reads `/private/var/select/developer_dir` and `/private/var/db/xcode_select_link`
under the denied `/private/var`; without them `git` in a terminal on a macOS
target failed "unable to read data link" (measured on this Mac's Seatbelt).
A terminal and a harness command on a macOS target may read those two links,
each as a `literal` rule (`MACOS_GIT_SHIM_READ_PATHS`, as Octant's own Git
launches use), and nothing else there: listing `/private/var/select` or
`/private/var/db` stays refused. Seatbelt matches the resolved
`/private/var` spelling, so the `/var` form needs no rule of its own. The
first `xcrun` lookup in a session prints warnings because it cannot reach
its user cache; it then caches in the launch's own temporary folder.

## Verification

Prose alone needs no test. Each slice's verification is listed with it. The
policy (slice 2) and the canary refusals (slice 3) are the evidence for the
acceptance criterion; a remote that is merely reachable proves nothing.
