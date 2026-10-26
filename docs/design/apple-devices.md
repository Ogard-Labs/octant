# Apple physical devices and distribution

This topic specification owns the Apple workbench beyond the Simulator: a
person's paired iPhone or iPad as a build destination (discover, install,
launch, logs, screenshots), the signing and provisioning custody that needs,
and the separately authorized distribution of a person's own app through App
Store Connect: upload, submission for App Review, and release, each when the
person asks for it. Architecture owns the device authority rules this
extends ([Architecture: device transport and evidence](../architecture.md#device-transport-and-evidence));
[Device workbench](device-workbench.md) owns the Simulator and emulator panes.

**Status: accepted 2026-10-26; slice 1 is starting.** The maintainer
authorized this scope as post-preview work and accepted the decisions below on
2026-10-26. That authorizes this design and its slices; it does not by itself
authorize spending, creating developer accounts,
signing, uploading, submitting, or releasing a real build, or changing the first-release boundary,
which stays Simulator and local macOS on Apple Silicon. Octant's own internal
TestFlight track for its mobile client is a separate operator runbook
([mobile-testflight.md](../mobile-testflight.md)) and grants nothing here.

## Outcome

1. **Physical device first.** In a Code thread on a Mac, a person can let the
   thread use one of their paired devices; the agent and the workbench can then
   build the thread's app signed for development, install it, launch it, read
   its console output, take screenshots, and stop it, with the same evidence
   and approval model as the Simulator.
2. **Distribution second, separately.** A person can upload a build of their
   own app to App Store Connect from the Mac, submit a version for App Review,
   and release an approved version, each when they ask for it and confirm that
   exact build or version. Octant never takes one of these steps on its own.

## What exists today

- `octant_apple` and the workbench drive Simulators and the local Mac only.
  Destinations are `AppleSimulatorRecord`s
  ([`appleToolchain.ts`](../../packages/contracts/src/appleToolchain.ts));
  there is no physical-device record, id, or action.
- Every build passes `CODE_SIGNING_ALLOWED=NO`
  ([`appleToolchainService.ts`](../../apps/server/src/apple/appleToolchainService.ts),
  `xcodebuildArguments`), so no signing identity is ever touched, and
  `archive` is accepted by policy but recorded `unavailable` without running.
- Per-operation posture is pure policy in
  [`appleToolchainPolicy.ts`](../../packages/domain/src/appleToolchainPolicy.ts)
  (`evaluateAppleSimulatorRequest`, `evaluateScope`): reads run under every
  posture; effects are refused by Plan, run under Full access, and need a
  one-use approval bound to the request and checkout otherwise; Repair input,
  Open URL, Rotate, and recording are person-only (`person-required`).
- **Allow input** is an in-memory, per-window, per-thread grant
  ([`simulatorInputGrants.ts`](../../apps/server/src/apple/simulatorInputGrants.ts)).
  There is no destination lease in code; the owner-or-lease rule of
  [0014](../decisions/0014-apple-development-capability.md) was never built for
  Simulators.
- On a non-macOS host the service refuses with an "open the thread on the Mac"
  result, and the tool family is omitted when the host has no toolchain to lend
  ([Architecture: process topology](../architecture.md#process-topology)).
- `/api/apple/` is a prefix the private listener forwards to paired devices
  ([`remoteRoutePolicy.ts`](../../apps/server/src/remoteRoutePolicy.ts)).
- The credential broker stores secrets by opaque UUID in namespaced families
  ([`credentialBroker.ts`](../../packages/host-runtime/src/credentialBroker.ts));
  none is for Apple signing or App Store Connect.

## Three layers, three authorities

| Layer           | Destination                          | Authority                                                                                                                   | Who may start an effect                                         |
| --------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Simulator       | Host-owned Simulator, the local Mac  | Thread posture per operation (unchanged)                                                                                    | Agent or person                                                 |
| Physical device | A paired device leased to one thread | Person-confirmed lease, then thread posture per operation; development signing only                                         | Agent or person, inside the lease                               |
| Distribution    | The person's App Store Connect app   | Person-confirmed per upload, submission, and release under every posture; distribution signing and an App Store Connect key | A local person only; no agent operation and no remote principal |

The layers do not collapse into one "devices" flag. A Simulator grant never
covers a physical device, a device lease never covers distribution, and Full
access covers neither the device lease nor any distribution step.

## Rules

### Host and platform

- Physical devices and distribution run only on a macOS host with Xcode
  selected and its licence accepted. On Linux and Windows, discovery reports no
  device layer (`toolchain-unavailable`), every device or distribution request
  is refused before a process starts, and the tool family stays omitted. No
  cloud Mac, remote build service, or third-party device library stands in.
- Everything here is host-local: the device is paired with that Mac, the
  signing identity is in that Mac's login keychain, and the upload runs from
  that Mac. A remote client observes evidence the host already produced, under
  remote policy; what it may start is in [Remote clients](#remote-clients).
- Octant never pairs or unpairs a device, enables Developer Mode, registers a
  device with the developer portal, creates certificates, or accepts agreements.
  Those are the person's acts in Xcode or on the device; the setup checklist
  names the missing step and stops.

### Discovery and identity

- The host lists paired devices, wired and network alike, with
  `xcrun devicectl list devices --json-output <host-private file>`, and probes
  which device operations the selected Xcode offers. An operation the probe does not
  find is reported unavailable for that host, never approximated.
- Each device gets a host-minted `AppleDeviceId`, mapped to the CoreDevice
  identifier in the host's Apple runtime store. The UDID, serial number, and
  ECID stay on the host: they never enter the journal, provider context,
  evidence, or a remote response. The agent and remote clients see the Octant
  id, model, OS version, connection, state, and the device's name.
- Device state is honest and refusing: `connected`, `locked`,
  `developer-mode-off`, `untrusted`, `unavailable`. An operation the state
  cannot answer is refused with that state as its reason.

### Lease

- A thread uses a physical device only while it holds that device's lease. A
  lease is bound to one Code thread and its checkout; it is held in host memory
  and ends when the person releases it, the thread is archived, purged, or
  rebound, the device disconnects for longer than five minutes, or the host
  restarts. Forgetting on restart is the safe direction, as with input grants.
- A lease starts only with a person's confirmation naming the device and the
  thread ("Let this thread use <device name>"), under every posture,
  Full access included: it opens a personal device, its screen, and its logs
  to a provider. An agent may ask for it (`octant_apple` `use-device`), which
  raises that confirmation; it never takes one silently.
- Another thread's request for a leased device is refused (`destination-leased`)
  and names no other thread to the agent. Only a local person may move a lease,
  through a confirmation that names the holding thread.
- `discover` and `status` need no lease. Every other device operation does.

### Per-operation authority

| Operation                             | Kind                           | Plan    | Approval-gated, auto-accept edits | Full access              |
| ------------------------------------- | ------------------------------ | ------- | --------------------------------- | ------------------------ |
| `discover`, `status`                  | Read                           | Runs    | Runs                              | Runs                     |
| `use-device` (start lease)            | Person confirmation            | Asks    | Asks                              | Asks                     |
| `release-device`                      | Ends own lease                 | Runs    | Runs                              | Runs                     |
| `screenshot`, `logs` (own process)    | Read inside lease              | Runs    | Runs                              | Runs                     |
| `build` signed for development, `run` | Effect                         | Refuses | Asks per request                  | Runs                     |
| `install`, `launch`, `terminate`      | Effect                         | Refuses | Asks per request                  | Runs                     |
| `uninstall`                           | Person-only effect (data loss) | Refuses | Person asks, confirmed            | Person asks, confirmed   |
| Provisioning update                   | Person-only account mutation   | Refuses | Not offered (decision 3)          | Not offered (decision 3) |
| Upload to App Store Connect           | Distribution, person-only      | Refuses | Person asks, confirmed            | Person asks, confirmed   |
| Submit a version for App Review       | Distribution, person-only      | Refuses | Person asks, confirmed            | Person asks, confirmed   |
| Release an approved version           | Distribution, person-only      | Refuses | Person asks, confirmed            | Person asks, confirmed   |

- For `use-device`, "Asks" is the lease confirmation above. For effects it is
  the existing mechanism: an `approval-requested` turn event whose
  approval mints the host's one-use, five-minute receipt bound to exactly that
  request, device, and checkout, validated by the same Apple policy. A denial,
  expiry, lost lease, or thread gone stale or into Plan refuses the call.
- `install` takes only the product an Octant build or run produced in that
  thread's private derived-data directory; any other path or archive is refused
  (`invalid-artifact`). `launch` and `terminate` take only the bundle identifier
  Octant installed for that thread, so a thread cannot open or stop the
  person's other apps. Octant stops only the process it launched, never by name.
- `logs` is the console output of the process Octant launched
  (`devicectl device process launch --console`). Device-wide system logs carry
  other apps' and the person's data and are not offered.
- A physical device has no input channel and no live view: Octant has no
  supported way to inject touches into real hardware. **Allow input** does not
  apply, and the pane shows the latest screenshot evidence.

### Signing and provisioning custody

- Development signing uses the identities and profiles the person already has
  in their login keychain and Xcode, selected by team ID. Octant never imports,
  exports, copies, or reads private keys or `.p12` files, never stores signing
  material in the broker or journal, and no launch an agent can steer gets a
  path to that material (see decision 2 for how the signing step is confined).
- The team ID and the identity's SHA-1 fingerprint are the only signing facts
  recorded; both are public. Evidence records which identity signed which
  product.
- The confinement profile grants the keychain and CoreDevice service lookups an
  operation needs as measured, per-launch `extraRules`, following the Apple
  `test` rule: each grant is the weakest spelling that cleared a measured fatal
  refusal, listed in the architecture beside that rule, never added to the
  shared profile.

### Distribution

- Distribution is never agent-initiated. `octant_apple` has no upload, archive
  for distribution, submit, or release operation, and a provider's own shell
  approval does not cover one: the distribution routes are local-only, like
  `/api/desktop`, so a paired device and the private listener cannot reach them.
- The workbench's **Upload to App Store Connect…** is offered only to a local
  person on a macOS host with a stored App Store Connect key. Its confirmation
  names the app, bundle id, version, build number, team, signing identity, and
  the checkout revision, and is bound to exactly those; it asks under every
  posture. One confirmation covers one archive, export, and upload.
- The App Store Connect API key is a person-entered secret in its own broker
  family (`/v1/app-store-connect-keys/`), entered from the desktop renderer or
  the host-local `octant` CLI on the same terms as provider keys. For one
  upload the host writes it to a `0600` file in a host-private directory that
  the confinement profile denies to every launch but the upload's own, and
  removes it when the launch ends; a startup sweep removes any left behind.
- The journal records the upload: actor, app, version, build, team, result,
  and App Store Connect's delivery identifier. Never the key, its issuer
  secret, or the signed archive's bytes. The archive stays in host-private
  evidence under existing retention and thread purge.
- **Submit for App Review…** is offered for a version whose build App Store
  Connect has finished processing. Its confirmation names the app, version,
  build, and platform, and is bound to exactly those; one confirmation submits
  that one version. Octant submits only what App Store Connect already holds:
  it does not write or change metadata, screenshots, pricing, availability, or
  export-compliance answers, and a submission App Store Connect refuses for a
  missing item reports App Store Connect's reason and changes nothing.
- **Release…** is offered only for a version App Store Connect reports as
  approved and waiting for a manual release. Its confirmation names the app and
  version and states that it publishes the version to the App Store; one
  confirmation releases that one version. Octant never sets a version to
  release automatically after approval, so every release is a person's act at
  the moment they confirm it.
- The journal records each submission and release like an upload: actor, app,
  version, build, result, and App Store Connect's identifier for the
  submission. A failure or an answer Octant cannot classify is recorded as not
  done and never retried on its own.
- Adding testers or tester groups, answering App Review, and phased-release
  controls stay the person's acts in App Store Connect.

### Remote clients

- A paired device may read device status and evidence of a thread it can open.
- Device install, launch, terminate, and uninstall from a `remote-device`
  person are refused: remote clients observe only (decision 4).
- Starting or moving a lease, signing setup, provisioning updates, the App Store
  Connect key, upload, submission, and release are local-only, never
  remote-approvable.

## Threat model

| Threat                                                                          | Rule that answers it                                                                                                 |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| An agent or project build script exfiltrates a signing private key              | No export path; Octant never reads key material; signing runs in a confined launch with no network (decision 2)      |
| A Run Script phase uses the keychain grant to sign something else as the person | Signing is a host-owned step after the build, on the host-chosen bundle only (decision 2)                            |
| Prompt injection uploads, submits, or releases an app                           | No agent operation; local-only routes; per-build or per-version person confirmation under every posture              |
| A version goes live that the person did not mean to publish                     | Release only of an approved version, per version, at the person's confirmation; never an automatic release           |
| A thread drives a personal phone it was not given                               | Person-confirmed lease per thread; `destination-leased`; Full access does not start a lease                          |
| A thread opens or kills the person's other apps                                 | `launch` and `terminate` only the bundle Octant installed for that thread; process ownership                         |
| Screenshots or logs leak personal data to a provider                            | Reads only inside a person-confirmed lease; console of own process only; evidence by reference                       |
| Silent developer-account changes (new profiles, registered devices)             | Octant never passes `-allowProvisioningUpdates` (decision 3); Octant never registers devices or creates certificates |
| Device identifiers tracked across journal, providers, or remotes                | Host-minted `AppleDeviceId`; UDID, serial, ECID stay host-local                                                      |
| The App Store Connect key leaks during upload                                   | Broker storage; per-launch `0600` file denied to other launches; removed after; never journaled                      |
| A remote principal escalates                                                    | Lease, signing, provisioning, key, and distribution are local-only; remote never mints local receipts                |
| A non-macOS host pretends                                                       | Refused before any process; family omitted; no cloud Mac                                                             |

## Settled by current specifications

- Devices are destinations of the existing `octant_apple` family and
  workbench, not a new tool family or extension: Apple validation is a core,
  app-managed, provider-neutral capability, and Android is separate only
  because its toolchain is ([0153](../decisions/0153-android-emulator-is-a-separate-device-destination.md)).
- Reads run under every posture; effects follow the thread's posture with a
  one-use, request-bound receipt; person-only actions require `local-user` or
  `remote-device` in `requestedBy`
  ([Architecture: device transport and evidence](../architecture.md#device-transport-and-evidence)).
- Evidence is held by the host and referenced, never inlined as a side effect;
  restart reconciliation never reports ambiguous work as verified
  ([0014](../decisions/0014-apple-development-capability.md)).
- Secrets live in the credential broker by opaque reference; entry is local
  only (desktop renderer or host-local CLI)
  ([Architecture: security and authority](../architecture.md#security-and-authority)).
- Confinement grants are measured, per-launch, and listed beside the Apple
  `test` rule.
- An agent cannot mark work Done, merge, or release; distribution follows the
  same line: a person may release, the agent may not.

## Maintainer decisions

The maintainer accepted these on 2026-10-26. Each states the rule; the
alternatives considered and the reason for the choice follow it.

1. **Signing custody.** Octant uses the person's existing keychain identities
   and Xcode profiles, selected by team ID, and holds no key material.
   Rejected: importing a `.p12` into the broker, and leaving signing to an
   external tool. The chosen rule keeps keys where macOS already guards them
   and adds no new secret store.
2. **Where signing runs.** Octant builds unsigned under the ordinary profile,
   then a host-owned `codesign` step (no project scripts, no network) signs the
   host-chosen bundle with the profile's entitlements. Rejected for now: letting
   `xcodebuild` sign inside the build with a per-launch keychain grant, which
   Run Script phases would share. That fallback is considered only if
   measurement shows the host-owned step cannot produce an installable app for
   a real project, and it needs its own maintainer approval.
3. **Provisioning updates.** Octant never passes `-allowProvisioningUpdates`;
   the person fixes provisioning in Xcode. A person-only, per-run confirmed
   `-allowProvisioningUpdates` may be revisited after real use, as its own
   change to this specification. An agent operation, even with approval, is
   never offered, because it mutates the developer account.
4. **Remote device effects.** Remote clients observe only; install, launch,
   and terminate start from a local person or the thread's agent. Rejected for
   now: the same effects from a paired device's person under the Simulator's
   approval. The person holding the phone is usually at the Mac, and widening
   later is cheaper than narrowing.
5. **Screenshots on hardware.** Screenshots come only from the selected Xcode's
   own device tooling and are reported unavailable where it offers none.
   Rejected: a third-party device library. No new dependency is added, and the
   capability probe reports the gap honestly.
6. **Distribution scope.** Octant uploads a build, submits a version for App
   Review, and releases an approved version, each only when the local person
   asks and confirms that exact build or version. The maintainer changed this
   on 2026-10-26 from upload only: a person who chose Octant for the release
   should not have to finish it elsewhere. Kept out: adding testers, editing
   store metadata, and automatic release after approval, because each acts for
   the person without a confirmation tied to one version.
7. **Distribution timing.** Distribution slices (6 to 8 below) start only
   after an explicit maintainer request and a change to the Current Release
   Boundary in their own PR. That gate stays; device slices do not wait on it.

## Delivery plan

Slices land in order; each is one reviewable PR with its own evidence. "Container"
marks a slice an agent can implement and verify in a Linux container without
accounts or hardware; its real-hardware acceptance is separate where noted.

1. **Device contracts and policy** (container). `AppleDeviceId`,
   `AppleDeviceRecord`, device action kinds, lease and refusal reasons in
   contracts; `evaluateAppleDeviceRequest` in domain covering the table above,
   leases, person-only kinds, and non-macOS refusal. _Accept:_ every row of the
   authority table and every refusal is a focused domain test; consumers
   typecheck. _Verify:_ contract and domain tests, `bun run typecheck`.
2. **Discovery, identity, and lease on the host** (container for code;
   hardware for acceptance). `devicectl` listing parsed from fixtures,
   host-minted ids in the Apple runtime store, in-memory lease with
   person-confirmed start, release, and expiry, read routes, Linux refusal,
   remote classification. _Accept:_ fixtures cover wired, network, locked, and
   Developer Mode off; UDIDs never appear in responses or journal; a second
   thread is refused `destination-leased`. _Verify:_ server tests, route and
   remote-negative tests; a maintainer-run discovery smoke on a Mac with a
   paired device.
3. **Development-signed build, install, launch, terminate, console logs**
   (hardware and an Apple team). Signing per decisions 1 and 2, measured
   confinement grants recorded in the architecture, install limited to
   Octant-built products, launch limited to the installed bundle. _Accept:_ the
   fixture app runs on a real device from an approval-gated thread with
   evidence; a foreign bundle id and path are refused. _Verify:_ server tests
   with fixtures, plus a native smoke on a Mac with a paired device (maintainer
   hardware).
4. **Device pane and screenshots** (container for UI; hardware for the
   capture). Destination picker, lease confirmation, setup checklist rows
   (paired, trusted, Developer Mode, team), latest-screenshot pane, screenshot
   capture per decision 5. _Accept:_ honest states for every device state and
   an unavailable screenshot capability. _Verify:_ component tests and rendered
   QA against a fixture host; capture smoke on hardware.
5. **Agent operations** (container). `octant_apple` device operations,
   `use-device`, help text, harness and provider conformance. _Accept:_ the
   agent cannot start a lease without the person's answer, and Plan refuses
   effects. _Verify:_ tool tests and provider-sdk conformance.
6. **App Store Connect key custody** (container; needs the distribution
   gate of decision 7). Broker family, desktop and CLI entry, local-only routes.
   _Accept:_ the key is never in a response, argument, environment, or the
   journal; remote and browser entry are refused. _Verify:_ broker and route
   negative tests.
7. **Person-confirmed upload** (maintainer account, a real app, and the
   decision-7 gate). Archive, export, and upload as one confirmed local action
   with a journaled record. _Accept:_ one confirmation uploads exactly the
   named build; no agent or remote path reaches it. _Verify:_ server tests with
   a stubbed uploader, plus a maintainer-run upload of a test app.
8. **Person-confirmed submission and release** (maintainer account, a real app,
   and the decision-7 gate). Submit a processed build's version for App Review
   and release an approved version, each as one confirmed local action with a
   journaled record. _Accept:_ one confirmation submits or releases exactly the
   named version; release is offered only for an approved version waiting for
   a manual release; no agent or remote path reaches either. _Verify:_ server
   tests with a stubbed App Store Connect client, plus a maintainer-run
   submission and release of a test app.

Slices 1, 2, 4, and 5 can be built before any hardware or account exists;
slices 3, 7, and 8 cannot be accepted without the maintainer's Mac, a paired
device, and an Apple developer team or App Store Connect app.
