# Apple physical devices and distribution

This topic specification owns the Apple workbench beyond the Simulator: a
person's paired iPhone or iPad as a build destination (discover, install,
launch, logs, screenshots), the signing and provisioning custody that needs,
and the separately authorized distribution of a person's own app through App
Store Connect: upload, submission for App Review, and release, each when the
person asks for it. Architecture owns the device authority rules this
extends ([Architecture: device transport and evidence](../architecture.md#device-transport-and-evidence));
[Device workbench](device-workbench.md) owns the Simulator and emulator panes.

**Status: accepted 2026-10-26; slices 1 (contracts and policy), 2
(discovery, identity, and lease on the host), and 5 (agent operations) are
built, slices 3 (development-signed build, install, launch, terminate, and
console logs) and 4 (device pane and screenshots) are built and wait on their
native smoke on a Mac with a paired device, and slices 6 to 8 wait on the
distribution gate of decision 7.** The maintainer
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
  ([`appleToolchain.ts`](../../packages/contracts/src/appleToolchain.ts)).
- The device contracts (`AppleDeviceId`, `AppleDeviceRecord`,
  `AppleDeviceRequest`, `AppleDeviceLease`, and the refusal reasons) and the
  pure `evaluateAppleDeviceRequest` in
  [`appleToolchainPolicy.ts`](../../packages/domain/src/appleToolchainPolicy.ts)
  decide every row of the authority table below and every refusal named in
  these rules; upload, submission, and release are refused until distribution
  is enabled.
- The host discovers paired iPhones and iPads through `devicectl`
  ([`appleDeviceService.ts`](../../apps/server/src/apple/appleDeviceService.ts),
  [`devicectl.ts`](../../apps/server/src/apple/devicectl.ts)), keeps their
  Octant ids in the Apple runtime store, and holds leases in memory
  ([`appleDeviceLeases.ts`](../../apps/server/src/apple/appleDeviceLeases.ts)).
  `POST /api/apple/devices` answers `discover` and `status`,
  `POST /api/apple/device-leases` starts and releases a lease, and the
  local-only `POST /api/apple/device-actions` builds, runs, installs,
  launches, terminates, and reads the console of the thread's own app on a
  leased device
  ([`appleDeviceRoutes.ts`](../../apps/server/src/appleDeviceRoutes.ts)); every
  request is decided by `evaluateAppleDeviceRequest`. A device build signs
  with the person's own keychain identity in a host-owned step
  ([`appleSigning.ts`](../../apps/server/src/apple/appleSigning.ts) and the
  pure `chooseAppleDevelopmentSigning`). The action route also captures a
  leased device's screen, and the local-only
  `POST /api/apple/device-screenshots` hands a local window the pixels of its
  thread's latest screenshot. The Apple workbench's **Physical devices**
  section ([`ApplePhysicalDevices.tsx`](../../apps/web/src/apple/ApplePhysicalDevices.tsx))
  is the device picker, setup checklist, lease confirmation, and latest
  screenshot. The agent's `octant_apple` reaches the same device service and
  policy with requests that name the agent
  ([`codeAppManagedTools.ts`](../../apps/server/src/code/codeAppManagedTools.ts)):
  `discover` (with `destination: "device"`), `status`, `use-device`,
  `release-device`, `screenshot`, `logs`, `build`, `run`, `install`,
  `launch`, and `terminate`.
- Every build passes `CODE_SIGNING_ALLOWED=NO`, Simulator and device alike
  ([`appleToolchainService.ts`](../../apps/server/src/apple/appleToolchainService.ts),
  `xcodebuildArguments`), so no build launch touches a signing identity, and
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

| Layer           | Destination                          | Authority                                                                                                                   | Who may start an effect                                                                                            |
| --------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Simulator       | Host-owned Simulator, the local Mac  | Thread posture per operation (unchanged)                                                                                    | Agent or person                                                                                                    |
| Physical device | A paired device leased to one thread | Person-confirmed lease, then thread posture per operation; development signing only                                         | Agent or person, inside the lease                                                                                  |
| Distribution    | The person's App Store Connect app   | Person-confirmed per upload, submission, and release under every posture; distribution signing and an App Store Connect key | A local person, or the thread's agent when the person asks; a local person confirms every one; no remote principal |

The layers do not collapse into one "devices" flag. A Simulator grant never
covers a physical device, a device lease never covers distribution, and Full
access covers neither the device lease nor any distribution step.

## Rules

### Host and platform

- Physical devices and distribution run only on a macOS host with Xcode
  selected and its licence accepted. On Linux and Windows, discovery reports no
  device layer (`toolchain-unavailable`), every device or distribution request
  is refused with that reason before a process starts, and the tool family
  stays omitted. No cloud Mac, remote build service, or third-party device
  library stands in.
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
  find is reported unavailable for that host (`operation-unavailable`), never
  approximated. The probe covers listing, install, launch, terminate,
  uninstall, screenshot, and console logs; `run` needs install and launch, and
  `build` needs none because it does not touch the device.
- Only iPhone and iPad are destinations (`platform: "ios"`); other paired
  hardware is left out of the list. The outcome names those two, and widening
  the record later is additive.
- Each device gets a host-minted `AppleDeviceId`, mapped to the CoreDevice
  identifier in the host's Apple runtime store. The UDID, serial number, and
  ECID stay on the host: they never enter the journal, provider context,
  evidence, or a remote response. The agent and remote clients see the Octant
  id, model, OS version, connection, state, and the device's name.
- Device state is honest and refusing: `connected`, `locked`,
  `developer-mode-off`, `untrusted`, `unavailable`. An operation the state
  cannot answer is refused with that state as its reason.
- The listing decides the first four: a device CoreDevice cannot reach, or
  that is on neither a cable nor the local network, is `unavailable`; one not
  paired is `untrusted`; one whose Developer Mode status is anything but
  `enabled`, absent included, is `developer-mode-off`. A device that passes
  those has its lock state read with `devicectl device info lockState`; it is
  `connected` only when that says no passcode is needed, `locked` when one is,
  and `unavailable` when the read fails or the selected Xcode does not offer
  it. _Reason:_ every state but `connected` refuses, so a fact the host cannot
  read never lets an operation through.
- The probe runs each subcommand's `--help` once per selected developer
  directory, and counts an operation only when the help exits cleanly and its
  usage line names that exact subcommand; console logs also need `--console`
  in `device process launch`'s help. _Reason:_ an argument parser that does
  not know a subcommand can print its parent's help and exit cleanly, which
  must not read as the operation being offered. A probe whose help timed out,
  was cancelled, or did not start is not kept, and runs again on the next
  discovery; if it left the listing unanswered, that discovery fails.
- A listing the host cannot read is a failure, never an empty list, so a
  broken `devicectl` does not look like unplugged devices. `devicectl` writes
  its JSON to a `0700` directory in the host's data directory that every other
  Apple launch is denied, and the host removes each answer once read: a
  listing names every paired device's UDID, serial number, and ECID.
- The runtime store's `device-identities.json` holds only each Octant id and
  its CoreDevice identifier, for at most 256 devices; when it is full, the
  oldest device that is neither listed nor leased is forgotten. A forgotten
  device gets a new id if it is paired again.
- Responses say whose lease a device is under only as `this-thread` or
  `another-thread`.

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
- A move carries the holding thread it names (`fromThreadId`). If the lease
  ended or changed hands after the person was shown it, the move is refused
  (`lease-changed`), so a device is never taken from a thread the person did
  not see.
- A lease, an `uninstall`, and each distribution step count as confirmed only when the
  host's receipt says a local person answered; an answer from a paired device
  is refused (`local-person-required`).
- A lease may start on a device in any state but `unavailable`; each
  operation inside it checks the state again. A phone that locks itself is the
  ordinary case, and the lease grants nothing those checks do not still gate.
  Asking again for a lease the thread already holds needs no new confirmation.
- `discover` and `status` need no lease. Every other device operation does,
  and a lease left on the thread's earlier checkout does not count
  (`lease-required`).
- The lease confirmation is the desktop app's approval dialog, as an
  `apple-device-lease` approval bound to exactly that `use-device` request and
  the thread's checkout, one use within five minutes. It names the device
  (name, model, OS version, cable or network), the thread, and for a move the
  holding thread. The host counts it as a local person's answer only when the
  request that carries it comes from a local window and the receipt validates
  for that window; the dialog is never shown to a paired device.
- The agent's `use-device` raises the same confirmation in the thread: an
  `approval-requested` turn event worded as the lease dialog (device name,
  model, OS version, cable or network, and the thread), asked under every
  posture, Plan included. Only an answer from a window on the Mac settles it;
  a paired device's answer, or one no window vouched for, is refused with the
  card still waiting. The answer mints the host's one-use `apple-device-lease`
  receipt for the turn's window, bound to exactly the agent's request and the
  thread's checkout, and the host counts it as a local person's confirmation
  only for a request that names the agent and carries that receipt. _Reason:_
  the agent's request reaches the host through no window principal, so the
  local-only rule is enforced where the answer arrives instead.
- Only a discovery sees a disconnect, so the five minutes run from the first
  discovery that finds a leased device gone, unavailable, or unlistable. Until
  the lease ends, a leased device that went away stays listed as
  `unavailable`, so its thread can still see it and release it; releasing
  needs no fresh discovery.

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
| Upload to App Store Connect           | Distribution, person-confirmed | Refuses | Asks a local person               | Asks a local person      |
| Submit a version for App Review       | Distribution, person-confirmed | Refuses | Asks a local person               | Asks a local person      |
| Release an approved version           | Distribution, person-confirmed | Refuses | Asks a local person               | Asks a local person      |

- For `use-device`, "Asks" is the lease confirmation above. For effects it is
  the existing mechanism: an `approval-requested` turn event whose
  approval mints the host's one-use, five-minute receipt bound to exactly that
  request, device, and checkout, validated by the same Apple policy. A denial,
  expiry, lost lease, or thread gone stale or into Plan refuses the call. For
  a device effect the agent asks for, only a person at a window on the Mac may
  answer that event, as for a lease: decision 4 keeps a paired device's
  person from starting a device effect, and approving one is starting it.
- Before the agent's lease or effect is put to anyone, its tool asks the host
  what the policy would answer the request as it stands, carrying nothing
  out; only a call whose sole remaining refusal is the missing confirmation
  (`confirmation-required`) or approval (`approval-required`) is asked, and
  any other refusal is returned as it is. A lease the thread already holds is
  used without asking. The request is decided again when it arrives.
- `install` takes only the product an Octant build or run produced in that
  thread's private derived-data directory; any other path or archive is refused
  (`invalid-artifact`). `launch`, `terminate`, and `uninstall` take only the
  bundle identifier Octant installed for that thread on that device
  (`foreign-bundle`), so a thread cannot open, stop, or remove the person's
  other apps. Octant stops and reads only the process it launched, never one by
  name (`process-not-owned`).
- Every device request names who asked (`requestedBy`). An agent acting for a
  different thread is refused (`thread-mismatch`), and `uninstall` or a lease
  move asked by anyone but a person is refused (`person-required`). A
  distribution step the thread's agent asks for runs only on a local person's
  confirmation, like a lease.
- A provisioning update is refused by name under every posture
  (`provisioning-updates-not-offered`), and a device request has no field that
  could carry `-allowProvisioningUpdates`: its scheme, the one value a build
  passes as given, cannot begin with `-`.
- `build` needs the lease but not a connected device: it signs for the device
  without touching it.
- Every refusal that needs nobody's answer (host, distribution gate, remote,
  person, posture, tooling, device, lease, state, ownership) is decided before
  an approval or confirmation is asked for, so nobody is asked to approve a
  call that would then be refused.
- `logs` is the console output of the process Octant launched
  (`devicectl device process launch --console`). Device-wide system logs carry
  other apps' and the person's data and are not offered.
- A launch is that console session: the host holds it for at most an hour and
  keeps the latest 1 MiB of its output. The launch counts once the session has
  stayed attached for ten seconds; a session that ends sooner is judged by its
  exit. `terminate` interrupts the session the host started, which ends the
  app, so nothing is stopped by name or process number. A lease that ends, for
  any reason, interrupts the thread's sessions on that device. _Reason:_ the
  console is only readable while `devicectl` stays attached, and stopping
  through it keeps the host's reach to exactly the process it started.
- `logs` keeps the console output as host-private evidence by reference; only
  its size enters the journal, since an app's own prints can carry the
  person's data and the journal reaches the provider. The agent's `logs` call
  receives the text itself (its latest 32 KiB) as that call's answer, inside
  the lease whose confirmation said the thread may read the app's console, and
  its `screenshot` call receives the pixels as an image the same way. The host
  hands back a console read or a screenshot only to the thread, on the
  checkout, that took it.
- The host checks the lease again just before it installs or launches: a
  `run`'s build can outlast the lease it started under, and a device whose
  lease has ended is not touched.
- The host carries out each device action id once and refuses a reused one
  before anything runs: a build's derived-data directory, its product
  reference, and its journaled plan are named by the id, so a reused id would
  build into another action's directory and replace the product it holds.
- What a thread built, installed, and launched is held in host memory, bound
  to the thread and its checkout. A host restart forgets it, so the thread
  builds and installs again; that is the safe direction to forget in.
- `devicectl`'s own messages are never kept: an install or launch failure
  records only CoreDevice's error domain and code. Build output and an app's
  console are kept with every token shaped like a UDID, UUID, or ECID
  replaced. _Reason:_ CoreDevice errors can name the device by UDID, serial
  number, or ECID, and a serial number has no shape a filter could find.
- Each device operation's evidence is journaled like the Simulator's, as a
  validation plan, record, and report under an `apple-device-<kind>` step.
- Device effects go through the local-only `/api/apple/device-actions` route.
  Under an approval-gated posture each needs a one-use `apple-device-action`
  approval bound to exactly that request and the thread's checkout, worded
  with the device, the project or app, and for a build the team; Full access
  needs none and Plan refuses before anything is asked.
- A physical device has no input channel and no live view: Octant has no
  supported way to inject touches into real hardware. **Allow input** does not
  apply, and the pane shows the latest screenshot evidence.
- `screenshot` runs `devicectl device screenshot` with `--device` and
  `--destination`, and the probe counts it only when that help also names
  `--destination`. The file lands in a `0700` directory in the host's data
  directory (`apple-runtime/device-captures`) that every other launch is
  denied and only the capture launch may write; it is read back without
  following a link, as one file with one name, under the artifact size bound,
  and only a PNG is kept. The capture's own file is removed whatever happened,
  and each capture first clears any file an earlier one left. _Reason:_ the
  same custody as a Simulator capture, and a tool whose output option the
  host cannot name cannot be driven the way the host drives it, so it is
  reported unavailable rather than guessed at.
- The host keeps, in memory, each thread's latest screenshot of each device on
  its checkout; a newer capture replaces the older one, and a restart forgets
  them. `discover` lists the asking thread's (`screenshots`), and only that
  thread's local window, on that checkout, can read the pixels, on the
  local-only `/api/apple/device-screenshots`. A reference the thread does not
  hold, an earlier one included, reads as not found. The image stays in the
  artifact store under existing retention.
- The workbench's **Physical devices** section looks once when it opens and
  again when the person checks again or acts; it never polls, since each look
  runs the selected Xcode's device tooling on the Mac.
- Its setup checklist has four rows in the order the host decides a device's
  state: **Reachable from this Mac** (`unavailable`), **Paired and trusted**
  (`untrusted`), **Developer Mode on** (`developer-mode-off`), and
  **Development team**. A row after the one that failed reads as not checked,
  never as passed. A locked phone passes every row and says to unlock it in
  its state line. _Reason:_ CoreDevice reports pairing and trust as one fact,
  and reachability is decided before it.
- The **Development team** row is the Team ID the person types, checked
  against the ten-character team shape and remembered per viewer in that
  window's storage. It selects no identity by itself: the host chooses the
  signature for the team a build names (see signing custody below).
- The pane offers a lease start (**Let this thread use** and the device's
  name, the desktop app's `apple-device-lease` confirmation), **Stop using**, and
  **Capture screen** (only inside this thread's lease, and only while the
  device is `connected`). It never offers a move: it is never told which
  thread holds another lease, so it says only that another thread is using
  the device. A window that cannot raise the desktop confirmation (a browser
  on the Mac, a paired device) offers no lease at all.

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
- The host chooses the signature by team from the identities `security
find-identity -v -p codesigning` lists and the profiles Xcode installed in
  `~/Library/Developer/Xcode/UserData/Provisioning Profiles` and
  `~/Library/MobileDevice/Provisioning Profiles`. A usable profile is the
  team's, for iOS, development (`get-task-allow`), not for every device,
  unexpired, and its app ID covers the bundle. The profile that names the app
  wins over a wildcard, a longer wildcard over a shorter one, then the latest
  expiry, then the profile's UUID; the identity is the first in keychain
  order the profile admits. _Reason:_ the same keychain and profiles always
  sign alike, and nothing is chosen that Xcode would not.
- The host reads a profile's property list out of its CMS envelope without
  verifying the envelope. _Reason:_ the device verifies the profile embedded
  in the app at install and refuses an altered one, and verifying here would
  need another keychain-reaching launch.
- Signing is chosen before the build runs. When it cannot be, the build is
  recorded failed with the step the person takes in Xcode (no identity, no
  profile for the app, or no identity the profile admits); a keychain listing
  that cannot be read is a failure, never an empty keychain.
- The signing step signs only the app the build settings declare, and only
  when it is a real directory inside that build's own derived data, not a
  link a build script planted. It embeds the chosen profile, signs nested
  frameworks and libraries, then signs the app with the profile's
  entitlements, the app ID narrowed to the bundle, `--timestamp=none`, and
  `--generate-entitlement-der`, under a launch with no network. An app that
  carries extensions, a Watch app, or an App Clip is not signed. _Reason:_
  each of those needs a provisioning profile of its own, which this host
  does not choose yet.
- `security` and `codesign` output is never kept: it names the identity, and
  with it the person. The evidence records the team and fingerprint only.

### Distribution

- Until the Current Release Boundary admits distribution (decision 7), every
  upload, submission, and release is refused (`distribution-not-enabled`)
  whoever asks and under every posture. The host passes the boundary to the
  policy as an input that stays off until the decision-7 PR turns it on; the
  distribution rows of the authority table are the rule that applies after
  that.
- Distribution never runs on an agent's word. When the person asks in the
  thread, its agent may request an upload, a submission, or a release through
  `octant_apple`; the request raises the same confirmation the workbench
  action does, and only a local person's answer runs it, under every posture
  including Full access. Plan refuses the request. The confirmation shows the
  person exactly what the agent asked for, so an injected request is visible
  before anything happens. A provider's own shell approval never covers one,
  and the distribution routes are local-only, like `/api/desktop`, so a paired
  device and the private listener cannot reach them.
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
  It may start `discover` and `status` only: a new screenshot or console read
  is refused (`local-person-required`), since a remote client observes
  evidence the host already produced. It sees that a screenshot exists (the
  discovery's reference and time), but never its pixels:
  `/api/apple/device-screenshots` is local-only. _Reason:_ a phone's screen
  shows the person's own data, and the Simulator's screenshot pixels do not
  reach a paired device either.
- Device install, launch, terminate, and uninstall from a `remote-device`
  person are refused: remote clients observe only (decision 4). So is every
  other device or distribution request from one, `release-device` included.
- Starting or moving a lease, signing setup, provisioning updates, the App Store
  Connect key, upload, submission, and release are local-only, never
  remote-approvable. So are the agent's lease and device effects: a paired
  device sees the thread's waiting card but its answer settles nothing.
- The private listener forwards `POST /api/apple/devices` (admitted as a
  Project read) and never `/api/apple/device-leases`,
  `/api/apple/device-actions`, or `/api/apple/device-screenshots`, which are
  local-only. Each
  route takes only its own kinds, and refuses a request whose `requestedBy` is
  not the person behind the asking window: `local-user` for a local window, the
  paired device's own `remote-device` for a paired device.

## Threat model

| Threat                                                                          | Rule that answers it                                                                                                 |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| An agent or project build script exfiltrates a signing private key              | No export path; Octant never reads key material; signing runs in a confined launch with no network (decision 2)      |
| A Run Script phase uses the keychain grant to sign something else as the person | Signing is a host-owned step after the build, on the host-chosen bundle only (decision 2)                            |
| Prompt injection uploads, submits, or releases an app                           | An agent request only raises a confirmation naming the exact build or version; only a local person's answer runs it  |
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
  same line: a person may release, and the agent may only ask them to.

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
   should not have to finish it elsewhere. The thread's agent may request any
   of the three when the person asks in chat; a local person still confirms
   each one, as with a device lease. Kept out: adding testers, editing
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
   _State:_ built. The contracts live in `appleToolchain.ts` and the policy in
   `appleToolchainPolicy.ts`, beside the Simulator's, whose identity checks
   they share; their tests are the `Apple physical device contracts` and
   `evaluateAppleDeviceRequest` suites there. The host's device service calls
   the policy from slice 2 on.
2. **Discovery, identity, and lease on the host** (container for code;
   hardware for acceptance). `devicectl` listing parsed from fixtures,
   host-minted ids in the Apple runtime store, in-memory lease with
   person-confirmed start, release, and expiry, read routes, Linux refusal,
   remote classification. _Accept:_ fixtures cover wired, network, locked, and
   Developer Mode off; UDIDs never appear in responses or journal; a second
   thread is refused `destination-leased`. _Verify:_ server tests, route and
   remote-negative tests; a maintainer-run discovery smoke on a Mac with a
   paired device.
   _State:_ built from `devicectl` fixtures; the `AppleDeviceService`,
   `AppleDeviceLeases`, `Apple device routes`, and `devicectl answers` suites,
   the remote route and classification tests, and the booted-server route test
   are its evidence. Discovery and leases journal nothing. Still open: the maintainer's
   discovery smoke on a Mac with a paired device, which also confirms the
   `devicectl` JSON and help shapes the fixtures assume. `devicectl` launches
   carry no extra confinement grant yet; any CoreDevice lookup the smoke shows
   they need is measured then and listed beside the Apple `test` rule.
3. **Development-signed build, install, launch, terminate, console logs**
   (hardware and an Apple team). Signing per decisions 1 and 2, measured
   confinement grants recorded in the architecture, install limited to
   Octant-built products, launch limited to the installed bundle. _Accept:_ the
   fixture app runs on a real device from an approval-gated thread with
   evidence; a foreign bundle id and path are refused. _Verify:_ server tests
   with fixtures, plus a native smoke on a Mac with a paired device (maintainer
   hardware).
   _State:_ built from fixtures: the `AppleDeviceEvidence` contract and the
   `apple-device-action` approval, `chooseAppleDevelopmentSigning` in domain,
   and on the host the device build, signing step, install, console session,
   terminate, and logs in `AppleDeviceService`, the local-only
   `/api/apple/device-actions` route, and journaled evidence. Its evidence is
   the `AppleDeviceService` tests of the thread's own app on a leased device,
   the route, remote, and product-dispatch negatives, the booted-server route
   test, and the Code runtime's device-build approval test; they cover the
   fixture app run on a device from an approval-gated thread and a foreign
   product path, product reference, and bundle id refused. Still open, on a
   Mac with a paired, unlocked device in Developer Mode and a development
   profile for `app.octant.simulatorfixture` that Xcode installed for the
   maintainer's team: `OCTANT_APPLE_TEAM_ID=<team> bun run smoke:apple-device`
   ([`smoke-apple-device.ts`](../../scripts/smoke-apple-device.ts)), which
   confirms the `devicectl` install and console shapes the fixtures assume and
   that interrupting the console session ends the app. The `security`,
   `codesign`, and `devicectl` launches carry no keychain or CoreDevice grant
   yet; each one that smoke shows a launch needs is measured then and listed
   beside the Apple `test` rule in the architecture.
4. **Device pane and screenshots** (container for UI; hardware for the
   capture). Destination picker, lease confirmation, setup checklist rows
   (paired, trusted, Developer Mode, team), latest-screenshot pane, screenshot
   capture per decision 5. _Accept:_ honest states for every device state and
   an unavailable screenshot capability. _Verify:_ component tests and rendered
   QA against a fixture host; capture smoke on hardware.
   _State:_ built from fixtures: the device `screenshot` evidence and the
   discovery's `screenshots` in contracts; on the host the capture into
   `device-captures`, the held latest screenshot, the action route's
   `screenshot`, and the local-only `/api/apple/device-screenshots`; the
   `@octant/client-runtime/apple-device-client`; and the workbench's
   **Physical devices** section with its picker, checklist, lease
   confirmation, capture, and latest screenshot. Its evidence is the
   `screenshots of a leased device` suite of `AppleDeviceService`, the route,
   remote, product-dispatch, and booted-server negatives, the
   `appleDeviceClient` tests, and the `ApplePhysicalDevices` and
   `useAppleDevices` component tests, which cover every device state and a
   Mac whose Xcode offers no device screenshot. The pane asks as the local
   person, so in a remote browser the route refuses even `discover` and the
   section shows that refusal; listing devices to a paired client, which the
   remote rules above allow, needs the renderer to ask as its paired device
   and is a follow-up. Still open, on the same Mac
   and device as slice 3: `bun run smoke:apple-device` now also captures the
   running fixture app's screen, or confirms the selected Xcode reports no
   device screenshot (`APPLE_DEVICE_SMOKE_SCREENSHOT=unavailable`); the
   capture confirms `devicectl device screenshot`'s help names
   `--destination` and that it writes a PNG there, and any CoreDevice grant
   the capture launch needs is measured then and listed beside the Apple
   `test` rule. Rendered QA of the pane is open too: the Linux container that
   built this slice had no browser, so the maintainer opens the workbench on
   that Mac and checks the section against the paired device in each state
   it can show.
5. **Agent operations** (container). `octant_apple` device operations,
   `use-device`, help text, harness and provider conformance. _Accept:_ the
   agent cannot start a lease without the person's answer, and Plan refuses
   effects. _Verify:_ tool tests and provider-sdk conformance.
   _State:_ built from fakes. `octant_apple` routes a call to the device layer
   when it names a `deviceId`, `destination: "device"`, or a device-only
   operation, and its help text covers the device operations; Simulator input,
   `boot`, `open`, and `test` are refused on a device (`not-offered-on-device`),
   and uninstall, provisioning, and distribution are not offered to the agent.
   On the host, `AppleDeviceService.check` answers the policy without carrying
   anything out and `readConsole` hands a thread back its own console read; the
   Code runtime asks a device lease or effect in the thread and accepts only a
   local window's answer. Its evidence is the Apple tool's paired-device suite
   in `codeAppManagedTools.test.ts` (a lease asked under Full access,
   approval-gated, and Plan and never taken on a denial, a held lease not asked
   again, a refusal returned before anyone is asked, effects refused in Plan
   and asked for under approval-gated, the screenshot image and console text),
   the Code runtime's paired-device cases (a paired device's answer refused,
   the minted receipt one-use, under a Full-access and a Plan turn), and the
   `AppleDeviceService` `check` and console tests. Provider conformance is
   unchanged: the tool travels the existing app-managed tool seam, whose
   provider-sdk conformance suites still pass.
6. **App Store Connect key custody** (container; needs the distribution
   gate of decision 7). Broker family, desktop and CLI entry, local-only routes.
   _Accept:_ the key is never in a response, argument, environment, or the
   journal; remote and browser entry are refused. _Verify:_ broker and route
   negative tests.
7. **Person-confirmed upload** (maintainer account, a real app, and the
   decision-7 gate). Archive, export, and upload as one confirmed local action
   with a journaled record. _Accept:_ one confirmation uploads exactly the
   named build; an agent's request runs nothing until a local person
   confirms, and no remote path reaches it. _Verify:_ server tests with
   a stubbed uploader, plus a maintainer-run upload of a test app.
8. **Person-confirmed submission and release** (maintainer account, a real app,
   and the decision-7 gate). Submit a processed build's version for App Review
   and release an approved version, each as one confirmed local action with a
   journaled record. _Accept:_ one confirmation submits or releases exactly the
   named version; release is offered only for an approved version waiting for
   a manual release; an agent's request runs nothing until a local person
   confirms, and no remote path reaches either. _Verify:_ server
   tests with a stubbed App Store Connect client, plus a maintainer-run
   submission and release of a test app.

Slices 1, 2, 4, and 5 can be built before any hardware or account exists;
slices 3, 7, and 8 cannot be accepted without the maintainer's Mac, a paired
device, and an Apple developer team or App Store Connect app.
