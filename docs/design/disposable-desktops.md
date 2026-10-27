# Disposable desktops

This topic specification owns disposable desktops: throwaway Linux desktops a
thread leases so that an agent and the person can launch, drive, and look at
what the thread built, on a host that has no screen of its own. Architecture
owns the boundaries it applies: computer use is destination-shaped and
app-managed ([Architecture: extensions and skills](../architecture.md#extensions-and-skills)),
launches go through the shared confinement port, and authority is checked on the
server ([Architecture: security and authority](../architecture.md#security-and-authority)).

**Delivery state.** Accepted 2026-10-26; slices 1–5 and recipe storage are
built and slice 6 is not. The maintainer authorized this scope as
post-preview work and accepted the [maintainer decisions](#maintainer-decisions)
below on 2026-10-26; it is not part of the first release, and the
[Current Release Boundary](../../AGENTS.md#current-release-boundary) is
unchanged by this document. The lease contract, the `desktop-provider` seam
and its conformance suite, the host lease service, the host-local provider,
artifact transfer, the agent's binding of `octant_computer` to a lease, the
Desktop pane, and a Code Project's stored recipe with its settings editor
exist (see [Built in slice 1](#built-in-slice-1),
[Built in slice 2](#built-in-slice-2),
[Built in slice 3](#built-in-slice-3),
[Built in slice 4](#built-in-slice-4),
[Built in slice 5](#built-in-slice-5), and
[Built: recipe storage](#built-recipe-storage)). Slice 4's real-provider
smoke is still owed by the maintainer.

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
  ([decision 2](#maintainer-decisions)). A person who acquires a host-local
  desktop has already decided and is not asked again; Plan still refuses them,
  and a billed lease still asks. The host re-checks authority after the answer,
  and an answer given for one provider or posture never covers another.
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
needs it (2 and 6). The confined launch port, `DesktopLaunchPort`, launches one
named program only for a lease the host is provisioning and only once per
lease, always as the host's dedicated desktop launch; the driver chooses the
program and its arguments and nothing about the capsule. A driver the host keeps only for
teardown is held as `DesktopTeardownPort` (`id`, `release`, `verifyGone`,
`listOwned`), so it cannot be asked to do anything else. A conformance suite
(`@octant/plugin-api/desktop-provider-conformance`), modelled on
`packages/provider-sdk/src/imageGenerationConformance.ts`, proves that a driver
stops when cancelled, tags what it creates, sets provider-side expiry when it
bills, reports an extension only when the provider confirms the new expiry,
reports absence only when absent, and refuses rather than degrades an
unsupported command. Its fixture maps two scenarios onto whatever backs the
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
   contents are the host's installed apps, kernel-shared isolation. The second
   is a cloud provider on the person's account (the original plan named E2B):
   VM isolation and image templates, but an account, a key, billing, and data
   leaving the machine. The host-local provider exercises the whole seam,
   teardown, transfer, and pane in a Linux container with no account, so the
   risky host-owned parts are proven before money is involved. Not planned: a
   host-local OCI container provider (rootless Podman), which offers real
   per-Project images but needs a container runtime the person installs and a
   second confinement mechanism Octant must verify; it is reconsidered only if
   per-Project images prove necessary locally.
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
6. **Cloud provider driver** (per decisions 1 and 2; needs a maintainer-owned
   account, an API key, and billing authority). Bundled driver through the seam,
   declared hosts, provider-side expiry and its extension, tag reconciliation.
   _Accepts when_ the conformance suite passes against a recorded transport, and
   a maintainer-run smoke acquires, drives, releases, and confirms at the
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
  again (Plan still refuses). A billed lease still declines: the person's
  billed confirmation arrives with the cloud provider (slice 6).
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
  ([slice 2](#built-in-slice-2)). A save that changes nothing, and any change
  to an archived Project, is refused. Removing is always allowed.
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
  a cloud provider and are not editable until one exists (slice 6); a save
  keeps the ones already stored for the same provider. Remove asks first,
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
refusals, Work and Chat Projects, and no-ops; `projectRoutes.test.ts` refuses
a paired device's change and keeps a local window's; `desktopPaneRoutes.test.ts`
lists the offered providers; `ProjectDesktopRecipeSection.test.tsx` sets a
recipe on an offered provider, keeps an unavailable saved provider from being
saved, removes after asking, and offers nothing when the host offers no
provider. Rendered QA ran the editor in a Project overview in a headless
browser, light and dark, at 1280 and 390 pixels wide, for a new recipe set on
the host's provider, a saved recipe, a saved provider the host no longer
offers, and a host that offers none, with no console error and no horizontal
overflow.

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
`apps/server/src/plugins/hostLocalDesktop/` (the host-local driver and its
agent control), `apps/server/src/computerUse/computerUseToolService.ts` (a
send's binding to a lease), `apps/server/src/desktopPaneRoutes.ts`, and the
web Desktop pane (`apps/web/src/desktop/`). Each slice above lists its
evidence. Lease negatives, restart reconciliation, and real-`bwrap` permission
negatives are the load-bearing checks; a cloud smoke is maintainer-run.
