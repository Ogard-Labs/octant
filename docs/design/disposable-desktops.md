# Disposable desktops

This topic specification owns disposable desktops: throwaway Linux desktops a
thread leases so that an agent and the person can launch, drive, and look at
what the thread built, on a host that has no screen of its own. Architecture
owns the boundaries it applies: computer use is destination-shaped and
app-managed ([Architecture: extensions and skills](../architecture.md#extensions-and-skills)),
launches go through the shared confinement port, and authority is checked on the
server ([Architecture: security and authority](../architecture.md#security-and-authority)).

**Delivery state.** Approved design direction, not built. The maintainer
authorized this scope as post-preview work on 2026-10-26; it is not part of the
first release, and the [Current Release Boundary](../../AGENTS.md#current-release-boundary)
is unchanged by this document. No provider, lease, transfer, or Desktop pane
exists. The [maintainer decisions](#maintainer-decisions) below must be answered
before the slices that depend on them start; slice 1 depends on none of them.

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
  reports `available`/`macos-host` on a Mac with a screen and otherwise
  `unavailable` with `no-destination` or `no-provider-configured`, and
  `refuseComputerUseDestination` turns that into a refusal value. Its
  non-Darwin `providerConfigured` branch is a placeholder: no provider exists,
  so it can only answer `no-destination`.
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
  no broker, so `apps/server/src/wiring/computerUse.ts` builds no tool service
  and the runtime reports `no-destination`.
- **Command set.** `ComputerControlCommand` has `apps`, `launch`, `windows`,
  `observe`, `click` (by element index, or by `x`/`y` on a screenshot for an
  image-capable model), `type`, `press`, `scroll`, and `stop`. The older
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

## Rules

### Authority

- The server checks every lease command against the thread's current authority
  before any provider call: the thread is active, the caller may open it, the
  mode is Work or Code, the Project has a recipe, and the provider's plugin is
  installed, trusted, enabled, and effective. Each failure is a named refusal
  (`no-provider-configured`, `provider-disabled`, `not-leasable-mode`,
  `lease-limit`, `leased-by-another-thread`, `lease-ended`).
- **Acquiring** is an effect. Plan refuses it. Approval-gated and
  auto-accept-edits ask in the thread. Full access proceeds for a host-local
  provider. For a provider that bills the person, the rule is open as
  [decision 2](#maintainer-decisions); until it is answered, no billed provider
  ships.
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
  maximum; an agent cannot extend a lease. Idle release applies when no tab is
  open and neither operator has acted.
- **Journal before create.** The host journals `requested` with a host-minted
  lease id before calling the provider, and the driver tags the resource with
  that id and the host's identity. A crash between the provider call and the
  `provisioning` event therefore leaves a tagged resource the host can find.
- **Provider-side expiry is mandatory for a billed provider.** The driver sets
  the provider's own timeout to the lease expiry plus a short margin, so a host
  that never comes back still stops paying. A billed provider that cannot set
  one is refused by the seam's conformance suite.
- **Restart.** On start, before admitting any new lease, the host destroys every
  lease the journal does not show as `released`, and every tagged resource its
  driver lists that has no live lease. Host-local desktops are reaped through
  their process-group receipts and their lease directories are deleted. Tabs for
  those leases restore as unavailable and never reconnect.
- **Verified release.** Release succeeds only when the driver confirms the
  resource is absent. Otherwise the lease is `release-failed`: the host retries
  with backoff, the Desktop tab and Settings show "still running" with the
  provider and a Retry, and new leases on that provider are refused until it
  clears. Octant shows elapsed time and expiry, never a cost estimate it cannot
  verify.

## Provider seam

A desktop provider is a bundled or third-party plugin contribution, kind
`desktop-provider`, declared in `@octant/plugin-api` beside the replica-store
and Computer use ports. A driver imports only `@octant/contracts` and that
seam; a test fails on any other import, as for image drivers. Every operation
returns a discriminated result (`status`: `ready`, `refused`, `failed`,
`not-connected`, and the operation's own success), never a throw for an expected
outcome. The host owns leases, journaling, authority, approvals, teardown,
reconciliation, the stream proxy, and evidence; the driver owns only the
translation to its provider.

| Operation                                     | Driver contract                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `status`                                      | Whether the provider can be used on this host now (binaries present, credential readable); performs no work |
| `acquire(leaseId, recipe, expiresAt, signal)` | Creates one tagged desktop with provider-side expiry; returns an opaque handle                              |
| `screen(handle)`                              | A bounded frame source and an input sink (pointer, key, text, scroll) for the host's stream                 |
| `control(handle, command)`                    | The `octant_computer` commands it supports; unsupported ones refuse `unsupported`                           |
| `deliver(handle, name, bytes)`                | Writes one read-only file to the inbox                                                                      |
| `release(handle)` / `verifyGone(handle)`      | Destroy, then confirm absence                                                                               |
| `listOwned(hostId)`                           | Tagged resources for restart reconciliation                                                                 |

The host gives the driver capability-scoped ports, never raw handles: a confined
launch port for a host-local provider, and an authenticated HTTPS call port for a
cloud provider. A conformance suite, modelled on
`packages/provider-sdk/src/imageGenerationConformance.ts`, proves that a driver
stops when cancelled, tags what it creates, sets provider-side expiry when it
bills, reports absence only when absent, and refuses rather than degrades an
unsupported command. The desktop's agent-facing commands are the existing
`octant_computer` set; a host-local desktop without an accessibility tree
returns observations with a screenshot and no elements, so it is usable only by
image-capable models and refuses `needs-image-model` otherwise. Adding `drag`
and `move-cursor` to the command set is its own contract change.

## Threat model

| Risk                                                  | Mitigation                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A leaked cloud desktop bills silently                 | Journal-before-create, tagged resources, mandatory provider-side expiry, restart reconciliation, verified release, visible failure |
| The app under test or an injected agent reads secrets | No checkout, home, keyring, session bus, SSH agent, or `OCTANT_*` in the desktop; cloud key never leaves the host                  |
| The desktop reaches the host                          | Own network namespace with no host loopback; standard streams are the only channel; bounded parsing of everything returned         |
| Kernel escape from a host-local desktop               | Same Bubblewrap boundary Code tool launches already rely on; a VM-backed provider is the stronger boundary                         |
| Transfer used to exfiltrate                           | One named file, refused outside the root or under `.git`, hash journaled, the person sees it; cloud transfers always ask           |
| Desktop content steers the agent                      | Results taint the thread; standing approvals stop; sensitive-field protection and per-app approval unchanged                       |
| Another thread or a stale tab takes over a screen     | Leases are thread-bound; a restored tab shows unavailable and never rebinds                                                        |
| A stream token or provider URL leaks to a client      | The host terminates the provider stream; renderers get only the host's authorized channel                                          |
| A host-local desktop exhausts the host                | Host-wide lease cap, per-thread cap of two, hard expiry, idle release                                                              |

## Maintainer decisions

1. **First provider.** (a) Host-local virtual display in a Bubblewrap launch:
   no new runtime, no account, no cost, Linux hosts only, contents are the
   host's installed apps, kernel-shared isolation. (b) Host-local OCI container
   (rootless Podman): real per-Project images, but a container runtime the
   person installs and a second confinement mechanism Octant must verify.
   (c) Cloud provider on the person's account (the original plan named E2B):
   VM isolation and image templates, but an account, a key, billing, and data
   leaving the machine. **Recommended: (a) first, (c) second.** (a) exercises
   the whole seam, teardown, transfer, and pane in a Linux container with no
   account, so the risky host-owned parts are proven before money is involved;
   (b) only if per-Project images prove necessary locally.
2. **Who may acquire a billed lease.** (a) Posture rules like any effect;
   (b) a person confirms every billed lease in every posture. **Recommended:
   (b).** Spending the person's money is not a code effect Full access covers.
3. **Paired devices.** (a) View and operate from any client that may open the
   thread; (b) view only from paired devices; (c) local windows only.
   **Recommended: (a).** The desktop holds nothing of the host's, and a
   headless host is mostly used remotely. Acquiring a billed lease still needs
   decision 2's confirmation.
4. **Lease limits.** **Recommended defaults:** 30-minute expiry, extendable by
   a person to a recipe maximum of 4 hours; idle release after 15 minutes; two
   leases per thread; two live host-local leases per host.
5. **Host-local network.** (a) None; (b) none by default with a per-recipe
   `allow` a person sets; (c) also forward one approved Local server port into
   the desktop. **Recommended: (b) now, (c) as a later slice.** A web app is
   tested from its built artifact first; a forwarded port is a new inbound path
   and gets its own approval design.

## Delivery plan

Each slice is one reviewable PR that updates this specification's delivery
state. "Container" means an agent can implement and verify it in a Linux
container with no account or hardware.

1. **Lease contract and host lease service** (container). Lease schemas,
   events, refusals, and the `desktop-provider` seam types; the host service
   for acquire, release, expiry, idle, thread end, restart reconciliation, and
   verified release; destination reporting that names leasable providers; a
   test-only in-memory driver and the conformance suite. No real provider, no
   UI. _Accepts when_ a host with no provider reports the capability absent and
   refuses every lease command as a value; a second thread is refused
   `leased-by-another-thread`; expiry and thread archive destroy and verify; a
   restart destroys every unreleased lease and every orphaned tagged resource
   before admitting a new one; an unverified release stays `release-failed`
   and blocks new leases on that provider; `computerUseRuntime.test.ts` and
   `computerUseToolService.test.ts` pass unchanged. _Verify:_ focused contracts
   and server tests, typecheck consuming packages.
2. **Host-local provider** (container with `bwrap` and a virtual X server
   installed; needs decisions 1 and 5). Readiness detection, the dedicated
   Bubblewrap launch, the standard-stream screen channel, receipts.
   _Accepts when_ real-`bwrap` negatives show the desktop cannot read the
   checkout, home, or keyring, cannot connect to host loopback, and gets no
   `OCTANT_*` value; release and restart leave no process. _Verify:_
   confinement tests under real Bubblewrap, conformance suite.
3. **Artifact transfer** (container). _Accepts when_ refusals cover absolute,
   escaping, symlinked, `.git`, oversized, and changing files; path, size, and
   hash are journaled; Plan refuses and approval-gated asks. _Verify:_ focused
   server tests with permission negatives.
4. **Agent control** (container with a scripted model; needs decision 3 only for
   remote clients). The send selection binds `octant_computer` to a lease.
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
6. **Cloud provider driver** (needs decisions 1 and 2, a maintainer-owned
   account, an API key, and billing authority). Bundled driver through the seam,
   declared hosts, provider-side expiry, tag reconciliation. _Accepts when_ the
   conformance suite passes against a recorded transport, and a maintainer-run
   smoke acquires, drives, releases, and confirms at the provider that nothing
   remains, including after a forced host kill.

Later, each with its own design note here: a forwarded Local server port,
accessibility element trees for host-local desktops, `drag` and `move-cursor`,
and Work-mode leasing if it is not delivered with Code.

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

Source entry points once built: `apps/server/src/computerUse/` (lease service,
destination reporting), `packages/contracts/src/computerUse*.ts`,
`packages/plugin-api/src/` (the seam), `apps/server/src/process/linuxConfinement.ts`
(the host-local launch), and the web Desktop pane. Each slice above lists its
evidence. Lease negatives, restart reconciliation, and real-`bwrap` permission
negatives are the load-bearing checks; a cloud smoke is maintainer-run.
