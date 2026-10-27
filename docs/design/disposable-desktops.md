# Disposable desktops

This topic specification owns disposable desktops: throwaway Linux desktops a
thread leases so that an agent and the person can launch, drive, and look at
what the thread built, on a host that has no screen of its own. Architecture
owns the boundaries it applies: computer use is destination-shaped and
app-managed ([Architecture: extensions and skills](../architecture.md#extensions-and-skills)),
launches go through the shared confinement port, and authority is checked on the
server ([Architecture: security and authority](../architecture.md#security-and-authority)).

**Delivery state.** Accepted 2026-10-26; slices 1–5 and recipe storage are
built, and slice 6 is built for E2B. Cua Spaces follows the
[local-daemon design](#cua-spaces-through-the-local-daemon) accepted on
2026-10-27: its daemon port and its driver for a Space on this machine or on
the person's other machine are built, and no host offers it yet (see
[Built in Cua sub-slice 1](#built-in-cua-sub-slice-1),
[Built in Cua sub-slice 2](#built-in-cua-sub-slice-2), and
[Built in Cua sub-slice 3](#built-in-cua-sub-slice-3)). The maintainer
authorized this scope as post-preview work and accepted the
[maintainer decisions](#maintainer-decisions) below on 2026-10-26, naming the
two cloud providers on 2026-10-27; it is not part of the first release, and the
[Current Release Boundary](../../AGENTS.md#current-release-boundary) is
unchanged by this document. The lease contract, the `desktop-provider` seam
and its conformance suite, the host lease service, the host-local provider,
artifact transfer, the agent's binding of `octant_computer` to a lease, the
Desktop pane, a Code Project's stored recipe with its settings editor, the
cloud HTTPS port, the E2B driver, the local-daemon port, recipe
placements, and the Cua driver for this machine and the person's other
machine exist; no host offers E2B
or Cua for leasing yet, so a recipe can name only the host-local provider
(see
[Built in slice 1](#built-in-slice-1),
[Built in slice 2](#built-in-slice-2),
[Built in slice 3](#built-in-slice-3),
[Built in slice 4](#built-in-slice-4),
[Built in slice 5](#built-in-slice-5),
[Built in slice 6](#built-in-slice-6), and
[Built: recipe storage](#built-recipe-storage)). Sub-slice 3's follow-ups are
built as well: a recipe names the computer a Space on another of the person's
computers runs on, the pane says when a view is refused because the session
could be read on its way, and the host refuses network where a placement
cannot have it ([Built: Cua follow-ups](#built-cua-follow-ups)). Slice 4's real-provider smoke,
slice 6's E2B live smoke, and Cua sub-slices 2 and 3's live smokes are still
owed by the maintainer.

**Name.** The product calls it a _disposable desktop_. "Computer" already names
the Mac computer-use destination and the paired-host Computers card, and a
third meaning would blur which one a refusal or approval is about.

## Outcome

A Code thread on a headless host builds a Linux GUI app or a web app. It leases
a disposable desktop, sends one named build artifact across, launches it, and
the agent drives it while the person watches in a Desktop tab and can take the
mouse at any time. When the lease ends (released, expired, thread ended, host
restarted) the desktop is destroyed and Octant verifies it is gone.

The host keeps its checkout and its credentials. The thing under test runs
somewhere that holds neither.

## What exists today

- **Destination reporting.** `apps/server/src/computerUse/computerUseDestination.ts`
  reports `available`/`macos-host` on a Mac with a screen,
  `leasable`/`disposable-desktop` with the effective desktop providers on a host
  whose only option is a lease, and otherwise `unavailable` with
  `no-destination` (a Mac without a screen) or `no-provider-configured`. A Mac
  with a screen also lists any leasable providers. `refuseComputerUseDestination`
  turns that into a refusal value; the Mac runtime refuses `leasable` as
  `no-destination`, because a provider is not a screen until a send binds a
  lease.
- **Runtime seam.** `apps/server/src/computerUse/computerUseRuntime.ts` owns
  policy, approvals, sensitive-field protection, session expiry
  (`ComputerUsePolicy.maxSessionDurationMs`, at most one hour), and evidence
  above a native adapter with `observe`, `execute`, and `cleanup`. Lifecycle
  evidence is written by `computerUseValidationEvidence.ts`.
- **The live agent path.** The bundled plugin
  (`apps/server/src/plugins/computerUse/computerUsePlugin.ts`) offers
  `octant_computer` and receives only a task-bound `ComputerUseHostPort`
  (`packages/plugin-api/src/computerUse.ts`). The host binds that port to a
  `ComputerUseOwner` at turn admission (`packages/contracts/src/computerUsePlugin.ts`)
  and runs it through `computerUseToolService.ts`, which reserves and releases
  the owner on a loopback broker (`desktopComputerUsePort.ts`) served by
  Electron main (`apps/desktop/src/computerUseBroker.ts`,
  `computerUseControlHost.ts`). That driver is supported only on Apple Silicon
  macOS (`apps/desktop/src/computerUseDesktopService.ts`). A headless host has
  no broker. On Linux, `apps/server/src/wiring/computerUse.ts` still builds the
  tool service, for sends bound to one of the thread's leases
  ([Built in slice 4](#built-in-slice-4)); elsewhere it builds none. Either way
  the host reports the lease service's destination: `leasable` on a Linux host
  whose host-local provider is ready, `no-destination` on a Mac without a
  screen, `no-provider-configured` elsewhere. A leasable provider is not a
  screen: only a send that names a lease binds one.
- **Command set.** `ComputerControlCommand` has `apps`, `launch`, `windows`,
  `observe`, `click` (by element index, or by `x`/`y` on a screenshot for an
  image-capable model), `type`, `press` (by element index, or to keyboard
  focus, which only a disposable desktop accepts), `scroll`, and `stop`. The older
  `ComputerUseActionKind` in `packages/contracts/src/computerUse.ts` also names
  `drag` and `move-cursor`, which the live command set does not carry.
- **Actors.** `EventActor` (`packages/contracts/src/events.ts`) already
  separates `agent`, `local-user`, `remote-device`, and `system`.
- **Confinement.** Linux launches go through `ProcessConfinementPort` as
  Bubblewrap capsules (`apps/server/src/process/linuxConfinement.ts`):
  `--unshare-all`, private `/tmp`, a read-only synthetic root, bound roots
  only, and no unconfined fallback. Owned process groups leave receipts that
  the host reconciles after a restart (`apps/server/src/process/nodeOwnedProcessReceipt.ts`).
- **Streamed screens.** Simulator and emulator panes stream a screen through the
  host, authorized like a screenshot and never stored, with actor-attributed
  input ([Device workbench](device-workbench.md)).
- **A vendor seam with a credential.** The image seam is the precedent for a
  bundled driver that calls a paid service on the person's own key: the driver
  imports only contracts and the seam, declares its hosts in code, and the host
  attaches the key from its credential store
  ([Architecture: providers](../architecture.md#providers)).

The former plan to build this on Linux Station execution capsules is gone: that
design was cancelled and its capsule model was never built. Per-thread Station
isolation is not built either ([roadmap](../roadmap.md)). This design uses only
the confinement the host has now.

## Settled by current specifications

- Computer use is a provider-neutral core capability; a host with no destination
  reports it absent and refuses as a value, never a throw or a hang.
- New providers are plugin-shaped: they reach the host through published seams
  and take no shortcut a third-party plugin could not. Lifecycle and security
  stay app-managed; only the provider adapter and the pane's presentation are
  extraction candidates ([plugin boundaries](../architecture.md#plugin-boundaries-and-remaining-extraction)).
- Plan refuses computer-use control. Application content is untrusted, results
  taint the thread (`apps/server/src/providers/appManagedToolTaint.ts`), and a
  tainted thread gets no standing approvals.
- Octant operates no cloud. A cloud resource runs only on the person's own
  account, with their key held in the host credential store, as for replica
  stores and image providers.
- Octant detects binaries and readiness but never installs them.
- A live screen streams through the host and never stores frames; a capture is
  host-held evidence under the screenshot rules.

## Model

- **Recipe.** A Project owns at most one desktop recipe: the provider, the
  provider's own settings (an image or template for a cloud provider; screen
  size), the credential reference when the provider needs one, the network
  posture, and the lease time limits. A person configures it in Project
  settings; an agent cannot create or edit it.
- **Lease.** A thread leases a desktop from its Project's recipe. The lease is
  the unit of ownership: it belongs to exactly one thread and is never
  transferred. A thread may hold at most two leases; the host caps live leases
  across all threads. Work and Code threads may lease; Chat cannot (a Chat
  Project has no root to send an artifact from, and Chat never offers
  Browser). Code is delivered first.
- **Tab.** A Desktop tab is a view onto one lease. Two leases are two tabs.
  Closing a tab does not end the lease.

### Lease states

`requested` → `provisioning` → `ready` → `releasing` → `released`, with
`release-failed` (still billing or still running; retried) and `refused` or
`failed` at acquisition. `released` is written only after the provider confirms
the resource is gone; a destroy call that returned is not proof. Each transition
is a journal event carrying the lease id, thread, provider, and the acting
`EventActor`. Projections of leases are rebuildable from those events.

The events are `desktop.lease-requested@1`, `desktop.lease-transitioned@1`,
and `desktop.lease-extended@1` on the `desktop-lease` aggregate. Acquisition
events carry the caller as actor; teardown transitions carry `system`, with
the person or agent who asked in `requestedBy` and the cause in `endReason`.
`provisioning` is journaled immediately before the provider call and `ready`
once the driver returns a handle. A retry of a `release-failed` lease records
only its outcome (`release-failed` → `released`), so a desktop a provider keeps
refusing to destroy does not grow the journal per attempt. The driver's handle
is never journaled: after a restart the host finds a desktop by its tag. Detail
text in the journal is Octant-authored, never a driver's reason. Idle time and
open tabs are host memory, not journal state, because a restart destroys every
lease anyway.

## Rules

### Authority

- The server checks every lease command except teardown against the thread's
  current authority before any provider call: the thread is active, the caller
  may open it, the mode is Work or Code, the Project has a recipe, and the
  provider's plugin is installed, trusted, enabled, and effective. Each failure
  is a named refusal (`no-provider-configured`, `provider-disabled`,
  `not-leasable-mode`, `lease-limit`, `leased-by-another-thread`,
  `lease-ended`). The rest of the closed set: `thread-not-active` (archived,
  completed, or deleted), `not-permitted` (the caller may not open the thread,
  an agent names another thread, or the actor is `system`), `computer-use-off`,
  `plan-mode`, `declined` (a confirmation was refused, or authority changed
  while a person decided), `provider-unavailable` (the driver's `status` is not
  ready), `release-pending` (see verified release), and for extension
  `agent-cannot-extend`, `beyond-maximum`, and `extension-unconfirmed`. A lease
  id the host does not know answers `lease-ended`.
- An operating command (extend, screen, control, deliver) re-resolves the
  driver through the plugin host on every call and requires it effective; it
  never uses the driver a lease retained for teardown. A recipe whose provider
  or credential reference changed counts as removed. Extensions on one lease
  run one at a time, provider call included, so the journal records the
  expiry the provider was last asked for; the provider call is bounded like a
  teardown call.
- **Teardown** is the one path those revocations do not close. Release and
  verification of an existing lease run on a host-owned path, as `system`,
  that needs only the lease id; it stays authorized after the thread is
  archived or deleted, the recipe or its credential is removed, or the
  provider's plugin is disabled or loses trust, because those are exactly the
  events that end a lease. It can call only `release`, `verifyGone`, and
  `listOwned`; it never acquires, extends, transfers, reads the screen, or
  sends input. A person's Release or Retry, and an agent's release of its own
  thread's lease, ask the host to run it. (Refusing teardown when authority is
  revoked would leave a billed desktop running with no way to stop it.) A
  release from a thread names that thread and is refused for another thread's
  lease. Retry is a person's action only and may name any lease on the host
  whose release is not yet verified (`releasing` or `release-failed`), because
  it can only stop spending; it refuses `not-permitted` for a running lease,
  which only its own thread may release. An agent cannot Retry.
- **Acquiring** is an effect. Plan refuses it. Approval-gated and
  auto-accept-edits ask in the thread. Full access proceeds for a host-local
  provider. For a provider that bills the person, a person confirms every
  billed lease in every posture, Full access included
  ([decision 2](#maintainer-decisions)). A person also confirms every lease
  whose desktop runs off this machine (a placement whose locality is not
  host-local), in every posture, their own Start included: it runs where they
  should know of before it starts, and it can outlive this host
  ([C5](#expiry-and-teardown-when-the-daemons-host-may-die)). A person who
  acquires a host-local desktop has already decided and is not asked again;
  Plan still refuses them, and a billed or off-machine lease still asks. The
  host re-checks authority after the answer, and an answer given for one
  provider, placement, machine, or posture never covers another.
- **Reading** the screen (a frame, a screenshot, a window list) needs no
  approval. **Agent input** follows the existing computer-use rules unchanged:
  `@Computer`-style per-send selection, per-application approval, sensitive-field
  protection, the session cap, and the taint rule.
- **The person's input** from a Desktop tab is not an agent action and asks for
  nothing. It is journaled as `local-user` or `remote-device`; agent input is
  journaled as `agent`. Either operator may act at any time; the agent's next
  observation is fresh, so it never acts on a frame the person changed.
- One destination per send. A send's structured selection names the destination
  (this Mac, or one of the thread's leases); the host binds the plugin's port to
  it at admission and never chooses between two.
- No lease command reaches another thread's lease, and a restored tab never
  rebinds to a different lease.

### Isolation

- A desktop holds no host credential and no checkout. Nothing of the host is
  mounted, bound, or synced into it. It receives: the recipe's own contents,
  artifacts sent by an explicit transfer, and input.
- A host-local desktop runs as a dedicated Bubblewrap launch through
  `ProcessConfinementPort` with no checkout, no home directory, no Secret
  Service or session bus, no SSH agent, an allowlisted environment with no
  `OCTANT_*` value, a private writable home and inbox under a host-private lease
  directory, and its own network namespace. It cannot reach the host's loopback,
  so it can never reach the Octant server. Its only channel to the host is the
  launch's standard streams.
- A cloud desktop's API key stays in the host credential store. The host
  attaches it to calls the driver makes, only over HTTPS and only to hosts the
  driver declares in code. It never enters the desktop, a provider runtime, a
  plugin's state, a renderer, or the journal. Any stream URL or token the cloud
  provider returns stays in host memory; the host terminates that stream and
  re-serves frames on its own authorized channel.
- Everything coming back from a desktop is untrusted: frames are bounded in
  bytes and dimensions before decoding, window titles and element labels are
  length-bounded, and agent-visible results taint the thread.

### Artifact transfer

- Only an explicit, journaled transfer moves bytes in. A transfer names one
  checkout-relative regular file (Work: Project-root-relative). An absolute
  path, a path resolving outside the root, a symlink, anything under `.git`, a
  file over the size limit, or a file that changes while being read is refused.
  The host reads it on an open handle with identity checks, as Apple artifacts
  are read, and journals the path, size, and SHA-256.
- The file lands read-only in the lease's inbox under its base name. Nothing is
  copied back out except screenshots and recordings as host-held evidence;
  bringing a file back from a desktop is not in scope.
- A transfer is an effect: Plan refuses; approval-gated asks with the path,
  size, hash, and destination. A transfer to a cloud desktop sends data off the
  machine to the person's provider and always asks, in every posture.

### Lifecycle and teardown

- A lease ends when the person or agent releases it, when it expires, when it
  is idle too long, when its thread is archived, completed, or deleted, when the
  recipe or its credential is removed, when the provider plugin is disabled, or
  when computer use is turned off. Ending always destroys the desktop.
- Every lease has a hard expiry. A person may extend it up to the recipe
  maximum; an agent cannot extend a lease. The host asks the driver to move the
  provider-side expiry first and accepts the extension only when the driver
  confirms the new expiry; otherwise the extension is refused, the original
  expiry stands, and the lease ends on time. Idle release applies when no tab
  is open and neither operator has acted.
- The host checks every running lease against these causes after each journal
  commit and every 30 seconds; a commit that lands while a check is running
  starts one more check after it. A lease ended while its provider is still
  creating it cancels the acquisition, and the desktop is destroyed as soon as
  a handle arrives. A graceful host stop does not release leases; restart
  reconciliation and the provider-side expiry cover them.
- **Journal before create.** The host journals `requested` with a host-minted
  lease id before calling the provider, and the driver tags the resource with
  that id and the host's identity. A crash between the provider call and the
  `provisioning` event therefore leaves a tagged resource the host can find.
  The host identity is a random tag minted once and kept in the host's data
  directory, never derived from a path, because two machines sharing one
  provider account can have the same data-directory path.
- **A failed acquisition leaves nothing.** When the driver refuses, fails, or
  is cancelled, the host lists the provider's tagged desktops for that lease id
  and destroys any it finds. One it cannot verify gone blocks the provider as a
  `release-failed` lease does.
- **Provider-side expiry is mandatory for a billed provider.** The driver sets
  the provider's own timeout to the lease expiry plus a short margin, so a host
  that never comes back still stops paying. A billed provider that cannot set
  one is refused by the seam's conformance suite, and the host itself refuses
  to keep a billed desktop whose reported provider-side expiry is missing or
  earlier than the lease expiry: the lease is `failed` and the desktop is
  destroyed.
- **Teardown outlives revocation.** The `requested` event records the
  provider and the recipe's credential reference, never the material. When a
  lease is not yet `released`, removing its recipe or credential, or disabling
  the provider plugin, ends the lease and keeps the driver loaded and the
  credential held in the host store for the teardown path only: neither can
  serve an acquire or any operating command, and neither contributes anything
  to a thread. The host drops the driver binding and deletes the credential
  only after verified release; until then Settings shows the removal as waiting
  on release.
- **Restart.** On start, before admitting any new lease, the host destroys every
  lease the journal does not show as `released`, and every tagged resource its
  driver lists that has no live lease. Host-local desktops are reaped through
  their process-group receipts and their lease directories are deleted. Tabs for
  those leases restore as unavailable and never reconnect. An acquire waits for
  this reconciliation to finish. A provider listing that answers without a
  lease's desktop is the provider confirming it is absent; a lease whose driver
  is not loaded, or whose provider cannot list, stays `release-failed`.
- **Verified release.** Release succeeds only when the driver confirms the
  resource is absent. Otherwise the lease is `release-failed`: the host retries
  with backoff, the Desktop tab and Settings show "still running" with the
  provider and a Retry, and new leases on that provider are refused until it
  clears. Octant shows elapsed time and expiry, never a cost estimate it cannot
  verify. Each teardown call is bounded at 60 seconds and a call that times out
  counts as failed, never as gone. Retries back off from 30 seconds, doubling
  to at most 15 minutes; a person's Retry ignores the backoff.

## Provider seam

A desktop provider is a bundled or third-party plugin contribution, kind
`desktop-provider`, declared in `@octant/plugin-api` beside the replica-store
and Computer use ports (`@octant/plugin-api/desktop-provider`). The component
kind is executable, so a manifest must name its entry point, and it is
mode-safe in Work and Code only. A driver also declares its `id`,
`displayName`, `locality` (`host-local` or `cloud`), and whether it is
`billed`. A driver imports only `@octant/contracts` and that seam; a test
fails on any other import, as for image drivers. Every operation
returns a discriminated result (`status`: `ready`, `refused`, `failed`,
`not-connected`, and the operation's own success), never a throw for an expected
outcome. The host owns leases, journaling, authority, approvals, teardown,
reconciliation, the stream proxy, and evidence; the driver owns only the
translation to its provider.

| Operation                                              | Driver contract                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`                                               | Whether the provider can be used on this host now (binaries present, credential readable); performs no work                                |
| `acquire(leaseId, hostTag, recipe, expiresAt, signal)` | Creates one desktop tagged with the lease id and host tag, with provider-side expiry when billed; returns an opaque handle, or `cancelled` |
| `extend(handle, expiresAt)`                            | Moves the provider-side expiry; succeeds only with the expiry the provider now reports                                                     |
| `screen(handle)`                                       | A bounded frame source and an input sink (pointer, key, text, scroll) for the host's stream                                                |
| `control(handle, command)`                             | The `octant_computer` commands it supports; unsupported ones refuse `unsupported`                                                          |
| `deliver(handle, name, bytes)`                         | Writes one read-only file to the inbox                                                                                                     |
| `release(handle)` / `verifyGone(handle)`               | Destroy, then confirm absence                                                                                                              |
| `listOwned(hostTag)`                                   | Tagged resources for restart reconciliation                                                                                                |

The host gives the driver capability-scoped ports, never raw handles: a confined
launch port for a host-local provider, and an authenticated HTTPS call port for a
cloud provider. Each port is added to the seam with the slice whose driver
needs it (2 and 6). The HTTPS port, `DesktopHttpsPort`, reaches only the hosts
a driver declares in its code (`hosts`), attaches the person's key itself, and
answers every call as a value ([Built in slice 6](#built-in-slice-6)). The
local-daemon port, `DesktopDaemonPort`, reaches only the Unix socket and the
methods a driver declares (`daemon`), and a provider may declare the
placements a recipe chooses among (`placements`)
([Built in Cua sub-slice 1](#built-in-cua-sub-slice-1)). A cloud
desktop's handle names the credential reference of the account it lives in,
and `listOwned(hostTag, credentialRef)` lists one account; a provider that
needs a credential answers `failed` without one, because `listed` is the
provider confirming every other desktop is absent. The confined launch port, `DesktopLaunchPort`, launches one
named program only for a lease the host is provisioning and only once per
lease, always as the host's dedicated desktop launch; the driver chooses the
program and its arguments and nothing about the capsule. A driver the host keeps only for
teardown is held as `DesktopTeardownPort` (`id`, `release`, `verifyGone`,
`listOwned`), so it cannot be asked to do anything else. A conformance suite
(`@octant/plugin-api/desktop-provider-conformance`), modelled on
`packages/provider-sdk/src/imageGenerationConformance.ts`, proves that a driver
stops when cancelled, tags what it creates, sets provider-side expiry when it
bills, reports an extension only when the provider confirms the new expiry,
reports absence only when absent, refuses rather than degrades an
unsupported command, and, given a second driver over the same provider, lets
a restarted host find by its tag and destroy what a killed one left; a billed
driver must prove the last. Its fixture maps two scenarios onto whatever backs the
driver, a provider that declines an extension and a desktop that outlives its
destroy, so a recorded transport can drive the same checks. The in-memory
driver tests use (`packages/plugin-api/src/fakeDesktopProvider.ts`) is test
scaffolding, imported by path, and not part of the published seam. The
desktop's agent-facing commands are the existing
`octant_computer` set; a host-local desktop without an accessibility tree
returns observations with a screenshot and no elements, so it is usable only by
image-capable models and refuses `needs-image-model` otherwise. Adding `drag`
and `move-cursor` to the command set is its own contract change.

## Threat model

| Risk                                                     | Mitigation                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A leaked cloud desktop bills silently                    | Journal-before-create, tagged resources, mandatory provider-side expiry, restart reconciliation, verified release, visible failure; a teardown-only path with its retained driver and credential survives thread, recipe, and plugin revocation |
| A person-extended lease dies at the old provider timeout | An extension is accepted only after the driver confirms the new provider-side expiry; otherwise it is refused and the original expiry stands                                                                                                    |
| The app under test or an injected agent reads secrets    | No checkout, home, keyring, session bus, SSH agent, or `OCTANT_*` in the desktop; cloud key never leaves the host                                                                                                                               |
| The desktop reaches the host                             | Own network namespace with no host loopback; standard streams are the only channel; bounded parsing of everything returned                                                                                                                      |
| Kernel escape from a host-local desktop                  | Same Bubblewrap boundary Code tool launches already rely on; a VM-backed provider is the stronger boundary                                                                                                                                      |
| Transfer used to exfiltrate                              | One named file, refused outside the root or under `.git`, hash journaled, the person sees it; cloud transfers always ask                                                                                                                        |
| Desktop content steers the agent                         | Results taint the thread; standing approvals stop; sensitive-field protection and per-app approval unchanged                                                                                                                                    |
| Another thread or a stale tab takes over a screen        | Leases are thread-bound; a restored tab shows unavailable and never rebinds                                                                                                                                                                     |
| A stream token or provider URL leaks to a client         | The host terminates the provider stream; renderers get only the host's authorized channel                                                                                                                                                       |
| A host-local desktop exhausts the host                   | Host-wide lease cap, per-thread cap of two, hard expiry, idle release                                                                                                                                                                           |

## Maintainer decisions

The maintainer accepted these on 2026-10-26. Each states the rule; the
alternatives considered and the reason for the choice follow it.

1. **First provider.** The first provider is a host-local virtual display in a
   Bubblewrap launch: no new runtime, no account, no cost, Linux hosts only,
   contents are the host's installed apps, kernel-shared isolation. The cloud
   providers, on the person's own account, are **E2B** and **Cua Spaces**
   (named 2026-10-27): VM isolation and image templates, but an account,
   billing, and data leaving the machine. Each is its own bundled driver
   through the same `desktop-provider` seam, so neither gets a shortcut the
   other, or a third-party plugin, could not take. E2B is delivered first. The host-local
   provider exercises the whole seam, teardown, transfer, and pane in a Linux
   container with no account, so the risky host-owned parts are proven before
   money is involved. Not planned: a host-local OCI container provider
   (rootless Podman), which offers real per-Project images but needs a
   container runtime the person installs and a second confinement mechanism
   Octant must verify; it is reconsidered only if per-Project images prove
   necessary locally. _Why two cloud providers:_ offering two keeps the seam
   honest about what is provider-specific, and a person can use the account
   they already have. Rejected: one cloud provider only, which would let the
   seam quietly take one vendor's shape.
2. **Who may acquire a billed lease.** A person confirms every billed lease in
   every posture. Rejected: ordinary posture rules, as for any effect. Spending
   the person's money is not a code effect Full access covers.
3. **Paired devices.** Any client that may open the thread may view and operate
   its desktop. Rejected: view only from paired devices, and local windows
   only. The desktop holds nothing of the host's, and a headless host is mostly
   used remotely. Acquiring a billed lease still needs decision 2's
   confirmation.
4. **Lease limits.** A lease expires after 30 minutes and a person may extend
   it to a recipe maximum of 4 hours; an idle lease is released after
   15 minutes; a thread holds at most two leases; a host runs at most two live
   host-local leases.
5. **Host-local network.** A desktop has no network by default; a person may
   set a per-recipe `allow`. Rejected: no network at all. Deferred to a later
   slice: forwarding one approved Local server port into the desktop. A web app
   is tested from its built artifact first; a forwarded port is a new inbound
   path and gets its own approval design.

## Delivery plan

Each slice is one reviewable PR that updates this specification's delivery
state. "Container" means an agent can implement and verify it in a Linux
container with no account or hardware.

1. **Lease contract and host lease service** (container). Lease schemas, events,
   refusals, and the `desktop-provider` seam types; the host service for
   acquire, release, extension, expiry, idle, thread end, restart
   reconciliation, verified release, and the teardown-only path; destination
   reporting that names leasable providers; a test-only in-memory driver and the
   conformance suite. No real provider, no UI. _Accepts when_ a host with no
   provider reports the capability absent and refuses every lease command as a
   value; a second thread is refused `leased-by-another-thread`; expiry and
   thread archive destroy and verify; recipe removal and plugin disable still
   destroy and verify while the retained driver refuses acquire and control; an
   extension the driver does not confirm is refused and the original expiry
   stands; a restart destroys every unreleased lease and every orphaned tagged
   resource before admitting a new one; an unverified release stays
   `release-failed` and blocks new leases on that provider;
   `computerUseRuntime.test.ts` and `computerUseToolService.test.ts` pass
   unchanged. _Verify:_ focused contracts and server tests, typecheck consuming
   packages.
2. **Host-local provider** (container with `bwrap` and a virtual X server
   installed; per decisions 1 and 5). Readiness detection, the dedicated
   Bubblewrap launch, the standard-stream screen channel, receipts.
   _Accepts when_ real-`bwrap` negatives show the desktop cannot read the
   checkout, home, or keyring, cannot connect to host loopback, and gets no
   `OCTANT_*` value; release and restart leave no process. _Verify:_
   confinement tests under real Bubblewrap, conformance suite.
3. **Artifact transfer** (container). _Accepts when_ refusals cover absolute,
   escaping, symlinked, `.git`, oversized, and changing files; path, size, and
   hash are journaled; Plan refuses and approval-gated asks. _Verify:_ focused
   server tests with permission negatives.
4. **Agent control** (container with a scripted model; remote clients per
   decision 3). The send selection binds `octant_computer` to a lease.
   _Accepts when_ a scripted turn launches a transferred GUI app, observes,
   clicks, types, and screenshots it; per-app approval, Plan refusal, taint, and
   `agent` attribution hold; a non-image model is refused `needs-image-model`.
   _Verify:_ tool-service and provider-sdk conformance tests; a real-provider
   smoke needs a provider credential.
5. **Desktop pane** (container, headless browser QA). Dock tool, live stream
   through the host, person input, states (setup, acquiring, live, interrupted,
   release-failed, ended), restore as unavailable. Updates
   [Workspace](workspace.md) and the user guide. _Accepts when_ person input is
   journaled as `local-user`/`remote-device` with no approval, and a restored
   tab never reconnects. _Verify:_ component tests and rendered QA at each state.
6. **Cloud provider drivers** (per decisions 1 and 2: E2B, then Cua Spaces;
   needs a maintainer-owned account, an API key, and billing authority for
   each). Bundled drivers through the seam, declared hosts, provider-side
   expiry and its extension, tag reconciliation. _Accepts when_ the
   conformance suite passes against a recorded transport, and a
   maintainer-run smoke acquires, drives, releases, and confirms at the
   provider that nothing remains, including after a forced host kill.

Later, each with its own design note here: a forwarded Local server port,
accessibility element trees for host-local desktops, `drag` and `move-cursor`,
and Work-mode leasing if it is not delivered with Code.

### Built in slice 1

- **Contract.** `packages/contracts/src/desktopLease.ts`: lease, recipe, owner,
  states, end reasons, refusals, events, and screen input. A recipe's lease
  limits are bounded by the four-hour maximum, and its initial lease cannot
  exceed its own maximum. `desktop-provider` joins the manifest component kinds.
- **Policy.** `packages/domain/src/desktopLeasePolicy.ts`: transitions, the
  acquire gate, the per-thread and host-local caps, the lease clock, extension,
  and the billed-expiry check.
- **Seam.** `packages/plugin-api/src/desktopProvider.ts`, its conformance suite,
  and the in-memory driver. `plugin-host` treats the kind as mode-safe in Work
  and Code.
- **Host.** `apps/server/src/computerUse/desktopLeaseService.ts` and its
  projection, wired in `apps/server/src/wiring/computerUse.ts`. It reconciles
  on start and sweeps after each commit and every 30 seconds.

The running host registers no desktop provider, and no Project stores a
recipe. No caller can open a thread through the service and confirmation
always declines, because the Desktop pane (slice 5) and the agent's lease
binding (slice 4) bring their own caller authority and approval surface.
Recipe storage and its Project settings editor came later
([Built: recipe storage](#built-recipe-storage)).

### Built in slice 2

- **Seam.** `DesktopLaunchPort` in `packages/plugin-api/src/desktopProvider.ts`:
  `readiness`, `launch`, `stop`, `inspect`, and `listOwned`. A launch names a
  program, never a path, and receives its standard output through a callback.
- **Driver.** `apps/server/src/plugins/hostLocalDesktop/`: the `host-local`
  provider and its standard-stream channel. It imports only
  `@octant/contracts` and the seam, which a test enforces. Inside the capsule
  it runs a shell that starts `Xvfb` at the recipe's screen size and answers
  one-line requests: a frame (ImageMagick's `import` of the root window, as
  PNG), or input through `xdotool`. Readiness requires `sh`, `Xvfb`,
  `xdotool`, `import`, and `base64` on the capsule's search path.
- **Host launch.** `apps/server/src/computerUse/hostLocalDesktopLaunch.ts`
  builds each desktop through `ProcessConfinementPort` with no checkout, a
  writable `home` and a read-only `inbox` as its only host paths, `/tmp` as a
  private tmpfs, network egress `none`, and the environment `PATH`, `HOME`,
  `TMPDIR`, and `LANG` only. It is a detached process group with a
  `desktop-lease` process receipt beside the host tag. Restart reconciliation
  lists desktops through those receipts and lease directories, and `stop`
  deletes the lease directory once nothing of the desktop runs.
- **Wiring.** `apps/server/src/wiring/computerUse.ts` loads the driver on every
  Linux host and offers it for leasing when readiness reported ready at start.
  Slice 1's placeholders stay: no recipe, no caller may open a thread, and
  confirmation declines, so production still refuses every lease command.

Rules this slice resolved:

- **Network `allow` is refused for now.** Bubblewrap gives a launch network
  only by sharing the host's network namespace, which would reach host
  loopback and the Octant server, against the [isolation](#isolation) rule.
  The host-local driver refuses a recipe whose network is `allow`
  (`network-allow-unsupported`) until a desktop gets egress that keeps its own
  namespace, as proxied tool launches do through the host's egress proxy.
  Decision 5's per-recipe `allow` stays the target; the host refuses to store
  a host-local recipe that sets it ([recipe storage](#built-recipe-storage)).
- **Loaded for teardown, offered when ready.** The driver is loaded on every
  Linux host, so teardown and restart reconciliation can reap its desktops
  after its programs were removed. It is effective, and so leasable and
  reported as a destination, only when readiness reported ready as the host
  started; a host that installs the programs later offers it after its next
  start. Off Linux nothing is loaded.
- **What `gone` means.** Bubblewrap's `--die-with-parent` ends a desktop with
  the host process. `inspect` answers `gone` only when the launch's process
  group, every process in the desktop's own PID namespace, its receipt, and its
  lease directory are absent. The namespace and the tag a desktop was made
  under are recorded in its lease directory beside `home` and `inbox`, never
  inside them, so the desktop cannot rewrite what the host trusts to find and
  reap it. The namespace is recorded with its init's PID, start time, and boot,
  and counts as the desktop's only while that init runs: namespace numbers are
  reused once freed (one recurred many times over 300 Bubblewrap launches), so
  a number alone could make `stop` kill, or wait forever on, another program's
  processes after a crash or reboot. The kernel kills every process in a PID
  namespace before its init exits. `stop` opens up directories a desktop made unwritable before it
  deletes them.
- **No clock of its own.** A host-local desktop does not bill and has no
  provider-side expiry. `extend` succeeds while it is running and fails once it
  is not; the host's lease clock and its death with the host end it.
- **Frames and input are bounded.** A frame's PNG header is read before
  anything else, and a frame wider or taller than the screen is refused. A
  reply line over 64 bytes, a frame over the screen's uncompressed size, a
  reply nobody asked for (only the desktop's first `ready` line may arrive
  unasked, and a frame's buffer is allocated only for a waiting request), or a
  request unanswered for 10 seconds breaks the channel for good. Pointer input outside the screen and keys outside a closed
  keysym map refuse; typed text crosses as base64.
- **Control refuses.** Every `octant_computer` command refuses `unsupported`
  until slice 4 binds agent control. `deliver` refused too until
  [slice 3](#built-in-slice-3) gave it the launch port's inbox write.
- **A cancelled acquisition records its cause.** When a lease ends while its
  provider is creating it and the driver honours the cancellation, the
  `failed` transition carries the end reason and who asked.

A real-`bwrap` suite (`hostLocalDesktopProcess.test.ts`) proves the capsule
cannot read the checkout, home, keyring, or session bus, has no `OCTANT_*`,
SSH agent, or bus address in its environment, and cannot connect to host
loopback; that release and a restarted host's reconciliation leave no process
in the desktop's namespace and no lease directory; and that the driver passes
the conformance suite over the real launch port. Its desktop tests need
`Xvfb`, `xdotool`, and ImageMagick and skip on a host without them.

### Built in slice 3

- **Contract.** `desktop.artifact-sent@1` on the `desktop-lease` aggregate
  carries the lease, owner, provider, the root-relative path, the base name,
  the size, and the SHA-256, never the contents.
  `DesktopArtifactRefusalReason` names why a file is not read: `no-root`,
  `path-invalid`, `path-absolute`, `path-escapes-root`, `path-in-git`,
  `path-symlink`, `not-found`, `not-a-file`, `too-large`,
  `changed-while-read`, `path-unverifiable`, and `transfer-in-progress`.
  Authority refusals stay the lease's own closed set.
- **Policy.** `decideDesktopArtifactPath` and `decideDesktopArtifactTransfer`
  in `packages/domain/src/desktopLeasePolicy.ts`.
- **Seam.** `DesktopLaunchPort.deliver` writes one file into a running
  desktop's inbox; the host-local driver's `deliver` uses it while its
  desktop runs and fails `not-running` otherwise.
- **Host.** `transfer` on the lease service, with the read in
  `apps/server/src/computerUse/desktopArtifactRead.ts`. The wiring resolves
  the thread's root; the slice 1 placeholders stay, so no caller may open a
  thread and every transfer confirmation declines until slices 4 and 5 bring
  their callers.

Rules this slice resolved:

- **Read once, before asking.** The host reads and hashes the file before
  anyone is asked. Those bytes are what the person approves, what the journal
  records, and what the driver receives; a file changed while a person decides
  is not re-read. After the answer, in the lease's order, the host checks the
  lease's authority again, and a changed provider, posture, or root refuses
  `declined`.
- **Size limit 128 MiB, one transfer per lease.** The host holds the bytes
  from the read to delivery, so the bound is a memory bound. An Electron
  AppImage fits; a larger file refuses `too-large`. A transfer can wait on a
  person indefinitely, so a lease holds one transfer at a time and a second
  refuses `transfer-in-progress`; the bytes held are then bounded by the lease
  caps rather than by how many calls arrive at once.
- **Nothing is followed.** A symlink refuses at any component, even one whose
  target is inside the root, and any `..` refuses, even one that lands back
  inside. `.git` matches without case, because a case-insensitive volume opens
  `.GIT` as the same directory. The canonical path must be the root joined
  with exactly the path's components. The file is opened with no-follow and
  non-blocking, must be the object the walk saw, and is read for exactly its
  size plus one probe byte; a handle whose size, modification, or change time
  moved during the read refuses `changed-while-read`.
- **The open handle names where it landed.** Every path check and the open
  resolve the path afresh, and no-follow guards only the last component. An
  agent flipping an ancestor directory between a real directory and a link to
  a host folder won that race about once in two hundred reads before this
  rule: the walk's last step and the open reached the host file while the
  checks between them saw the checkout. So the path the kernel gives the open
  handle (`/proc/self/fd`) must be the walked path, or the read refuses
  `changed-while-read`. Node has no such query on macOS, so a read there
  refuses `path-unverifiable`; no desktop provider runs on macOS yet, and one
  that does needs a handle-path check there first.
- **Hard links are accepted.** A file with more than one name is sent. Only
  something that already reaches a file can link it into the checkout, and it
  could as well copy it there; Cargo links its build outputs, so refusing
  would block Rust builds without protecting anything.
- **Journaled before the bytes leave.** `desktop.artifact-sent@1` is written
  with the caller as actor before the driver is called, so a transfer cut off
  midway is still on record. The result says `delivered` or `not-delivered`.
  The send runs in the lease's order and is bounded at 60 seconds like a
  teardown call, so a driver that never answers cannot hold a release behind
  it.
- **Who is asked.** Plan refuses. Below Full access an agent's transfer asks
  in the thread, auto-accept-edits included: that posture covers edits to the
  checkout, not sending a file out of it. Full access proceeds to a host-local
  desktop unless the agent's thread has read outside content
  ([slice 4](#built-in-slice-4)), and a person sending a file to one is not
  asked again. A transfer
  to a cloud desktop asks a person every time (`off-machine`).
- **Where it lands.** The file is written whole beside the lease's `home` and
  `inbox`, made read-only (`0444`), and renamed into the inbox under its base
  name, so the desktop never sees a partial file and a later transfer under
  the same name replaces the earlier one. It carries no execute bit; how a
  transferred app is launched is slice 4's to settle.
- **The root.** A Code thread's root is its checkout: its managed worktree,
  or the Project root it works in place. A Work thread's root is its Project
  root. Either counts only while the thread is bound to its Project's current
  revision and the checkout is available; otherwise the transfer refuses
  `no-root`.

Evidence: `desktopLeaseService.test.ts` covers the journaled path, size, and
hash, every path refusal, Plan, approval-gated asking, the cloud ask, the
approved bytes winning over a file changed during the answer, and authority
changes during the answer. `desktopArtifactRead.test.ts` covers files that
grow or shrink during the read, an ancestor swapped for a link between the
checks and the open, and the platform that cannot name the open file;
`desktopLeaseService.test.ts` also covers a second transfer while one waits,
and a root change while the transfer waits in the lease's order. Under real Bubblewrap,
`hostLocalDesktopProcess.test.ts` shows the delivered file is read-only
inside the capsule and cannot be removed, that the port refuses names that
leave the inbox and leases with no running desktop, and that a transfer
through the lease service lands in a running desktop's inbox.

### Built in slice 4

- **Contract.** `ComputerUseDestinationSelection` in
  `packages/contracts/src/desktopLease.ts`, a `desktop-lease` kind and a
  lease id, is a send's
  destination: `computerUseDestination` beside `computerUseSelection` on a
  Code turn's `start-provider-turn` and on a queued Code message.
  `ComputerUseOwner` carries the bound `leaseId`. `type` and `press` gain a
  keyboard-focus form with no `elementIndex`. `ComputerSendFileCommand`
  (`send-file` with a checkout-relative `path`) and the `sent` result carry an
  agent's transfer. `desktop.operated@1` on the `desktop-lease` aggregate
  records one input (`launch`, `click`, `type`, `press`, or `scroll`) with
  its operator as actor and the app a launch started, never the text or key.
- **Seam.** `ComputerUseHostPort.disposableDesktop.sendFile` in
  `packages/plugin-api/src/computerUse.ts`, present only for a send bound to
  a lease. The bundled Computer use plugin then offers the desktop form of
  `octant_computer`, with `send-file`.
- **Host.** `apps/server/src/computerUse/computerUseToolService.ts` binds the
  turn's tool to the send's destination; `createLeasedComputerUsePort` in
  `desktopLeaseService.ts` reaches the lease as the owner's agent. The lease
  service's `control` runs in the lease's order, bounded like a teardown call,
  and journals input before the driver gets it; `transfer` takes the caller's
  own confirmation. The Code runtime carries the destination from the send to
  the turn's tool set with the thread's own approval prompt.
- **Driver.** `apps/server/src/plugins/hostLocalDesktop/hostLocalDesktopControl.ts`
  translates the command set onto the screen and two more protocol lines,
  `launch NAME` and `alive PID`. Readiness also requires `mkdir`, `rm`, `cp`,
  and `chmod`.
- **Wiring.** An agent caller may open its own thread's lease while it is the
  thread's current provider. A person's authority came with the Desktop pane
  ([slice 5](#built-in-slice-5)). Acquire confirmation still declines for
  every caller.

Rules this slice resolved:

- **One destination per send, named by lease id.** `computerUseDestination`
  is valid only beside `computerUseSelection`; alone, it fails the turn's
  start. Absent, the destination is this Mac. At admission the host binds
  only a lease that is the sending thread's own and `ready`, or the turn does
  not start; every command then goes through the lease service, which checks
  the lease's authority again. Only Code turns carry a destination; a Work
  turn cannot name a lease yet (the later Work-mode item).
- **An agent neither acquires nor releases.** A send binds a lease that
  already exists, so this slice gives the agent no acquire, extend, or
  release: acquiring is an effect with its own approval and billing rules,
  and binding needs nothing from it. With no recipe storage and no Desktop
  pane, a running host holds no lease to bind yet.
- **What an app is.** An app is a file the host sent into the lease's inbox,
  and its `appId` is the file name; a name the command set cannot carry
  (one with a space, say) is not offered. `launch` copies the file from the
  read-only inbox into the desktop's private home, makes the copy executable
  by the desktop's user only, and runs it detached, so nothing in the inbox
  ever executes. An app has one window, the whole screen (`windowId` 1),
  while its process runs; a command for an app that exited refuses
  `app-not-running`.
- **Observations are screenshots.** An observation is the whole screen as
  PNG with no elements. `click` takes `x` and `y` on it; `type` and `press`
  go to keyboard focus, which a click sets; a command addressed to an element
  refuses `unsupported`. Each action returns a fresh screenshot. Rejected:
  inventing one "focus" element so the existing element forms could carry
  text, which would make an observation claim an element the screen does not
  have. This Mac refuses the keyboard-focus forms (`unsupported`) in the tool
  service and again in its driver, because there they would skip the
  text-field and protected-field checks an element gets. Sensitive-field
  protection applies to what a destination reports; a host-local desktop
  reports no fields and holds nothing of the host's.
- **`needs-image-model`.** On a lease, a model whose inputs do not include
  images is refused `needs-image-model` for every command but `stop`, and for
  `send-file`, before anything is asked or sent.
- **Approvals are asked in the thread.** Per-app approval keeps the existing
  rules: a five-minute app grant, one action at a time once the thread is
  tainted, and Plan refuses. A desktop's approval is also asked in the
  thread, where any client that may open the thread can answer it
  ([decision 3](#maintainer-decisions)); the first answer, there or on a
  local approval card, decides and withdraws the other. This Mac's approvals
  stay local. An agent's transfer asks in the thread, with its path, size,
  SHA-256, and destination, below Full access; a cloud desktop asks every
  time. The posture is the turn's, which may sit below the thread's, so a
  turn sent at approval-gated on a Full access thread asks. Once the thread
  has read outside content, an agent's transfer asks under Full access too:
  `send-file` is a Computer use action, and taint stops standing approvals,
  which Full access is. An app grant is for the file a name held when the
  person allowed it: a `send-file` of that name ends every grant for the
  name on that lease when it starts and again when it settles, whatever its
  outcome, so the next launch asks. Rejected: keeping the grant when the
  hash matches, since a send cut off midway may still have replaced the file.
- **Agent input is journaled.** `desktop.operated@1` is written before the
  driver gets the input, with the agent as actor. Reading the screen (apps,
  windows, observe) is not journaled, and typed text and keys never are.
  Results taint the thread like any Computer use result.
- **Stop leaves the lease.** `stop` ends the task's Computer use sessions and
  grants; the desktop keeps running until its lease ends.

Evidence: under real Bubblewrap with `Xvfb`, `xdotool`, ImageMagick, and
`xev`, `hostLocalDesktopProcess.test.ts` runs a scripted agent turn through
the tool service, the agent's lease port, the lease service, and the
host-local driver: `send-file` asks in the thread and delivers, `launch` asks
for the app and starts the sent file, an observation returns a screenshot,
and the app's own event log shows the click, each typed key, and Enter. The
journal holds `desktop.artifact-sent@1` and `launch`, `click`, `type`, and
`press` inputs, all with actor `agent` and none with the typed text, and the
conformance suite still passes over the real launch port, refusing an
element-addressed click as `unsupported`. `computerUseToolService.test.ts`
covers binding, the approval asked in the thread, the first of the thread's
and the local card's answers withdrawing the other, the one-action rule under
taint, Plan refusal, `needs-image-model`, the transfer question, a resent
file's name ending its app grant, and this Mac
refusing keyboard-focus input; `desktopLeaseService.test.ts` covers the
journaled input, the caller's own confirmation, and a transfer asked at the
turn's lower posture or under taint; `codeOperationRuntime.test.ts`
covers a destination reaching the turn's tool set and its approval in the
thread. `computerUseRuntime.test.ts` and the earlier tool-service tests pass.
Owed by the maintainer: a real-provider smoke, a turn on a provider
credential's image-capable model driving a leased desktop through
`octant_computer`. The smoke sets the Project's recipe in its settings
([recipe storage](#built-recipe-storage)) and starts the desktop from the
Desktop tab.

### Built in slice 5

- **Contract.** `packages/contracts/src/desktopLease.ts`: `DesktopViewId`,
  `DesktopPaneRequest` (`overview`, `acquire`, `release`, `retry-release`,
  `extend`, `open-view`, `close-view`, `input`), `DesktopFrameRequest`,
  `DesktopPaneAnswer`, and the view refusals `view-ended` and `view-limit`.
  No request names a person: the host takes the person from the
  authenticated principal.
- **Policy.** `desktopInputOperation` in
  `packages/domain/src/desktopLeasePolicy.ts`, and the remote action
  `code.desktop.operate` in `packages/domain/src/remoteAccessPolicy.ts`
  ([decision 3](#maintainer-decisions)).
- **Host.** The lease service's `overview`, `openView`, `frame`, `input`, and
  `closeView`, and `apps/server/src/desktopPaneRoutes.ts` at
  `/api/code/desktops` and `/api/code/desktops/frame`, wired in
  `apps/server/src/wiring/computerUse.ts`. A local window is `local-user`, a
  paired device is `remote-device`, and `callerMayOpen` judges the window or
  device the request came from.
- **Client and pane.** `packages/client-runtime/src/desktopPaneClient.ts`, and
  the Code dock's **Desktop** tool (`apps/web/src/desktop/`,
  `apps/web/src/dockModules/DesktopModule.tsx`) with the states setup,
  acquiring, live, interrupted, releasing, release-failed, and ended, plus
  not-shown for a running desktop the tab is not showing
  ([Workspace](workspace.md#tool-lifecycles)). Setup and ended offer Start
  only when the overview says the thread may start one; otherwise they say
  why, as for a thread in Plan.

Rules this slice resolved:

- **A view is host memory, minted by a person's act.** A tab shows a screen
  only through a view the host mints when the person starts a desktop in that
  tab or presses **Show desktop**. Views are never journaled or persisted, so
  a reloaded window and a restarted host hold none. A tab restored from a
  saved layout, or reloaded, shows a running desktop as not shown and opens
  nothing until the person asks; a desktop the restart ended shows as ended,
  says why, and never reconnects. The pane keeps no lease id across a reload,
  so it cannot rebind; it reads the thread's leases afresh. A view belongs to
  the person, window, or device that opened it, and a frame or input naming
  it from anywhere else refuses `view-ended`.
- **Frames are polled one at a time through the host.** Each frame is its own
  request, so every frame is authorized like a screenshot: the lease service
  re-checks the thread, the caller's window or device, the recipe, the
  driver, and the Computer use setting before reading it, and nothing is
  stored. A held stream would have needed its own re-check loop. A tab reads
  about four frames a second while its window shows and one every ten seconds
  while hidden.
- **A frame is bounded before anyone decodes it.** The host passes on a frame
  only when its declared size fits the recipe's screen, its bytes fit that
  screen uncompressed, and it is the image it claims to be: a PNG's own
  header, or a JPEG's first frame header, must name the declared size, and
  any other media type is refused. Otherwise the answer is `no-frame` and the
  view stays open.
- **A view lapses after 30 seconds unread.** An open view holds idle release
  off, as an open tab does; a window that went away without closing its tab
  stops holding it after 30 seconds. Views per lease are capped at four
  (`view-limit`). Ending a lease ends its views.
- **What a person's input journals.** `desktop.operated@1` with the person as
  actor and no approval, written before the driver gets the input, in the
  lease's order: a button press (`click`), a key going down (`press`), typed
  text (`type`), and a scroll (`scroll`). Pointer moves and releases are sent
  and not journaled: they change nothing alone and would write a row per
  pointer frame. The pane gathers typed characters into one `text` input and
  wheel movement into one scroll per tenth of a second. Input counts as an
  operator acting for idle release.
- **Who may open a thread from the pane.** A local window must be live and
  hold the thread's Code Project; a paired device reaches the thread of any
  active Code Project, as for other Code reads ([decision 3](#maintainer-decisions)).
  Only Code threads have a Desktop tab.
- **A person's acquire.** A person starting a host-local desktop is not asked
  again (Plan still refuses). A billed lease declined here until the person's
  billed confirmation arrived with the cloud providers
  ([slice 6](#built-in-slice-6)).
- **The pane offers Start only when acquire would not refuse at once.** The
  overview's `start` carries every refusal acquire meets before it asks the
  provider, Plan's `plan-mode` included, so a thread in Plan shows why it
  cannot start a desktop in the setup and ended states and offers no Start.
  Acquire still refuses on its own; the overview only spares the person a
  button that would refuse once pressed. Whether the provider is ready is
  still learned only by acquiring.
- **The pane sends no file.** Transfer stays the agent's `send-file` and the
  lease service's own path; the pane offers no transfer, so it adds no route
  that could replace a file an app grant was given for.
- **Release asks the person first.** Release destroys the desktop and its
  contents, so the pane confirms it; Retry and extension do not ask. Extension
  adds up to 30 minutes at a time, never past the recipe maximum.

Evidence: `desktopLeaseService.test.ts` covers a person's view and input
journaled as `local-user` and `remote-device` with nothing asked, views
refused to another thread, an agent, and a window that may not open the
thread, a view kept to its window and gone after a restart that ended its
lease, idle release held while a view is read and resumed once it lapses,
views ended by closing and by release, the view cap, frame bounds, and the
overview's start and refusals, Plan's included. `desktopPaneRoutes.test.ts` covers the actor
taken from a local window and a paired device, refusals of a request that
names a window or actor, and a frame answered as the image.
`hostLocalDesktopProcess.test.ts` drives a real Bubblewrap and `Xvfb` desktop
through a person's view: a frame, then a click, text, and Enter that reach an
`xev` window, journaled as `local-user`. `DesktopPane.test.tsx` covers the
setup state with no recipe, a thread in Plan with no Start in the setup and
ended states, Start to live with a click sent, a running desktop
not reconnected on mount, a desktop ended by restart, Retry, and an
interrupted view. Rendered QA ran the pane in a headless browser at a desktop
and a narrow width in both themes, its live state against a real host-local
desktop through the real route with a development recipe supplied by the QA
fixture, since no recipe storage exists.

### Built: recipe storage

Not one of the numbered slices: the Project-side half of the model's
**Recipe**, delivered after slice 5 so a shipped host can lease at all.

- **Contract.** `packages/contracts/src/projects.ts`: `desktopRecipe` on the
  Code Project record and its summary (a `DesktopRecipe`, absent when none),
  the command `change-code-project-desktop-recipe` (`recipe: null` removes
  it), its result, and the event `project.code-desktop-recipe-changed@1`,
  which carries the whole Project as every Project event does. The Desktop
  pane request `recipe-providers` answers the providers a recipe may name.
- **Policy.** `changeCodeProjectDesktopRecipe` in
  `packages/domain/src/projectPolicy.ts`.
- **Host.** `ProjectService` journals the event; the Project projection
  stores it with the rest of the Project, so it rebuilds from the journal
  like any other Project field. `apps/server/src/computerUse/projectDesktopRecipe.ts`
  is the lease service's recipe lookup, wired in
  `apps/server/src/wiring/computerUse.ts`.
- **Editor.** **Disposable desktop** in a Code Project's settings
  (`apps/web/src/projects/ProjectDesktopRecipeSection.tsx`): provider, screen
  size, how long a desktop lasts, its longest run, and idle time, with Set,
  Save, and Remove.

Rules this delivery resolved:

- **Only a Code Project holds a recipe.** Only Code threads have a Desktop
  tab, so a Work recipe could never start a desktop; Work gets one when Work
  leasing is delivered. A Chat Project never does.
- **Set from a local window; read anywhere the Project is.** Setting or
  removing a recipe chooses what this host runs, so only a local window may:
  the Project route refuses the command from a paired device, which the
  remote route policy already denies a Project command. A paired device sees
  the recipe with the Project, and still watches and operates its desktops
  ([decision 3](#maintainer-decisions)). An agent has no command that
  reaches it.
- **The host validates every save.** The command decodes against
  `DesktopRecipe`, so the screen, lease limits, and provider id are bounded
  and a lease cannot start longer than its maximum. The recipe must name a
  provider the host offers for leasing now (the same list destination
  reporting gives); a host-local recipe cannot allow network
  ([slice 2](#built-in-slice-2)), nor can one on any placement
  ([Built: Cua follow-ups](#built-cua-follow-ups)), while a cloud recipe
  with no placement may, and must name a credential reference
  ([slice 6](#built-in-slice-6)). A save that changes
  nothing, and any change to an archived Project, is refused. Removing is
  always allowed.
- **Read afresh on every lease command.** The lease service asks for the
  recipe on each acquire, operating command, and sweep, from the thread's
  Project as stored now. A new screen size or limit applies to the next
  desktop; a running desktop's frames stay bounded by the screen it was
  acquired with, so shrinking the recipe does not blank it and growing it
  does not let its driver pass a larger frame. Removing the recipe, changing its provider or credential
  reference, or archiving the Project ends the Project's running desktops at
  the next sweep as `recipe-removed`, through the teardown path that outlives
  revocation.
- **What the editor offers.** It lists only the providers the host answers
  for `recipe-providers`; a saved provider the host no longer offers is shown
  as not available and cannot be saved again. Screen sizes and the three
  lease limits are choices from short preset lists, each inside the
  four-hour bound, and a saved value off a list is offered too, so opening
  the editor never changes a recipe by itself. A new recipe starts from
  decision 4's limits: a 30-minute lease, four hours at most, idle after
  15 minutes. Network is always none. Image and credential reference are for
  a cloud provider and are not editable until a host offers one (slice 6
  builds E2B but offers it nowhere yet); a save keeps the ones already stored
  for the same provider. Remove asks first,
  because it destroys running desktops.

Evidence: `projectDesktopRecipe.test.ts` saves a recipe through
`ProjectService` on a real journal, restarts the host, acquires a lease from
the stored recipe with the recipe's limits and screen reaching the driver,
then removes the recipe and sees the sweep release the desktop as
`recipe-removed` and the next start refused `no-provider-configured`; it also
refuses a provider the host does not offer. Before the lookup existed the
same acquire was refused `no-provider-configured`. `projectService.test.ts`
refuses recipes the schema refuses and journals nothing while the host
offers the provider; `desktopLeaseService.test.ts` keeps a running desktop's
frames bounded by its own screen after the recipe's screen changes;
`projectPolicy.test.ts` covers set, replace, remove, the provider and network
refusals, a cloud recipe kept only with a credential, Work and Chat Projects,
and no-ops; `projectRoutes.test.ts` refuses
a paired device's change and keeps a local window's; `desktopPaneRoutes.test.ts`
lists the offered providers; `ProjectDesktopRecipeSection.test.tsx` sets a
recipe on an offered provider, keeps an unavailable saved provider from being
saved, removes after asking, and offers nothing when the host offers no
provider. Rendered QA ran the editor in a Project overview in a headless
browser, light and dark, at 1280 and 390 pixels wide, for a new recipe set on
the host's provider, a saved recipe, a saved provider the host no longer
offers, and a host that offers none, with no console error and no horizontal
overflow.

### Built in slice 6

Slice 6 lands the shared cloud pieces with the E2B driver. The Cua Spaces
driver is not built; why is recorded at the end of this section.

- **Seam.** `DesktopHttpsPort` and `desktopProviderHostDeclared` in
  `packages/plugin-api/src/desktopProvider.ts`; `DesktopProvider.hosts`;
  `DesktopHandle.credentialRef`; `listOwned(hostTag, credentialRef)`. The
  conformance suite's fixture may name `restarted`, a second driver over the
  same provider, and a billed driver must. The screenshot-only control the
  host-local driver had (`ScreenshotDesktopControl`), with `x11Keysym`,
  `pngDimensions`, and `maxDesktopFrameBytes`, moved into the seam
  (`desktopScreenshotControl.ts`) so every screen-only driver translates
  `octant_computer` the same way.
- **Host.** `apps/server/src/computerUse/desktopHttpsPort.ts` is the port.
  The lease service lists each account a provider's leases recorded, refuses
  a cloud recipe that names no credential, and takes a person's billed
  confirmation from their request. The broker gains the
  `/v1/desktop-provider-credentials/*` namespace (Keychain service and Secret
  Service attribute `desktop-provider-credentials.v1`), and the wiring reads
  keys from it.
- **Contract.** The pane's `acquire` carries the provider the person
  confirmed (`confirmedProvider`, named `confirmedBilledProvider` until
  [Cua sub-slice 3](#built-in-cua-sub-slice-3) added its placement).
- **Driver.** `apps/server/src/plugins/e2bDesktop/`: the `e2b` provider and
  its in-sandbox process and file calls. It imports only `@octant/contracts`
  and the seam, and has no network of its own; a test enforces both.
- **Pane.** Start on a billed provider asks the person first, naming the
  provider, and sends that provider with the acquire.
- **Smoke.** `apps/server/src/computerUse/cloudDesktop.smoke.ts`
  (`bun run desktop:cloud:smoke`), the maintainer's live run.

Rules this slice resolved:

- **The HTTPS port decides where anything goes.** A call reaches only HTTPS,
  on the default port, with no credentials in the URL, to a host the driver
  declares (`*.example.com` matches subdomains only). It never follows a
  redirect, refuses headers the transport or another identity owns (`Host`,
  `Content-Length`, `Cookie`, and the like), and is bounded at 45 seconds,
  129 MiB out (a transfer's largest file), and the response size the driver
  names, capped at one uncompressed frame of the largest screen. The host
  checks the URL before it reads any key.
- **A key goes only where one of the provider's leases recorded it.** The
  driver names a credential reference and the header its provider reads; the
  host attaches the key only when a journaled lease of that provider recorded
  that reference. Journal-before-create records it before the first call, so
  teardown after revocation still reaches the account, and a driver can never
  name another provider's key. The key never reaches the driver.
- **Desktop keys have their own broker namespace.** A recipe's credential
  reference names a key in `/v1/desktop-provider-credentials/*`, apart from
  model providers' keys, so neither can stand in for the other. A host with
  no broker attaches no key. No editor enters a key yet; that arrives with
  the person's opt-in to a billed provider.
- **A cloud recipe must name a credential.** A recipe for a cloud provider
  with no credential reference configures nothing that could run: the lease
  service refuses it `no-provider-configured` before any provider call, and
  the recipe store refuses to save it
  ([recipe storage](#built-recipe-storage)). Since
  [Cua sub-slice 2](#built-in-cua-sub-slice-2) a placement of a provider
  whose daemon holds the person's sign-in stands in for the credential (C4).
- **Restart lists account by account.** Reconciliation lists each provider
  once with no credential and once per credential reference any of its leases
  recorded, and destroys tagged desktops that have no live lease. A listing
  that fails for one account skips only that account's orphans; each
  unreleased lease is still destroyed through its own account's listing.
- **A person's billed confirmation is theirs.** A person confirms a billed
  desktop in their own tab, which names the provider they saw
  (`confirmedProvider`); the host starts a person's billed lease only
  with it and only for that provider, re-checking authority, provider, and
  posture before the call. No other answer stands in for it. An agent still
  acquires nothing.
- **Loaded for teardown, offered after the person opts in.** The E2B driver
  is loaded on every host, so teardown and restart reconciliation reach any
  E2B lease a host ever journaled. It is not effective: no host offers it for
  leasing, reports it as a destination, or lets a recipe name it until the
  person can choose it and enter its key. A billed provider is never on by
  default.
- **E2B.** The control plane is `api.e2b.app` with the key in `X-API-Key`.
  A desktop is a sandbox created from the recipe's template (E2B's public
  `desktop` template when it names none) through `POST /v2/sandboxes` with the
  lease id as its `Idempotency-Key`, `octantLease` and `octantHost` metadata,
  E2B's timeout set to the lease expiry plus two minutes, `autoPause` off,
  internet only when the recipe allows it, and no public traffic to its
  ports. E2B's own `endAt` is the provider-side expiry; an extension sets the
  timeout again and counts only when the `endAt` E2B then reports reaches
  the new expiry, since a plan may hold a sandbox below what was asked.
  Release is `DELETE` (204, or 404 for one already gone); only a `GET` that
  answers 404 is gone, and a paused sandbox is present. A listing filters by
  `octantHost` over running and paused sandboxes, reads at most 20 pages, and
  past that answers `failed`. The screen, input, and files go through the
  sandbox's own daemon at `sandbox.e2b.app` with the sandbox's own token,
  which stays in the driver's memory and is never journaled; the person's key
  never goes there. A sandbox E2B reports on another domain is destroyed and
  the acquire fails. Inside, the driver starts `Xvfb` at the recipe's size, as
  E2B's desktop SDK does, takes frames with `scrot`, sends input as `xdotool`
  argument lists with no shell, lands a sent file read-only in
  `/home/user/inbox` through a staging file, and launches a copy as host-local
  does.
- **A cloud recipe may allow the network.** A cloud desktop is a VM with its
  own network and never shares the host's, so decision 5's per-recipe
  `allow` applies to it as written; `none` turns the sandbox's internet off.

Evidence: `e2bDesktopProvider.test.ts` runs the conformance suite, restart
included, against a recorded E2B (`e2bRecordedApi.test-support.ts`, built
from E2B's published OpenAPI documents and its SDK's envd transport) through
the host's real HTTPS port, and covers the tagged create with E2B's timeout
past the lease expiry, the key reaching only `api.e2b.app`, frames and a
person's input as argument lists, a sent file landing in the inbox and
launching, an extension E2B holds short refused, a sandbox on another domain
destroyed, paged listing by host, a rejected key, and the import boundary. Through
the lease service over a journal on disk, a host killed with a lease
`ready`, and one killed while E2B was still creating it, each find the
sandbox by its tag on the next start and destroy it. `desktopHttpsPort.test.ts`
covers undeclared hosts, plain HTTP, ports and URL credentials refused before
any key is read, a credential no lease recorded, host-owned headers,
redirects, response bounds, time-outs, and cancellation.
`desktopLeaseService.test.ts` covers a person's billed confirmation for the
right provider only, a cloud recipe with no credential, and a killed host's
cloud desktops found through each lease's account. The conformance tests cover
the restart check and its refusals, `DesktopPane.test.tsx` the billed
confirmation, and `credentialBroker.test.ts` the new namespace's isolation.
The real-`bwrap` host-local suite passes over the moved screenshot control.

Owed by the maintainer, for E2B: an E2B account with billing, an API key, and
`bun run desktop:cloud:smoke e2b run`, then `… e2b kill` followed by
`… e2b restart`, from `apps/server`, each with the key piped on standard input
(`read -rs KEY; printf %s "$KEY" | bun run desktop:cloud:smoke e2b run`). Each
run must end `PASS`, and the E2B dashboard must then list no sandbox with
`octantHost` metadata. The live run is also what confirms what a recording
cannot: that envd answers the process service in Connect's JSON codec, that
`Xvfb` and a launched app outlive the command that started them, that the
`desktop` template carries `Xvfb`, `xdpyinfo`, `scrot`, `xdotool`, and
`setsid`, that a killed sandbox answers 404 at once, and how the account's
plan caps an extension.

**Cua Spaces is blocked on a design decision.** Cua's own documentation
(read 2026-10-27 from its public repository) gives no endpoint a host can call
over HTTPS with a stored key. Cua's hosted cloud, the only such API, ended on
18 October 2026. A Space is now created, listed, given a lifetime
(`set_lifetime`), and deleted through the local `cua daemon` on the person's
own machine, over gRPC on a Unix socket (`cua.daemon.v1.SpaceService`). That
daemon runs Spaces on the machine itself, on the person's other machines, or
in their own AWS, Google Cloud, or Azure account (linked by OIDC, with no
stored key) or Hetzner or Modal account (a token Cua seals to their devices).
The screen, input, and files go through `cua-spacesd` (gRPC or gRPC-Web on
port 3211, with a per-Space bearer token) and Cua's relay. So the shared
pieces above do not fit it: there are no declared hosts or API-key header for
`DesktopHttpsPort`, and no key for the desktop-provider namespace. A Cua
driver needs a seam port for a provider's local daemon (reached confined, the
way `DesktopLaunchPort` reaches a capsule), a rule for whose cloud
credentials that daemon uses, and whether its own lifetime and `cua-expires`
tag satisfy provider-side expiry when the daemon's host is the one that may
die. The maintainer accepted those decisions on 2026-10-27 in
[Cua Spaces through the local daemon](#cua-spaces-through-the-local-daemon).

## Cua Spaces through the local daemon

**Status: accepted by the maintainer on 2026-10-27, every decision as
recommended.** Cua is delivered first for this machine's placement, then the
person's other machines; billed cloud placements wait for C5's condition. Cua
ships on Linux hosts first; on macOS, transfer stays refused until its own
handle-path check exists. The decisions below are rules; the sub-slices under
[Delivery sub-slices](#delivery-sub-slices) are the delivery plan, each its own
change with this section updated in place. Sub-slice 1, the daemon port, is
built ([Built in Cua sub-slice 1](#built-in-cua-sub-slice-1)), and so is
sub-slice 2, the driver for a Space on this machine
([Built in Cua sub-slice 2](#built-in-cua-sub-slice-2)), and sub-slice 3,
the person's other machines
([Built in Cua sub-slice 3](#built-in-cua-sub-slice-3)); no host offers it
until the maintainer's live smokes pass.

### What Cua offers now

Read on 2026-10-27 from Cua's public repository at commit `8fbdf83`
([trycua/cua](https://github.com/trycua/cua/tree/8fbdf83c1e05bf0a8b84a6199fe697cc58f0e24f)).
Cua's documentation site (`cua.ai/docs`) did not resolve from the
environment this was written in, so every fact below comes from the
repository's own documentation sources, its `.proto` files, and its daemon
source, and is cited with the file it came from.

- **Cua Cloud ended on 18 October 2026.** `on="cloud"` and Cua's hosted
  pools fail with a message that says so; the replacements are a local
  sandbox, the person's own AWS, Google Cloud, or Modal account, or a
  machine the person runs
  ([migration page](https://github.com/trycua/cua/blob/8fbdf83c1e05bf0a8b84a6199fe697cc58f0e24f/docs/content/docs/cua-sdk/guides/cua-cloud-ended.mdx)).
  `cua-computer-server` is no longer maintained; the in-guest agent is
  `cua-spacesd`.
- **The daemon.** `cua daemon start` listens on a Unix socket (default
  `~/.cua/cua.sock`) and on a loopback TCP port with a bearer token
  ([CLI reference](https://github.com/trycua/cua/blob/8fbdf83c1e05bf0a8b84a6199fe697cc58f0e24f/docs/content/docs/cua-cli/reference/cli/account-and-setup.mdx)).
  The daemon sets the socket to mode `0600` and asks no token on it; it
  serves native gRPC (h2c) and gRPC-Web over HTTP/1.1 on the same listener,
  and trusts the caller headers `x-cua-host-caller` and `x-cua-share-caller`
  only on the socket
  ([`server.rs`](https://github.com/trycua/cua/blob/8fbdf83c1e05bf0a8b84a6199fe697cc58f0e24f/libs/cua/crates/cua-daemon/src/server.rs)).
  The socket also serves everything else the daemon does: sharing links,
  linking clouds and setting budgets (through `CallSpaceTool`), batch runs,
  and `DaemonService.Shutdown`.
- **`cua.daemon.v1.SpaceService`** (33 RPCs, protocol docs version 0.9.0;
  [reference](https://github.com/trycua/cua/blob/8fbdf83c1e05bf0a8b84a6199fe697cc58f0e24f/docs/content/docs/cua-sdk/reference/protocol/daemon-spaces.mdx),
  [`spaces.proto`](https://github.com/trycua/cua/blob/8fbdf83c1e05bf0a8b84a6199fe697cc58f0e24f/libs/cua/proto/cua/daemon/v1/spaces.proto)).
  The ones a driver would use: `CreateSpace` (image, `location`, `kind`,
  `runtime`, `labels` up to 64 pairs, `network` `none` for QEMU VMs only,
  `create_id`, `wait`), `CancelCreateSpace` (by `create_id`; idempotent, also
  for a create a daemon restart cut off, and removes what the create made),
  `SetSpaceLifetime` (`duration`, `on_expire` `delete`), `DeleteSpace`,
  `ListSpaces` (each Space with `labels`, `expires_at_unix`, `cloud`,
  `cloud_delete`, `power_state`; without `known_now` the call waits for
  the relay and fails when it cannot be read), `ResolveSpace`,
  `ConnectSpace`, and `GetSpaceRoute`. Errors carry a closed
  `DaemonErrorReason`.
- **The lifetime is the daemon's, not the cloud's.** A Space's lifetime is a
  record on the machine where it is registered, and that machine's daemon
  ends it when it passes
  ([`lifetimes.rs`](https://github.com/trycua/cua/blob/8fbdf83c1e05bf0a8b84a6199fe697cc58f0e24f/libs/cua/crates/cua-spaces/src/lifetimes.rs)).
  Setting it does not change anything in the cloud account.
- **The person's own clouds.** A cloud machine carries Cua's tags, among
  them `cua-expires`, set from the cloud link's time limit
  (`cua cloud connect --ttl-hours`, default 8 hours, `0` for none). AWS and
  Google Cloud machines shut themselves down and are deleted at that limit;
  Modal ends a sandbox at its timeout; a Hetzner server only powers off and
  is billed until a sweep deletes it; Azure cannot end a machine at all. A
  running daemon sweeps expired machines every 15 minutes. AWS, Google
  Cloud, and Azure can be linked with no stored key (Cua's OIDC issuer);
  Hetzner and Modal tokens are sealed to the person's devices. Every cloud
  Space joins `relay.cua.ai` as a machine of the person's Cua account
  ([your cloud](https://github.com/trycua/cua/blob/8fbdf83c1e05bf0a8b84a6199fe697cc58f0e24f/docs/content/docs/cua-sdk/guides/your-cloud.mdx),
  [cleanup](https://github.com/trycua/cua/blob/8fbdf83c1e05bf0a8b84a6199fe697cc58f0e24f/docs/content/docs/cua-sdk/guides/your-cloud-cleanup.mdx)).
  A cloud Space can be deleted only through the device that created it
  (`cloud_delete`), and with a cloud linked, Cua's elastic pool may place
  Spaces on shared cloud hosts that stay until the end of their paid time
  ([Spaces tools](https://github.com/trycua/cua/blob/8fbdf83c1e05bf0a8b84a6199fe697cc58f0e24f/docs/content/docs/spaces/reference/spaces.mdx)).
- **Screen, input, and files.** `ConnectSpace` returns an env passthrough
  (`/v1/spaces/<key>/env`) that speaks `cua.env.v1` with the Space's own
  token attached by the daemon, so a client never holds that token. The
  daemon serves that route on the socket as well as on loopback.
  `cua.env.v1.ComputerService` has `Screenshot` (PNG or JPEG, with a
  `max_dimension`), `Pointer`, and `Keyboard`; `FilesystemService` has a
  unary upload (`BeginUpload`, `UploadChunk`, `CommitUpload`) because
  gRPC-Web cannot carry its client stream; `ProcessService.StartProcess`
  starts a program
  ([protocol index](https://github.com/trycua/cua/blob/8fbdf83c1e05bf0a8b84a6199fe697cc58f0e24f/docs/content/docs/cua-sdk/reference/protocol/index.mdx)).
  No VNC is involved.

Not verified, and left to the live smoke: that a gRPC-Web call through the
env passthrough on the socket reaches `cua-spacesd`; whether `location`
`aws` places a Space on its own machine or on an elastic-pool host; whether
`ListSpaces` without `known_now` answers when the person is not signed in to
Cua; the daemon's largest message; and whether a local QEMU Space's user
networking can reach the host's loopback.

### The local-daemon port

**Decision C1: a generic local-daemon
port.** `@octant/plugin-api/desktop-provider` gains `DesktopDaemonPort`,
"a provider's local control daemon over a Unix socket", beside
`DesktopHttpsPort`. A driver declares in its code one socket path, relative
to the person's home directory (`.cua/cua.sock`), and a closed list of the
method paths it calls (`/cua.daemon.v1.SpaceService/CreateSpace`, and
`/v1/spaces/*/env/cua.env.v1.ComputerService/Screenshot` with one `*`
segment for a value the daemon minted). The host:

- finds the socket only at the declared path under the home of the user
  Octant runs as, and refuses an absolute path, `..`, or an environment
  override;
- `lstat`s every component and refuses a symlink anywhere on the path, a
  socket not owned by Octant's user, a socket with any group or other
  permission bit, and a parent directory another user can write;
- connects only to that socket, never to the daemon's loopback TCP
  listener, and reads no token file;
- sends only declared method paths, as `POST`, with headers the host
  writes itself (the gRPC-Web content type and a deadline) and none from
  the driver, so a driver cannot send a credential or the headers the Cua
  daemon trusts on its socket as a relay-verified caller
  (`x-cua-host-caller`, `x-cua-share-caller`);
- bounds each call at 45 seconds, 4 MiB out, and the response size the
  driver names, capped at one uncompressed frame of the largest screen, as
  the HTTPS port does; and answers every call as a value (`answered` with the
  gRPC status and message bytes; `refused` with `method-not-declared`,
  `socket-unsafe`, `request-too-large`, or `request-invalid`; `failed` with
  `daemon-unreachable`, `timed-out`, or `response-too-large`;
  `cancelled`).

The port is as narrow as the HTTPS port: a driver names where its calls go
in code, the host decides whether they may, and the driver holds no socket
or network object of its own. An outside driver reaches it through the
same strict wire protocol and brokered requests as the HTTPS port. Rejected:
letting the driver open the socket itself (a driver with a raw socket can
call `Shutdown`, create share links, or link a cloud); an allow-list of Cua
service names in the host (a vendor's semantics in a generic port); and
Cua's MCP endpoint (`/mcp`, `CallSpaceTool`), one method that reaches every
Cua tool, so no method list could narrow it.

_Why a home-relative path and owner checks are enough:_ the socket is
`0600` and owned by the person, so any process that can connect already
runs as them. The checks stop Octant from following a symlink to another
user's daemon or a planted socket in a directory someone else controls.
Node has no peer-credential query, so the file's owner and its directory's
writability are what the host can check. A confined tool launch gets no home
directory, so an agent's commands cannot reach the socket.

**Decision C2: gRPC-Web over HTTP/1.1,
no new dependency.** The host frames gRPC-Web itself (a five-byte prefix per
message and a trailer frame) over `node:http` with `socketPath`; the port's own
tests over a real socket are what show Bun's support holds. The seam adds a small protobuf wire reader and writer (varints,
length-delimited fields, fixed widths; no descriptors, no reflection) so a
driver, which imports only `@octant/contracts` and the seam, can encode the
few messages it uses. The Cua driver writes its field numbers by hand from
the published `.proto` files, as the E2B driver was written from E2B's
OpenAPI documents; Octant vendors no `.proto` file and generates no code
from one. Rejected: `@grpc/grpc-js` with `protobufjs` (two dependencies with
their own network stack, larger than what a handful of unary calls need, and a
driver would need them in its imports); `node:http2` h2c over the socket
(no dependency, but Bun's HTTP/2 client is the less-proven path; kept as the
fallback if the live smoke shows the passthrough does not answer gRPC-Web);
and Cua's own SDK (`@trycua/cua`, a native module that embeds Cua's whole
runtime in Octant's process). A create runs with `wait` off and is polled.
The one server stream a driver needs is `ProcessService.StartProcess`, the
only way Cua starts a program in a Space; the port reads such a stream whole
to its status, inside the same bounds, so only a stream the daemon ends on
its own is answered ([Built in Cua sub-slice 1](#built-in-cua-sub-slice-1)).

### Placement, account, and credentials

**Decision C3: placement is per
recipe.** One Cua driver serves several placements with different
consequences: a Space on this machine leaves nothing off it, a Space on the
person's other machine leaves it through Cua's relay, and a Space in their
cloud bills. `locality` and `billed` stay on every driver, and a driver may
also declare a closed list of placements in code, each with its own `id`,
`displayName`, `locality`, and `billed`. A recipe for such a provider names
one placement. The host derives locality and billing from the placement,
journals the placement id in `desktop.lease-requested@1`, applies the
host-local cap, Full access, transfer asking, and billed confirmation from
it, and treats a recipe whose placement changed as removed. The E2B and
host-local drivers declare no placements and are unchanged. Rejected: one
provider id per placement (`cua-local`, `cua-cloud`), which would put one
vendor's account and daemon behind several providers that tear down through
the same socket.

**Decision C4: Octant stores no Cua
credential.** The daemon holds the person's Cua sign-in and their cloud
links; Octant reads none of them, never calls Cua's cloud-linking, budget,
or sharing tools, and never declares those methods. In place of the
credential reference, a daemon-backed recipe names its placement, and a
lease's `requested` event records the provider, the placement, and the
daemon it used (the declared socket path and the user it belongs to), never
a token. Teardown after revocation goes through that same daemon. The
credential broker rule holds unchanged: Octant attaches no secret, so
nothing enters the broker's `/v1/desktop-provider-credentials/*` namespace,
and the rule "a cloud recipe must name a credential" becomes "a cloud recipe
must name a credential or a daemon placement". The billed confirmation
names the provider and the placement ("Cua Spaces · your AWS account"), so
the person confirms where it bills; Octant shows Cua's own place name
(`cloud_place`) once the Space exists, never a cost it cannot verify.
Rejected: reading the daemon's loopback token from `~/.cua/daemon.json`
(a credential Octant would hold for no gain over the socket), and asking
the person for their cloud keys (Cua holds them and would still create the
machine).

### Expiry and teardown when the daemon's host may die

The daemon runs on the same machine as Octant, so the machine that dies is
both. What ends a Space then depends on where it is:

| Placement                  | If this machine stops                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| This machine               | The Space stops with it. On the next start the daemon reaps a passed lifetime, and Octant's restart reconciliation deletes any labelled Space. |
| The person's other machine | The lifetime record is on this machine, so the Space keeps running on the other one until the person deletes it there. Nothing bills.          |
| AWS, Google Cloud          | Runs until the cloud link's time limit (8 hours by default, none if the person set `0`), then deletes itself. Billed until then.               |
| Modal                      | Runs until Modal's timeout (at most 24 hours). Billed until then.                                                                              |
| Hetzner                    | Powers off at the link's time limit but is billed until a later sweep or delete.                                                               |
| Azure                      | Runs and bills until a daemon of the person's sweeps it.                                                                                       |

**Decision C5: offer Cua's billed cloud
placements only when Cua exposes a cloud-side deadline Octant can set and
read.** The daemon's lifetime, and `expires_at_unix` as `ListSpaces`
reports it, is the daemon's own record: it dies with the host and moves
nothing in the cloud. The `cua-expires` tag follows the cloud link's time
limit, which Octant cannot read through any declared method, cannot move on
extension, and the person can set to none. So neither satisfies
"provider-side expiry is mandatory for a billed provider": the host's
billed-expiry check would pass on a number that does not outlive the host. Recommended
first delivery: this machine's placement only, with the person's other
machines next under C6; billed placements wait until Cua's `SetSpaceLifetime`
moves the cloud's own deadline and a listing reports it. Rejected: (a)
counting the daemon's lifetime as provider-side expiry, which is exactly
the guarantee a dead host loses; (b) offering AWS, Google Cloud, and Modal
now with the link's time limit as an unverified backstop the person
acknowledges, because Octant could not check the limit exists and the
promise would rest on a setting it never sees (the maintainer may still choose
this; then Hetzner and Azure stay refused, and the billed confirmation
states the worst case in the table above).

What the person is told, in every case:

- **At acquisition** for a placement off this machine: where it runs, and
  what the table says happens if this machine stops.
- **Daemon down at lease end.** Release calls the daemon; `daemon-unreachable`
  makes the lease `release-failed`, retried with the usual backoff. The
  Desktop tab and Settings say "Cua's daemon is not running on this
  machine; start it (`cua daemon start`) or delete the Space in Cua
  Spaces", with Retry, and new Cua leases are refused until it clears.
  Octant never starts the daemon or runs `cua daemon reap` itself.
- **Daemon down at restart.** Reconciliation's listing fails, so every
  unreleased Cua lease stays `release-failed` and no Cua lease is admitted
  until a listing answers, as for any provider that cannot list.
- **Absence** is confirmed only by a complete listing: `ListSpaces` without
  `known_now`, which waits for the relay and fails rather than answering
  partly, showing no Space labelled with the lease id. Octant confirms the
  Space is gone as the person's daemon reports it; it cannot see the cloud
  account or a pool host Cua keeps until the end of its paid time.

### Screen, input, and files

**Decision C6: everything through the
daemon's socket; no declared hosts.** The driver calls `ConnectSpace`, keeps
the passthrough key in memory (never journaled), and sends `cua.env.v1`
calls through `/v1/spaces/<key>/env/...` on the same socket: frames are
`ComputerService.Screenshot` as PNG at the recipe's screen size, input is
`Pointer` and `Keyboard`, a sent file goes in through the unary upload to a
staging name and is made read-only in `/home/user/inbox` (the path the E2B
driver uses), and `launch` copies and starts it with
`ProcessService.StartProcess` as an argument list, as host-local does. The
Space's own token stays in the daemon and the driver needs no network host,
so `hosts` stays empty for Cua. Agent control uses the shared
`desktopScreenshotControl`; Cua's accessibility tree is a later item. For
the person's other machines, the driver asks `GetSpaceRoute` before a view
opens and refuses the screen when the transport is `relay_https`, where
Cua's documentation says the relay can read the session in transit; the
end-to-end mesh, `direct`, and `local` routes are accepted. Rejected:
reaching `cua-spacesd` on port 3211 directly (it needs the Space's bearer
token in Octant and declared relay hosts), and Cua's `/media` WebSocket
(H.264 the host would have to decode and bound; per-frame screenshots
already fit the pane's polling).

### Isolation and network for a Space on this machine

**Decision C7: a Space on this machine
is a QEMU VM with network `none` until a live check proves otherwise.** The
driver asks for `kind` `vm`, `runtime` `qemu`, `network` `none`, no
`volumes`, `env`, `services`, `egress`, `durable`, or `reuse`, and
`on_expire` `delete`; the host destroys the Space and fails the lease when
`CreateSpaceResponse.network` is not `none`. QEMU's user networking can
forward a guest to the host's loopback, which would reach the Octant
server, so `allow` is refused for this placement as it is for host-local
desktops until the maintainer's smoke shows a Space with network cannot
connect to host loopback. Rejected: a gVisor or `runc` container placement,
where Cua documents no `network` `none`.

### Lifecycle mapping

- **Acquire.** `CreateSpace` with the lease id as `create_id`, labels
  `octant-lease` and `octant-host`, and `wait` off; then `SetSpaceLifetime`
  to the lease expiry plus two minutes with `on_expire` `delete`; then
  `ResolveSpace` polled, each call bounded, until the Space is running with
  `cua-spacesd`. Cancellation calls `CancelCreateSpace` with the lease id,
  which also works after a daemon restart. A Space whose labels or placement
  do not match what was asked is deleted and the acquire fails.
- **Extend.** `SetSpaceLifetime` again; the extension counts only when the
  `expires_at` the daemon returns reaches the new expiry.
- **Release and verify.** `DeleteSpace`, then the complete listing above.
  Octant deletes only Spaces this daemon created, so the delete never has to
  go through another device (`cloud_delete` other than `here`).
- **List.** `ListSpaces` filtered by `octant-host`; `failed` when the answer
  is partial, stale, or the daemon is unreachable.

### Availability

- Linux and macOS hosts, wherever the person installed Cua and runs its
  daemon; Octant detects it and never installs, starts, updates, or signs
  it in. `status` answers `not-connected` when the socket is missing or
  fails its checks, and `refused` when `DaemonService.GetInfo` reports a
  version below the one the driver was recorded against or no `spaces`
  feature, or the Space's `SystemService.GetCapabilities` reports another
  `cua.env.v1` protocol version. Windows has no Unix socket path here and
  offers no Cua provider.
- The driver is loaded for teardown, and is effective only after the person
  chooses it in a recipe, as E2B is. It is loaded on Linux hosts now and on
  macOS once Cua is offered there, and only once the host has journaled a
  Cua lease ([Built in Cua sub-slice 2](#built-in-cua-sub-slice-2)).
- On macOS a Space gives a Mac without a screen its first desktop
  provider, but [artifact transfer](#built-in-slice-3) still refuses
  `path-unverifiable` there until a handle-path check exists for macOS. That
  check is its own item; screen and input work without it.

### Threat model additions

| Risk                                                                    | Mitigation                                                                                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The daemon socket can link clouds, set budgets, share Spaces, shut down | Declared method list in the driver's code, pinned by a test; no MCP or tool-call method; caller headers refused; confined tool launches get no home, so never the socket |
| A planted or redirected socket impersonates the daemon                  | Home-relative declared path, no environment override, no symlink on any component, owner and `0600` checks, parent not writable by others, version and feature checks    |
| A Space outlives a host that died                                       | Labels and journal-before-create; restart reconciliation; billed placements not offered until a cloud-side deadline exists (C5); the person is told what happens if not  |
| The relay reads the session                                             | Screen refused on `relay_https`; off-machine placements confirm where the Space runs                                                                                     |
| A Space on this machine reaches the Octant server                       | QEMU VM with network `none`, verified from the create's answer (C7)                                                                                                      |
| The daemon or Space answers with hostile or oversized data              | Port bounds on time and bytes; frames bounded before decoding; labels and names length-bounded; results taint the thread                                                 |
| Teardown is reported but billing continues                              | Octant claims only that the person's daemon no longer lists the Space; billed placements deferred (C5)                                                                   |

### Rejected alternatives

- **Bundling, installing, or launching the daemon.** Octant detects tools and
  never installs them. A daemon Octant started would hold the person's Cua
  sign-in and cloud links under Octant's lifecycle, and would be Octant
  operating another product's cloud client.
- **Talking to Cua's backends or the person's cloud directly** (the relay,
  Cua's OIDC issuer, or AWS with the person's credentials). It would put Cua
  account tokens or cloud keys in Octant, reimplement Cua's tagging and
  cleanup, and depend on another product's internal protocols.
- **Running the `cua` CLI for each call through a confined launch.** The
  capsule would need the home directory to find the socket, and parsing a
  CLI's output is a weaker contract than the published `.proto` files.

### Delivery sub-slices

1. **Daemon port** (container). `DesktopDaemonPort`, the host's socket
   checks and gRPC-Web framing, the seam's protobuf wire helper, and
   placements in the seam and recipe contract. _Accepts when_ a test daemon
   on a real Unix socket answers declared calls, and the port refuses a
   symlinked path or parent, another owner's socket, group or other
   permission bits, a writable parent, an undeclared method, caller and
   host-owned headers, oversized requests and responses, a timed-out call,
   and a cancelled one, each as a value. _Verify:_ focused plugin-api and
   server tests; typecheck consuming packages.
2. **Cua driver for this machine's placement** (container; built, see
   [Built in Cua sub-slice 2](#built-in-cua-sub-slice-2)). _Accepts when_
   the conformance suite, restart included, passes against a recorded
   gRPC-Web transport built from Cua's published protocol through the
   host's real daemon port over a real socket, and tests cover the labelled
   create with `create_id`, the lifetime past the lease expiry, an extension
   the daemon holds short, cancellation through `CancelCreateSpace`, a
   partial listing answering `failed`, a create whose network is not `none`
   destroyed, the driver's method list, and the import boundary. _Verify:_
   focused tests. _Owed by the maintainer:_
   `bun run desktop:cloud:smoke cua run`, then `… cua kill` and
   `… cua restart`, on a Linux host with Cua's daemon running, signed in,
   and QEMU installed; each must end `PASS`, and `cua spaces list` must then
   show no Space labelled `octant-host`. The smoke also settles the
   unverified items above.
3. **The person's other machines** (container; built, see
   [Built in Cua sub-slice 3](#built-in-cua-sub-slice-3)). _Accepts
   when_ a recorded route of `relay_https` refuses the screen and an
   off-machine acquire asks. _Owed by the maintainer:_ the same smoke with a
   second machine set up with `cua host setup --provide-spaces`.
4. **Billed cloud placements**, only after C5's condition holds or the
   maintainer chooses its alternative (b).

### Built in Cua sub-slice 1

- **Seam.** `DesktopDaemonPort`, `DesktopDaemonDeclaration`
  (`DesktopProvider.daemon`), and `desktopDaemonMethodDeclared` in
  `packages/plugin-api/src/desktopProvider.ts`; `DesktopPlacement`
  (`DesktopProvider.placements`); and the protobuf wire reader and writer
  (`packages/plugin-api/src/protobufWire.ts`), exported from the same
  `@octant/plugin-api/desktop-provider` entry a driver already imports.
- **Host.** `apps/server/src/computerUse/desktopDaemonPort.ts` is the port.
  The wiring builds it for the Cua driver since
  [sub-slice 2](#built-in-cua-sub-slice-2). The lease service leases a provider with placements on its
  recipe's placement.
- **Contract.** `DesktopPlacementId`; `placementId` on `DesktopRecipe`,
  `desktop.lease-requested@1`, and `DesktopLease`.
- **Policy.** `changeCodeProjectDesktopRecipe` refused a recipe that names
  a placement until sub-slice 2 offered placements.

Rules this sub-slice resolved:

- **A daemon call carries these fields and nothing else.** The request is
  the method, one unframed message, the response bound, whether the method
  streams its answer, and a signal. A
  request with any other field, `headers` among them, refuses
  `request-invalid`, because a driver that is not type-checked can send any
  shape. The host sends `content-type: application/grpc-web+proto`,
  `content-length`, and `grpc-timeout` set to the port's own bound; the HTTP
  client adds only `Host` and `Connection`.
- **A streamed answer is read whole.** `ProcessService.StartProcess` is the
  only way Cua starts a program in a Space, and it streams. A call that says
  its method streams (`stream`) is answered with every message in order
  (`messages`) and the status, read inside the same 45-second and byte
  bounds, the byte bound counting all messages together. A unary call still
  fails `response-invalid` on a second message, and a stream the daemon never
  ends times out, so only a stream the daemon ends on its own is answered.
  This extended the published seam after the port was first built, as its
  own change.
- **A malformed answer fails as `response-invalid`.** C1 listed three
  failures; a fourth is needed for a daemon that answers something other than
  one gRPC-Web answer: an HTTP status other than 200, another content type
  (`grpc-web-text` included), two messages to a unary call, a compressed or
  cut-off frame, no status, or bytes after the trailer frame. A status in the
  response headers with an empty body, as gRPC sends for an error before any
  message, is an answer.
- **What a declared method matches.** A path starts with `/` and matches a
  declaration segment by segment. A `*` stands for exactly one segment of
  letters, digits, `.`, `_`, `~`, or `-` that is not `.` or `..`, so a
  percent-escape, a query, an empty segment, or an extra segment never
  matches. A declaration with two `*` or an empty segment declares nothing.
- **Every directory from the home down is checked, not only the parent.**
  The home directory and each directory below it to the socket are read with
  `lstat` and must be directories, not symlinks, owned by Octant's user, with
  no group or other write bit; a group-writable directory is refused like one
  any user can write, since the host cannot tell who is in the group. A
  declared path must be relative, made of plain name segments, and contain no
  `.` or `..`. A host that has no user id, such as Windows, refuses
  `socket-unsafe`. Directories above the home are not checked, so a home
  under a symlinked `/home` still works.
- **Where the walk starts, and what a swap could do.** The home is the one
  the system's user database records for Octant's uid, read by
  `/usr/bin/getent passwd <uid>` on Linux and `/usr/bin/id -P <uid>` on
  macOS, each run by absolute path with an empty environment, so `$HOME`
  never moves it, under Node or Bun alike. `os.userInfo()` is not used:
  Bun, which runs the development and headless servers, answers it with the
  `$HOME` it was launched with (observed on Bun 1.4.4). A program is run
  rather than `/etc/passwd` read because macOS keeps a person's account in
  Open Directory, not that file, and a Linux account can come from a
  directory service. The answer must be one `passwd` record whose uid is
  Octant's and whose home is absolute; a lookup that fails, answers
  anything else, or runs on another platform refuses `socket-unsafe`, and
  the next call asks again. The checks and the connect are two steps on a
  path, because Node can neither connect through an opened directory nor
  ask a socket for its peer: between them, only Octant's user, who can
  already reach the daemon, or whoever can write a directory above the
  home, normally only root, could swap a component.
- **A missing socket is a daemon that is not running.** A path component
  that does not exist answers `failed` `daemon-unreachable`, so the driver
  can report "start the daemon"; any other error reading a component refuses
  `socket-unsafe`.
- **The response bound is per message.** The one message may be as large as
  the smaller of the driver's bound and one uncompressed frame of the largest
  screen; reading stops 16 KiB past that, which leaves room for frame
  prefixes and the trailer. The status message reaches the driver
  percent-decoded and cut to 1,024 characters.
- **The host applies a placement wherever it applied the provider's
  terms.** A provider that declares placements leases only through a recipe
  that names one of them, and a recipe that names a placement for a provider
  that declares none, or one it does not declare, refuses
  `no-provider-configured` before any provider call. The placement's
  locality and billing then decide the host-local cap, the posture gate, the
  billed confirmation, the provider-expiry check, and the pane's Start;
  a transfer asks by the locality the lease journaled. A recipe whose
  placement changed counts as removed.
- **No recipe named a placement until the editor offered one.** Until
  sub-slice 2 the providers a recipe may name (`recipe-providers`) carried
  no placements, so a save that named a placement was refused. Sub-slice 2
  offers placements, applies C4's "a credential or a daemon placement" rule,
  and records the daemon in `desktop.lease-requested@1`.

Evidence: `desktopDaemonPort.test.ts` starts a test daemon on a real Unix
socket in a temporary home and covers declared calls answered (a status
error and a status sent in the headers included), with the daemon seeing
only the host's headers; undeclared methods (`Shutdown`, `CallSpaceTool`,
`/mcp`, extra and empty segments, `..`, a query, a percent-escape) and loose
declarations; a symlinked socket and a symlinked directory; a socket with
group or other bits; a directory others or the group can write, the home
included; another user's socket and directory (the two cases that need
`chown` run only as root, which this container is, and an unprivileged run
still covers another user's directory and socket together); declared paths
that are absolute or escape; a missing socket; driver headers, the
`x-cua-host-caller` and `x-cua-share-caller` caller headers among them;
requests over 4 MiB; responses over the driver's bound, the host's bound,
and a stream that claims a huge message; a time-out; cancellation before,
during the socket checks, and while waiting; seven malformed answers; a
`HOME` pointing at a home with a live test daemon, and no `HOME` at all,
both leaving the walk at the recorded home, where the declared socket's
folder is missing, so both fail as an unreachable daemon rather than refuse
as a failed lookup would (under Bun the call runs in a Bun launched with that
environment, since Bun reads `HOME` only at launch; this case failed under
Bun before the home came from the user database); the lookup's answer held
against Node's `os.userInfo().homedir`, which reads the user database
itself (under Node only, since Bun answers that with `$HOME`); and a uid the
user database has no record of. These tests read the real home and write
nothing in it; the walk case skips, saying why, on a host whose home the
port would refuse as not the user's alone. Removing each socket check in turn
fails at least one of these tests. The same file passes under Bun 1.4.4,
which runs the development and headless servers
(`bun --bun x vitest run --project unit src/computerUse/desktopDaemonPort.test.ts`
in `apps/server`), as well as under Node, which runs the packaged desktop's
server, through `bun run test`. The `macos-15` CI job runs the file under
Node as well, which is the evidence that `/usr/bin/id -P` finds the home on
macOS; it passed there on 2026-10-27 ([job](https://github.com/Ogard-Labs/octant/actions/runs/40537495871/job/122306586053)). It also covers a whole stream, its shared
bound, a unary call refusing two messages, a `stream` that is not a boolean,
and a stream that never ends.
`protobufWire.test.ts` covers protobuf's documented encodings, a negative
`int64`, round trips of every wire type, and malformed input answered as a
value. `desktopLeaseService.test.ts` covers a placement the provider does not
declare, a missing one, locality and billing taken from the placement (a
billed placement asks and is not kept without a provider expiry), a transfer
asking for a placement off the machine, and a changed placement ending the
lease; `projectPolicy.test.ts` covers the refused save; and
`desktopLease.test.ts` covers the contract.

Nothing in this sub-slice is owed by the maintainer. The port has never
spoken to Cua's daemon: that a real daemon answers it is settled by
sub-slice 2's live smoke.

### Built in Cua sub-slice 2

- **Driver.** `apps/server/src/plugins/cuaDesktop/`: the `cua` provider
  (`cuaDesktopProvider.ts`) with one placement, `this-machine` (host-local,
  not billed), and its messages (`cuaProtocol.ts`), written by hand from
  Cua's `.proto` files at commit `8fbdf83`. It imports only
  `@octant/contracts` and the seam and reaches Cua only through the daemon
  port; a test enforces both.
- **Seam.** A launch reads `ProcessService.StartProcess` through the
  port's streamed answer ([Built in Cua sub-slice 1](#built-in-cua-sub-slice-1)).
- **Contract.** `LeasableDesktopProvider` carries `placements` and `daemon`;
  `desktop.lease-requested@1` and `DesktopLease` carry `daemon` (the
  declared socket path and the user it belongs to).
- **Policy and host.** A recipe save and an acquire take locality from the
  placement and apply C4. The lease service records the daemon and checks
  it at teardown. The wiring builds the daemon port for the Cua driver.
- **Editor.** **Runs on** lists a provider's placements
  (`ProjectDesktopRecipeSection.tsx`).
- **Smoke.** `bun run desktop:cloud:smoke cua run|kill|restart`
  (`cloudDesktop.smoke.ts`), which reads no key.

Rules this sub-slice resolved:

- **A launch ends its stream at once.** A launch runs as E2B's does, a
  shell that starts the app in its own session and exits, so the
  `StartProcess` stream ends at once; a stream the daemon never ends times
  out.
- **Octant asks the person's daemon nothing until it has a Cua lease.** The
  driver is loaded on Linux hosts and joins the host's providers only once
  the journal holds a Cua lease, so teardown reaches every Cua lease a host
  ever journaled, and a host that never leased from Cua makes no call to
  the socket, not even a restart listing. A listing makes the daemon wait
  for Cua's relay, and a host that never chose Cua has nothing there to
  find. macOS loads it once Cua is offered there. Since a recipe can name
  only a provider the host lists, offering Cua must also list the driver
  before any Cua lease exists.
- **The daemon a lease used is recorded and kept.** The `requested` event
  records the declared socket path and the user id whose home holds it. A
  provider that declares a daemon is never leased on a host that has no user
  id. Teardown counts a listing as the provider confirming absence only
  through that same daemon: if the driver's socket path or Octant's user
  changed, the lease stays `release-failed`, since another user's daemon
  listing nothing says nothing about this one's Space.
- **A daemon-run provider takes no key.** A recipe for a provider that
  declares a daemon is refused at save and at acquire when it names a
  credential reference, and its driver's `listOwned` with one answers
  `failed`. A cloud placement of such a provider needs no credential (C4).
- **Placed here explicitly.** The create names `location` `local`, never
  the person's default, which may be one of their clouds.
- **A Space in creation is not absent.** The Space is named
  `octant-<lease id>`, because a create Cua is still running is listed only
  by name (`CreatingSpace`), without labels. `verifyGone` answers `present`
  while one runs under the lease's name, and `listOwned` answers `failed`
  while any `octant-` create runs, since it cannot yet tell whose it is.
- **What counts as ready, and as the wrong Space.** A Space is ready when it
  is `running` with a `cua-spacesd` version. One whose labels, cloud, or
  kind differ from what was asked is deleted and the acquire fails, as is
  one that reports another `cua.env.v1` protocol version (refused) or that
  does not boot within five minutes, asked every two seconds. Release cancels
  any create still running for the lease, then deletes; a delete answered
  `NOT_FOUND` counts as asked, and only the listing proves absence.
- **Input points at the frame the person saw.** Frames are PNG with
  `max_dimension` at the recipe's longer edge and are refused when larger
  than the recipe's screen. Pointer input names that frame's
  `screenshot_id` in `COORDINATE_SPACE_SCREENSHOT`, so Cua maps it to the
  screen; input before any frame refuses `no-frame`. Keys are the closed set
  an X desktop takes, sent as Cua's named `Key` or as one character.
- **Tokens the daemon offers are never read.** `GetInfoResponse` carries the
  daemon's loopback token and `ConnectSpaceResponse` the Space's token; the
  driver reads only the version and features, and the passthrough URL.
- **Recorded against.** The daemon release is at least `0.9.0` (Cua's
  workspace version at `8fbdf83`) with the `spaces` feature, and the Space
  speaks `cua.env.v1` protocol version 1. A recipe with no image uses Cua's
  canonical Linux image, `ghcr.io/trycua/linux:24.04`, whose VM variant
  `kind` `vm` selects.
- **Files.** A sent file is uploaded in chunks of at most 1 MiB, or less if
  the Space asks, with its SHA-256 checked when the upload is committed,
  read-only (`0444`) to a staging name, then moved into `/home/user/inbox`.
- **The daemon's lifetime is reported, not relied on.** The acquire reports
  the lifetime the daemon confirmed as the provider's expiry. This
  placement does not bill, so the host's billed-expiry check does not apply,
  and C5 still keeps billed placements out.

Evidence: `cuaDesktopProvider.test.ts` runs the conformance suite, restart
included, against a recorded Cua daemon (`cuaRecordedDaemon.test-support.ts`,
an HTTP/1.1 gRPC-Web server on a real Unix socket in a temporary home, with
its own field numbers written from Cua's `spaces.proto`, `daemon.proto`,
`common.proto`, `computer.proto`, `filesystem.proto`, `process.proto`, and
`system.proto`) through the host's real daemon port. It covers the
labelled create with `create_id` and nothing beyond the fields above; the
lifetime past the lease expiry with `on_expire` `delete`; an extension the
daemon holds short; cancellation through `CancelCreateSpace` with the lease
id; incomplete, stale, and unreachable listings answering `failed`; a create
whose network is not `none`, and a Space placed in a cloud, destroyed; a
Space reporting another protocol refused; refusals before any call; the
method list pinned, with every call it makes declared and none carrying a
caller header; readiness by daemon version and feature; frames and a
person's input on the frame they saw; a sent file landing read-only and
launching; listing by host; and the import boundary. Through the lease
service over a journal on disk, a host killed with a lease `ready`, and one
killed while Cua was creating it, each find the Space by its labels on the
next start and destroy it. Removing each of the driver's checks in turn
(network, cancellation, partial listing, short extension, labels, create id,
lifetime margin, cloud placement, a create in progress) fails at least one
test. The file passes under Node through `bun run test` and under Bun
(`bun --bun x vitest run --project unit src/plugins/cuaDesktop` in
`apps/server`). The method-list test also shows that no call carries the
daemon's loopback token or a Space's token. `desktopLeaseService.test.ts`
covers a daemon-run provider leased on its placement with no key, a key
refused, the daemon recorded, a host with no user id refused, and teardown kept `release-failed` under another user
until the same daemon answers. `projectPolicy.test.ts` covers a saved
placement, network on a host-local placement, a cloud placement with no
key, and a key refused; `ProjectDesktopRecipeSection.test.tsx` covers
choosing and saving a placement and an unoffered saved placement; and
`desktopLease.test.ts` covers the contract.

Owed by the maintainer: on a Linux host with Cua's daemon running as the
user Octant runs as, signed in, and QEMU installed, from `apps/server`,
`bun run desktop:cloud:smoke cua run`, then `… cua kill` followed by
`… cua restart`. Each must end `PASS`, and `cua spaces list` must then show
no Space labelled `octant-host`. Besides the unverified items in
[What Cua offers now](#what-cua-offers-now), the live run is what confirms
what a recording cannot: that a create with `wait` off reports `network`
`none` (if it reports nothing, every acquire fails closed), that the
default image boots as a QEMU VM with `cua-spacesd`, that a Space name of
the form `octant-<lease id>` is accepted, that a local Space reports no
`cloud`, that `/home/user` exists in the guest and a launched program
reaches its display, that each screenshot carries a `screenshot_id`, and
whether the VM's screen matches the recipe's size (a frame larger than the
recipe is refused). Until it passes, the driver is offered on no host.

### Built in Cua sub-slice 3

- **Driver.** The `cua` provider declares a second placement,
  `other-machine` ("Your other computer" since the
  [follow-ups](#built-cua-follow-ups), locality `cloud`, not billed), and
  two more methods, `SpaceService/ListHosts` and `SpaceService/GetSpaceRoute`
  (`cuaDesktopProvider.ts`, `cuaProtocol.ts`). No seam change was needed.
- **Policy.** `decideDesktopLeaseAcquire` takes the lease's locality and asks
  `off-machine` for every lease off this machine
  (`packages/domain/src/desktopLeasePolicy.ts`).
- **Contract and host.** The pane's `acquire` names the provider and
  placement a person confirmed (`confirmedProvider`, `confirmedPlacement`),
  and the pane's Start carries the recipe's placement (`placementId`). The
  lease service starts a person's billed or off-machine lease only with both,
  and asks an agent's thread `off-machine`, naming the placement.
- **Pane.** Start on an off-machine placement asks first, naming the
  provider and placement and saying that if this machine stops, Octant
  cannot end the desktop, which may keep running there until the person
  deletes it in the provider (`DesktopPane.tsx`).
- **Smoke.** `bun run desktop:cloud:smoke cua-other-machine run|kill|restart`.

Rules this sub-slice resolved:

- **An off-machine lease asks the way a billed one does.** The rule is in
  [Authority](#authority). It reuses the billed confirmation rather than a
  second path: a person confirms in their own tab, which names the provider
  and the placement they saw, and an agent's turn asks in its thread. A
  placement off this machine has locality `cloud`, the locality that already
  makes a transfer ask `off-machine`; a billed placement asks `billed`, whose
  confirmation also names where it runs.
- **Which other machine.** The recipe names the machine
  ([Built: Cua follow-ups](#built-cua-follow-ups)), and the driver creates
  on `host:<id>` only for that machine, listed by `ListHosts` and online. As
  first built, a recipe named only the placement and the driver created only
  when exactly one machine answered, refusing none and several rather than
  choosing; naming the machine replaced that. A host listing that cannot be
  read fails, and a host Octant cannot name or whose `via` is other than
  `relay` or `direct` is never offered or used. Rejected: `on` `auto`, which
  picks the least-loaded machine and, with a cloud linked, may be a billed
  pool host.
- **The same VM, wherever it runs.** A Space on another machine is the same
  QEMU VM with network `none` as one here (C7), verified from the create's
  answer. That machine's loopback holds the person's own services there,
  as this one's holds the Octant server, so a recipe with network is
  refused for both placements, by the host before any call since the
  [follow-ups](#built-cua-follow-ups) and by the driver as well.
- **A Space reported elsewhere is destroyed.** One on this machine must
  report no `host`; one on another must report one, and for a relay host the
  relay machine id that was asked. Any other answer deletes the Space and
  fails the acquire `space-mismatched`, as a Space placed in a cloud does.
- **The route is asked before every use, not only before a view.** Cua falls
  back from the mesh to the relay's HTTPS path when the mesh stops
  answering, so the driver asks `GetSpaceRoute` before a view opens and
  again before each frame, input, sent file, and agent command on a Space on
  another machine. `mesh` (end to end, straight or relayed as ciphertext),
  `direct`, and `local` are accepted. `relay_https` refuses
  `session-readable` (first `relay-reads-session`); `cloud`, an empty transport, any value the driver
  does not know, an error, or an unreadable answer refuses
  `route-unverified`; a daemon that does not answer is `not-connected`.
  The answer and the call after it are two steps, so a fallback between
  them reaches the next call, not that one. A Space on this machine is never
  asked: its route is `local`.
- **A refused screen reaches the person as what it is.** As first built,
  the host passed no driver reason to a pane, so a view the route refused
  showed `provider-unavailable`. The seam's one reason a person is told,
  `session-readable`, now reaches the pane
  ([Built: Cua follow-ups](#built-cua-follow-ups)); any other route refusal
  still shows `provider-unavailable`. The agent's command answers `refused`
  with the route's reason.

Evidence: `cuaDesktopProvider.test.ts` runs the conformance suite, restart
included, a second time on the `other-machine` placement against the
recorded daemon, which now also plays the person's machines (`ListHosts`,
a create on `host:<id>`) and the route to a Space on one of them
(`GetSpaceRoute`, written from `spaces.proto` at `8fbdf83`: `ListHostsRequest`,
`SpacesHost`, `GetSpaceRouteRequest`, `GetSpaceRouteResponse`, and
`Space.host`). It covers a recorded route of `relay_https` refusing the
screen, a sent file, and an agent command before anything reaches the
Space; the mesh and `direct` showing frames; a route that falls back to
`relay_https` while a view is open refusing that view's frames and input;
`cloud`, empty, and unknown transports refused; a Space here never asked
its route; the create on the one machine that answers, with none and two
refused before any create; and a Space reported on another machine than
asked destroyed. Through the lease service over a journal on disk, an
off-machine acquire asks: an agent under Full access is asked `off-machine`,
and a person's Start creates nothing until they confirm the provider and
that placement. `desktopLeaseService.test.ts` covers the same with a fake
provider and the pane's Start offering the placement;
`desktopLeasePolicy.test.ts` covers the gate in every posture; and
`DesktopPane.test.tsx` covers the question and the confirmation it sends.
Removing the `relay_https` refusal, the refusal to choose among several
machines, or the check of where a Space was placed each fails a test. The
file passes under Node through `bun run test` and under Bun.

Owed by the maintainer: Cua sub-slice 2's smoke, then the same on a second
Linux machine of the same Cua account, set up with
`cua host setup --provide-spaces` and QEMU installed, the only one of the
account's machines providing Spaces and online: from `apps/server` on this
host, `bun run desktop:cloud:smoke cua-other-machine run`, then
`… cua-other-machine kill` followed by `… cua-other-machine restart`. Each
must end `PASS`, and `cua spaces list` on this host must then show no Space
labelled `octant-host`. If the mesh does not connect, the view refuses and
`run` ends `FAIL`, which is the intended outcome on that route. The live run
is what confirms what a recording cannot: that `location` `host:<id>` takes
the id `ListHosts` reports, that a Space there reports `network` `none`, its
`host`, and its labels, that `GetSpaceRoute` answers `mesh` or `direct`, that
`SetSpaceLifetime` and `DeleteSpace` reach it through this daemon, and that
a complete `ListSpaces` lists it. Until both smokes pass, the driver is
offered on no host.

### Built: Cua follow-ups

The three follow-ups Cua sub-slice 3 named, none of which needs a smoke or a
maintainer decision. No host offers Cua yet, so none is reachable in the
running app until the live smokes pass.

- **Contract.** `DesktopMachineId` and `DesktopMachine` (`machineId`,
  `displayName`); `machine` on `DesktopRecipe`, `desktop.lease-requested@1`,
  `DesktopLease`, and the pane's `start`; `choosesMachine` on
  `LeasableDesktopPlacement`; `confirmedMachine` on the pane's `acquire`;
  the pane request `recipe-machines` and its answer; and the view refusal
  `session-readable` (`packages/contracts/src/desktopLease.ts`).
- **Seam.** `DesktopPlacement.choosesMachine`, `DesktopProvider.listMachines`,
  and `DESKTOP_SESSION_READABLE`, the one driver refusal reason the host
  passes to a person (`packages/plugin-api/src/desktopProvider.ts`).
- **Policy.** `desktopNetworkAllowed` (`packages/domain/src/desktopLeasePolicy.ts`),
  applied by `changeCodeProjectDesktopRecipe` and by the lease service.
- **Host.** The lease service's `recipeMachines`, the machine in a lease's
  terms, and `session-readable` from a view, frame, or input
  (`apps/server/src/computerUse/desktopLeaseService.ts`,
  `apps/server/src/desktopPaneRoutes.ts`).
- **Driver.** The `cua` placements are named "This computer" and "Your other
  computer"; `other-machine` chooses a machine; `listMachines` reads
  `ListHosts`; and an acquire creates only on the machine the recipe names
  (`apps/server/src/plugins/cuaDesktop/cuaDesktopProvider.ts`).
- **Editor and pane.** **Computer** in the recipe editor
  (`ProjectDesktopRecipeSection.tsx`); the computer in the Desktop toolbar
  and the off-machine confirmation, and the not-shown state for a session
  that could be read (`apps/web/src/desktop/`).

Rules this delivery resolved:

- **The recipe names the computer.** A placement that runs on one of the
  person's own machines declares `choosesMachine`, and a recipe on it must
  name one (`machine`); a recipe on any other placement, or for a provider
  with none, that names one is refused, at save and at acquire. The person
  picks it in a local window from the machines the provider lists now,
  offline ones marked; the editor never picks one. The recipe keeps the name
  the person chose it by, so the pane, the Start confirmation, and a paired
  device show which computer a desktop uses without asking the provider. The
  lease journals the machine, a person's Start counts only with that machine
  confirmed, an agent's question names it, and a recipe whose machine changed
  counts as removed. The driver creates only on the named machine, refusing
  `machine-not-found` when the daemon does not list it and `machine-offline`
  when it does not answer, so it never chooses another.
- **Listing machines is a local window's act.** Only a local window sets a
  recipe, so only a person there is answered `recipe-machines`; a paired
  device, an agent, and `system` are refused `not-permitted`. It asks only a
  provider offered for leasing now, on a placement that chooses a machine,
  bounded like a teardown call. The driver is untrusted: an id that is not
  one is left out, names are cut to 128 characters, and at most 64 machines
  are shown. Listing asks the person's daemon, so the editor asks only while
  such a placement is chosen, never on opening.
- **Names say "computer", never the host's platform.** The placement names
  and the pane's copy say "this computer", as copy the host writes does
  ([Architecture: host platform in copy](../architecture.md#security-and-authority)),
  because a paired device reads them. A machine's name is the person's own,
  as the provider lists it.
- **One driver reason reaches the person.** A screen, frame, or input a
  driver refuses with `DESKTOP_SESSION_READABLE`, because the route to the
  desktop could let a third party read the session, answers the pane
  `session-readable`. The pane says the desktop is not shown while the
  connection could be read, that it is still running, and offers **Try
  again**, which opens a view afresh; it never retries by itself. Every other
  driver reason stays with the host: a view still refuses
  `provider-unavailable`, a frame answers `no-frame`, and an input
  `not-delivered`. A person's input is journaled before the driver refuses
  it, as any input is.
- **Network only where a desktop can have it.** A recipe may allow network
  only for a provider with no placements whose desktops run off this
  computer. A host-local desktop shares the host's namespace, and every
  placement offered is a VM whose user networking reaches the loopback of
  the machine it runs on, so neither may. The host refuses such a recipe at
  save, and refuses its acquire `no-provider-configured` before it journals
  anything or asks anyone, so a recipe saved before the rule cannot start a
  desktop. A placement that can offer network will declare it when one
  exists.

Evidence: `desktopLeaseService.test.ts` covers a stored recipe allowing
network on an off-machine placement refused at overview and acquire with
nothing journaled, asked, or created; a desktop on the named machine, a Start refused without that
machine or with another, and a machine change ending the desktop; a view
refused `session-readable` while another route refusal stays
`provider-unavailable`, and a route that turns readable mid-view refusing
frames and input; and the machine listing answered to a local window only,
bounded and checked, refused for a placement or provider that does not
choose one, and `provider-unavailable` when the daemon does not answer.
`desktopPaneRoutes.test.ts` covers the listing asked as the authenticated
person; `cuaDesktopProvider.test.ts` covers the create on the named machine,
never another online one, the named machine found in a long listing, a
missing or offline machine refused after `ListHosts` alone, a recipe naming
no machine or one for this computer refused before any call, the listing,
and `session-readable` on `relay_https`, with the conformance suite and the
person's confirmation through the lease service on the named machine;
`projectPolicy.test.ts` covers the network and machine rules at save;
`desktopLease.test.ts` covers the contract; and `DesktopPane.test.tsx` and
`ProjectDesktopRecipeSection.test.tsx` cover the confirmation naming the
computer, the toolbar, the not-shown state and Try again, and choosing and
saving a computer. The new lease service, driver, policy, pane, and editor
tests each failed against the code before this change.

Nothing here is owed by the maintainer beyond Cua sub-slices 2 and 3's
smokes; `cua-other-machine` now names the one machine its setup requires.

## Rationale

The original plan leaned on execution capsules for isolation and a cloud
provider first. Capsules were cancelled, and the host's real boundary is the
Bubblewrap launch every confined process already uses. Starting with a
host-local provider keeps the first consequential code (leases, teardown,
transfer, attribution) testable without spending money, and makes the cloud
driver a translation layer rather than the place where lifecycle bugs are
found. The archived [0053](../decisions/0053-computer-use-destinations.md)
holds the earlier destination reasoning; this specification is the current
rule.

## Verification

Source entry points: `apps/server/src/computerUse/desktopLeaseService.ts` and
`computerUseDestination.ts` (lease service, destination reporting),
`packages/contracts/src/desktopLease.ts`, `packages/domain/src/desktopLeasePolicy.ts`,
`packages/plugin-api/src/desktopProvider.ts` and `desktopProviderConformance.ts`
(the seam), `apps/server/src/computerUse/hostLocalDesktopLaunch.ts` (the
host-local launch through `apps/server/src/process/linuxConfinement.ts`),
`apps/server/src/computerUse/desktopArtifactRead.ts` (the transfer's read),
`apps/server/src/plugins/hostLocalDesktop/` (the host-local driver),
`packages/plugin-api/src/desktopScreenshotControl.ts` (agent control of a
screen-only desktop), `apps/server/src/computerUse/desktopHttpsPort.ts` and
`apps/server/src/plugins/e2bDesktop/` (the cloud port and the E2B driver),
`apps/server/src/computerUse/desktopDaemonPort.ts` and
`packages/plugin-api/src/protobufWire.ts` (the local-daemon port and the
seam's protobuf wire helper), `apps/server/src/plugins/cuaDesktop/` (the Cua
driver),
`apps/server/src/computerUse/computerUseToolService.ts` (a send's binding to
a lease), `apps/server/src/desktopPaneRoutes.ts`, and the web Desktop pane
(`apps/web/src/desktop/`). Each slice above lists its
evidence. Lease negatives, restart reconciliation, and real-`bwrap` permission
negatives are the load-bearing checks; a cloud smoke is maintainer-run
(`cloudDesktop.smoke.ts`).
