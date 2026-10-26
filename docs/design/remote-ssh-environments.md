# Remote SSH environments

This topic specification owns how a Code thread runs on a machine the host
reaches over SSH: what an SSH target is, how the host connects to it, how it
proves its confinement before any work is admitted, what happens when the
connection drops, where the record of that work lives, and how this differs from
a paired Octant host and from a hosted relay. Architecture owns the boundaries it
builds on: [modes and checkout binding](../architecture.md#modes-chat-work-and-code),
[persistence](../architecture.md#persistence), and
[security and authority](../architecture.md#security-and-authority).

**Delivery state.** Accepted 2026-10-26. Slice 2, the admission policy and
contracts, is built: the schemas in `packages/contracts/src/sshTarget.ts` and
the pure decision in `packages/domain/src/sshTargetAdmissionPolicy.ts`. No host
service calls it yet, so no Project can bind a remote root; slices 3 to 8 are
not built. Remote SSH
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
  (as the person would type it after `ssh`), a pinned host key, the remote user it
  logged in as, its platform, and the path of the executor on it. An SSH target is
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
  itself. The provider-sdk has no process-placement port.
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

### Transport

One SSH connection per target, owned by a host service in `apps/server`. The host
runs the system OpenSSH client with a fixed argument list. Nothing a thread,
model, or remote produces reaches its arguments or environment. Options given on
the command line take precedence over the person's SSH configuration, and these
are always set:

| Option                                                | Why                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `ForwardAgent=no`, `ForwardX11=no`                    | The remote never gains the person's SSH identity or display     |
| `ClearAllForwardings=yes`                             | A configured port forward cannot open a path into this Mac      |
| `PermitLocalCommand=no`                               | A configured local command never runs on this Mac               |
| `StrictHostKeyChecking=yes`, `UserKnownHostsFile=<…>` | Only the pinned key is accepted, from Octant's file             |
| `BatchMode=yes`, `-T`                                 | No password or passphrase prompt reaches Octant; no remote PTY  |
| Remote command: the executor's absolute path only     | The remote shell receives no interpolated data, only the binary |

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
([decision 1](#maintainer-decisions)).

The executor runs as the logged-in remote user, never root: a session whose
remote user is uid 0 is refused `remote-root-user`, because a root executor's
confined children can undo their own confinement. It creates one owner-only
runtime directory per session for scratch, temporary files, and the egress
forwarder, removes it when the session ends, and sweeps stale ones at start. It
opens no listening socket.

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

**What attestation proves, and what it does not.** It proves that this
connection's executor is the matching Octant build and that confinement held
against the canaries on that kernel, under a non-root user. It does not prove
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

### Provider runtimes on a target

Equivalent confinement means the remote reaches the local matrix, not a stronger
one. A runtime is admitted on an SSH target only in a posture where Octant itself
wraps it, because only then can the canaries speak for it:

- **Native harness.** Admitted. Inference stays on this host with this host's
  credentials, exactly as today. Its tools (shell, file edits, tests) run through
  the executor. Harness egress decisions stay on this host: the executor's
  forwarder sends each connection's head (destination, port, TLS server name) over
  the session, this host decides it with `decideToolEgress` and journals the
  decision, and only an allowed connection is opened, from the target. A decision
  this host cannot journal refuses, as locally.
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
| Target registration, pinned key, attestation results      | This host's journal; pin file owner-only | Removed with the target                                    |
| Connection state (connected, attesting, lost)             | This host's memory                       | Not journaled, like listener observation                   |
| Remote root, managed worktrees                            | The target                               | The person's files; Octant never deletes them on removal   |
| Executor runtime directory                                | The target, owner-only                   | Removed at session end; stale ones swept at the next start |
| A provider runtime's own session files                    | The target, in that runtime's own home   | Provider-owned, as locally                                 |

Every event about remote work is appended by this host, under the thread's actor,
with the target's id as provenance. The executor holds no journal, projection, or
database. Target address, remote user, and remote paths are personal data and are
handled as a local Project root path is in diagnostics and export.

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
| Another user on the target reaches the executor or its tools | No listening socket; runtime directory owner-only; loopback tool transports refused until reviewed               |
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
   includes server route negatives and `git diff --check`.
4. **Remote-bound Code Projects and reads.** Container. Bind a remote root
   (local-only), Files, Git status, and diff through the executor, each admitted
   by slice 2's policy. Accepted when a Project on an unattested target refuses
   creation and reads, and an attested one lists files and Git status from the
   target. Journal replay test for target and binding events.
5. **Native harness on a target.** Container. Harness shell, edits, and tests run
   through the executor with approvals; egress heads decided and journaled on this
   host; disconnect interrupts the turn with `target-disconnected` and queues
   nothing. Accepted by a harness turn against loopback `sshd` with a local model
   stub, plus the disconnect test.
6. **Provider-sdk process placement.** Container for the seam and conformance
   tests; real-provider smoke needs provider sign-in on a target (maintainer).
   Extend `ProviderAcquireInput` with a host-supplied placement that drivers
   declare support for; drivers without it report remote unsupported. Accepted by
   provider-sdk conformance and one wrapped runtime launched on a target.
7. **Terminals, managed worktrees, and Settings.** Container for behavior and
   rendered QA in a browser; desktop packaged smoke needs a Mac (maintainer).
   Remote terminals and worktrees under the same admission, the SSH targets
   Settings page and Project picker per `DESIGN.md`, and the user guide.
8. **macOS targets.** Needs a second Mac reachable by SSH (maintainer). Seatbelt
   canaries and the same end-to-end evidence as slice 3 against a macOS target.

## Verification

Prose alone needs no test. Each slice's verification is listed with it. The
policy (slice 2) and the canary refusals (slice 3) are the evidence for the
acceptance criterion; a remote that is merely reachable proves nothing.
