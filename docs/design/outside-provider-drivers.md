# Outside provider drivers

This topic specification owns how a provider-driver package that does not ship
with Octant is identified, admitted, confined, credentialed, verified, and
updated. Architecture owns the boundaries it builds on: the driver interface and
honest capability ([Architecture: providers](../architecture.md#providers)), the
activation ladder and plugin seams
([Architecture: extensions and skills](../architecture.md#extensions-and-skills)
and [plugin boundaries](../architecture.md#plugin-boundaries-and-remaining-extraction)),
and credentials and confinement
([Architecture: security and authority](../architecture.md#security-and-authority)).

**Delivery state.** Accepted 2026-10-26. Slice 1 (outside family identity) is
built: the reserved kind, the instance arm with its driver reference, the
`outside-endpoint` host runtime, and the capability matrix column. Slice 2
(outside driver manifest and quarantine) is built: the public outside entry
schema, inspection of a local driver folder with closed refusals, a
quarantined install, and the local-window-only lifecycle (see
[Manifest, inspection, and quarantine](#manifest-inspection-and-quarantine)).
Slice 3 (wire protocol and host proxy) is built: the protocol schemas in
`@octant/contracts/outside-driver-protocol`, a host proxy that implements
`HarnessEndpointDriver` over an in-memory channel, the brokered `http/request`,
the ceiling clamp, and closed reasons (see
[Wire protocol rules](#wire-protocol-rules)). Slice 4 (confined driver
process) is built: one supervised process per instance under the driver
profile from the shared confinement builder, a fixed environment, the
process's stdio as the proxy's channel, the crash limit, and `host-prohibited`
on Linux (see [Driver process rules](#driver-process-rules)); its acceptance,
the escape tests on macOS, runs in the `macos-15` CI job and passed there on
2026-10-27 ([job][macos-escape-2026-10-27]). Slice 5 (admission end
to end) is built: trusting the source admits the selected digest, a provider
is added from an effective driver (off, at a local window), its first check
starts the driver's process, the host runs Verify tools through the proxy,
every record binds the digest, disable and uninstall stop the process and
keep the provider blocked, and the provider catalog lists effective outside
drivers in their own group (see [Admission rules](#admission-rules)). Its
product acceptance, the live loopback smoke on macOS with a local model
server, is the maintainer's to run; on Linux every outside driver stays
`host-prohibited`. Slice 6 is next. The maintainer authorized this scope as
post-preview work and accepted the [maintainer decisions](#maintainer-decisions)
below on 2026-10-26; the release boundary in `AGENTS.md` and the architecture
is updated separately. Slices and their evidence are tracked in Linear; this
file states the rules they implement.

## Outcome

A person can install a provider-driver package from outside Octant, review it,
trust it, enable it, and add a provider from it, as separate actions, and use
its models in Chat, Work, and Code without an Octant release. The driver runs in
its own OS-confined process with no network, no filesystem beyond its package,
and no credential: it translates between Octant's harness and one model
service's wire protocol, and the host does everything else.

## First use case: an outside harness endpoint

The first and, under this design, only admitted outside driver shape is a
**harness endpoint**: a driver that supplies only a transport through the
provider-sdk harness endpoint port (`@octant/provider-sdk/harness-endpoint`,
`packages/provider-sdk/src/harnessEndpoint.ts`). The concrete case is a model
service whose native wire protocol is neither OpenAI- nor Anthropic-compatible,
reached at an address the person enters. The in-repo example and the live smoke
use a driver that speaks a local model server's native chat protocol on
loopback, so the end-to-end check needs no account.

Why this shape first:

- **It launches nothing.** The port has no `acquire`; `runOnNativeHarness`
  (`apps/server/src/harness/nativeHarnessEndpointDriver.ts`) builds every
  connection on the host. An outside agent CLI (ACP or managed process) would
  launch arbitrary programs with filesystem and shell authority and need its
  own row in the confinement matrix; that stays out of scope.
- **The host owns all authority.** The agent loop, tool offers and approvals,
  journaled transcript, retries, lead fallback, compaction, and Verify tools are
  host code. The driver sees requests and returns responses; a tool call it
  reports is model output that the host's harness policy handles like any other.
- **It needs no ambient authority to work.** Protocol translation needs no
  filesystem, no shell, and, when the host performs the HTTP call, no network
  and no credential. That lets the driver declare zero capabilities, which also
  keeps it Chat-safe under `isExtensionComponentModeSafe`
  (`packages/plugin-host/src/activation.ts` prohibits `credentials`,
  `filesystem`, and `shell` in Chat).
- **Its conformance kit exists.** `runHarnessEndpointConformance`
  (`packages/provider-sdk/src/harnessEndpointConformance.ts`) already states the
  properties the host relies on.

## What exists today

| Fact                                                                                                                                                                                  | Where                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Driver kinds are a closed literal enum, and each instance is a union arm keyed by it                                                                                                  | `ProviderDriverKind`, `ProviderInstance` in `packages/contracts/src/providers.ts`                                                                                                                                       |
| Only bundled drivers pass the activation ladder into discovery, wiring, and the provider service                                                                                      | `admittedBundledProviderDriverKinds()` in `packages/plugin-host/src/bundledProviderDrivers.ts`; callers in `apps/server/src/providers/providerService.ts`, `discoveryService.ts`, `apps/server/src/wiring/providers.ts` |
| The public catalog schema refuses any source other than `bundled`, declared capabilities, contributions, a second component, and any entry point but `builtin:provider-driver/<kind>` | `ProviderDriverCatalogEntry` in `packages/contracts/src/providerDriverCatalog.ts`, re-exported by `@octant/plugin-api`                                                                                                  |
| Host runtime per kind: `acp-host-profile`, `managed-process`, `direct-endpoint`                                                                                                       | `providerDriverHostRuntime` in `packages/provider-sdk/src/driverPlugins.ts`                                                                                                                                             |
| The harness endpoint port and its four-property conformance kit; Ollama is its first driver                                                                                           | `packages/provider-sdk/src/harnessEndpoint.ts`, `harnessEndpointConformance.ts`; `apps/server/src/providers/ollamaDriver.ts`                                                                                            |
| The host refuses tools to a model with no Verify tools record before the driver is asked                                                                                              | `refusesUnverifiedTools` in `apps/server/src/harness/nativeHarnessEndpointDriver.ts`                                                                                                                                    |
| Package lifecycle commands: inspect (with expected digest), install, update, rollback, uninstall, source trust, plugin and component switches                                         | `ExtensionCommand` in `packages/contracts/src/extensionRpc.ts`; `apps/server/src/extensions/extensionLifecycleService.ts`                                                                                               |
| Supervised executable components: deny-default Seatbelt, ready handshake, bounded output, receipts, crash limit then quarantine; no Linux confinement, so no Linux launch             | `apps/server/src/extensions/extensionSupervisor.ts`, `nodeExtensionProcessPort.ts`                                                                                                                                      |
| Host-authenticated provider call: the adapter names only the header, the host leases the key and refuses any URL outside declared hosts or the configured base URL origin             | Image seam `ImageGenerationPorts.request` in `packages/provider-sdk/src/imageGeneration.ts`; key pool in `apps/server/src/providers/credentialBrokerClient.ts`                                                          |
| Marketplace ingestion produces only `skill-instructions` and `mcp-server` components                                                                                                  | `apps/server/src/extensions/agentPluginIngestion.ts`, `codexPluginIngestion.ts`                                                                                                                                         |
| Every non-image driver kind sits in exactly one capability-matrix column                                                                                                              | `providerFeatureMatrix.test.ts`; `providerCatalogCapabilities` in `@octant/domain`                                                                                                                                      |

## Design

### Identity and the driver registry

- `ProviderDriverKind` gains one reserved family value,
  `outside-harness-endpoint`, and `ProviderInstance` one arm for it. The
  specific driver is not an enum value: the arm's configuration carries an
  **outside driver reference** `{ extensionId, packageId, componentId, version,
digest }`. The set of outside drivers is data, held by the package store.
- Every exhaustive switch over driver kinds gains exactly one case.
  `providerDriverHostRuntime` returns a fourth runtime, `outside-endpoint`; the
  capability matrix gains one column ("Outside harness endpoints") whose cells
  are at most the bundled harness endpoints' cells (see
  [capability honesty](#capability-honesty-and-fail-closed-behaviour)).
- An outside driver's display identity is its package display name with an
  "outside driver" label and a generic glyph. It cannot claim a bundled kind's
  name, logo, account profile, discovery descriptor, or sign-in dialect.
- **Family policy.** The family is a native harness kind in `@octant/domain`:
  the host owns the conversation, Octant's tools travel as request tool calls
  and reach only verified models, and the agent loop is Octant Harness. It has
  no discovery descriptor and reports no account limits
  (`runtime-does-not-report`), since the host reads no quota headers on its
  brokered calls.
- **A blocked instance.** While a driver kind is not effective on the
  activation ladder, the host reports its instances `unavailable` with the
  closed reason `driver-not-admitted`, no models, and every capability
  `unavailable`, and decides this before the driver factory runs, so no driver
  code describes its own block. A connection check refuses and keeps that
  observation rather than clearing it. The rule covers bundled kinds a patch
  disables as well as the outside family.
- **The instance arm grows with admission.** The configuration holds only the
  `kind` and the driver reference until the add-provider step lands; the
  address, key placement, and listed model ids join it in that same change.
  No command creates or reconfigures an outside instance before then, so no
  journaled instance can lack them. The provider projection's `driver_kind`
  column keeps only a non-empty check and leaves the vocabulary to the
  instance schema, so replay of such an instance needs no migration of its own.
- **The matrix column's source.** An outside package ships no capability block
  Octant reads, so `providerFeatureMatrix.test.ts` holds the column to the
  host's ceiling clamp (`outsideDriverCeiling.ts`), whose block equals the
  bundled harness endpoints' declaration.
- **Composition with data-driven bundled kinds.** Making bundled driver-kind
  registration data-driven (a bundled ACP agent as a profile plus its logo and
  tests) changes how bundled entries are declared; it keeps the bundled set
  closed at build time and exhaustive. This design adds one family to that
  closed set and keeps per-driver identity in package data, so both land in the
  same registry: bundled entries from build-time profiles, outside entries from
  admitted packages, each resolved through the activation ladder. Whichever
  lands second rebases its one new case onto the other; neither widens the enum
  per outside driver.

Rationale: widening `ProviderDriverKind` to an open string would lose the
exhaustiveness and matrix checks that keep capability claims honest, and a
second parallel identity union would touch every one of the roughly thirty
files that read the kind. One reserved family keeps the closed checks and puts
the open set where packages already live.

### Versioning and compatibility

- **Protocol.** The component declares the harness endpoint wire protocol and
  the major versions it speaks (`harness-endpoint/1`). The host speaks a
  declared set; no overlap blocks the component as `incompatible` before any
  process starts, and the `initialize` handshake confirms the chosen version.
  A protocol change that a v1 driver could misread is a new major version.
- **Application.** The manifest's existing `compatibility.app` range and
  `platforms` apply; outside the range or platform is `incompatible`.
- **Package.** An instance binds the exact `version` and `digest` it was added
  with. Verify tools records and the instance's conformance result are keyed to
  that digest, so a different digest starts unverified.

### Admission lifecycle

Each step is its own action at a local window, journaled through the existing
extension lifecycle; none implies the next.

1. **Inspect** a source with an expected digest (`inspect-package`). The review
   shows the package identity, digest, publisher and signature state, protocol
   versions, platforms, and that it holds a provider driver.
2. **Install** (`install-package`). The package is stored quarantined and
   untrusted; it contributes nothing and no process exists.
3. **Trust** the source (`set-source-trust`). Trust binds the digest.
4. **Enable** the plugin and its driver component
   (`set-plugin-desired`, `set-component-desired`). The component is now
   effective; still no provider exists.
5. **Add a provider** from the driver: name, address, how the key is sent, and
   the key (stored in the credential broker). This creates the instance,
   disabled until its first connection check.
6. **Connection check** starts the driver process and probes.
7. **Verify tools** per model, run by the host (below).

A structured reference, tool call, model output, routine, paired device, or
remote client cannot perform steps 1 to 5 or 7; the host refuses them before
any side effect. Disable drains the driver process and removes the instance's
models from pickers; uninstall, withdrawn trust, and rollback stop the process
and leave the instance blocked with its threads, history, and stored key intact
until the person removes them. Deleting the key keeps its existing separate
confirmation.

### Driver process and confinement

- **One process per provider instance**, started by the extension supervisor on
  first use and drained on disable, so two instances of one driver share no
  memory, credential lease, or request channel.
- **Runtime.** The host runs the package's single ESM entry with the Bun
  runtime that runs the server; the package ships no executable, native addon,
  or install script (refused at inspection;
  [decision 6](#maintainer-decisions)).
- **Seatbelt profile**, stricter than the MCP server profile: deny default; read
  the system roots, the runtime's install, and the package root only; write a
  per-process temporary folder only, removed at stop; **no network**; no
  process exec beyond the runtime itself and no fork. Each grant beyond
  deny-default is measured on macOS before it ships, as the extension profile's
  were.
- **Environment.** A fixed minimal set (`PATH=/usr/bin:/bin`, locale, the
  temporary folder). No inherited variables, no provider or cloud keys, no
  broker coordinates, no Project or checkout path.
- **Platforms.** Extension processes have no Linux confinement, so a Linux host
  never starts an outside driver: the component reports `host-prohibited` there.
  Windows is out of scope with Windows Work/Code.
- **Bounds.** The supervisor's ready handshake, startup deadline, bounded
  stderr, crash limit (two restarts per minute, then `quarantined`), and a
  per-message size cap. The host owns every request deadline.

### Driver process rules

These rules resolve what the section above left to implementation; each takes
the fail-closed option.

- **Who chooses the profile.** The extension process port does, for a launch
  that carries the `outside-driver` sandbox: it builds the profile with the
  shared confinement builder (`apps/server/src/process/seatbeltProfile.ts`)
  and sets the environment itself, ignoring whatever environment the caller
  passed. No caller can widen either.
- **The grants.** Read: the package root, the runtime's folder and its parent
  (and, for a Homebrew runtime, the prefix's `Cellar`, `opt`, and
  `etc/openssl@3`), `/System`, `/usr`, `/private/etc`, `/private/var/db`,
  `/Library/Apple`, the data devices `/dev/null`, `/dev/zero`, `/dev/random`,
  and `/dev/urandom`, `/` itself, and metadata of every parent folder of those.
  These are the extension profile's measured roots less `/bin` and `/sbin`
  (programs the driver may not exec) and less the rest of `/dev`, since the
  person's own terminals are devices there their user may read. Write: the
  process's own temporary folder; the package root is denied writes
  explicitly. Exec: the runtime alone, by its path and its resolved path. No
  fork, no network, no Mach service. The builder's own denials (the Keychain,
  `/private` outside these grants, other people's home folders) apply as for
  every confined launch. The escape tests in
  `outsideDriverProcess.escape.test.ts` measure this on macOS in the
  `macos-15` CI job, which passed on 2026-10-27 with no grant added
  ([job][macos-escape-2026-10-27]); a grant the runtime turns out to need is
  added only with its observed failure.
- **The environment.** Exactly `PATH=/usr/bin:/bin`, `LANG=en_US.UTF-8`, and
  the process's temporary folder as both `TMPDIR` and `HOME`, so a runtime
  that keeps a cache under its home writes only into the folder removed at
  stop and learns no path of the person's.
- **The runtime.** Only the Bun that runs the server
  ([decision 6](#maintainer-decisions)). The package store authorizes a
  driver launch only as that runtime with the entry module as its one
  argument, in the package root, under the `outside-driver` sandbox bound to
  that root, for an entry the receipt records as not executable. A server on
  any other runtime starts no driver: the packaged app runs its server on
  Electron's Node today, so a packaged build refuses every driver start as
  `runtime-unavailable` until the maintainer chooses to ship a Bun with it or
  to measure a profile for Electron's Node.
- **Platforms.** On any host but macOS the component is `host-prohibited` on
  the activation ladder, which the ladder reports before quarantine or trust,
  and both the process owner and the process port refuse before a folder or
  process exists. No Bubblewrap launch is made for a driver: that would be a
  Linux confinement design of its own.
- **One process per instance.** The supervisor keys a driver's runtime by its
  instance, so two instances of one driver never share a process. A second
  start for an instance whose process is running is refused as
  `already-running`; a start while the previous process is still ending waits
  for it to end.
- **The crash limit.** A process that exits on its own is a crash. The
  supervisor does not restart a process whose stdio another owner holds, so
  the driver process owner counts crashes per instance and digest with the
  supervisor's numbers: the next use may start the driver again, and a third
  crash within a minute quarantines that instance's driver at that digest.
  Every later start is refused as `quarantined` until the instance binds
  another digest or the host restarts. A stop the host asked for (a disable,
  or the proxy stopping a driver that broke the protocol) is not a crash.
- **The channel.** The process's stdout is split into lines on bytes, so a
  character split across reads is never torn. A line still unfinished past
  the 4 MiB cap is handed to the proxy as it stands, and the proxy's own cap
  stops the driver as `driver-incompatible`. When the process exits, every
  pending call fails at once with the closed reason `runtime-unavailable` and
  the instance reports `unavailable`, rather than each call waiting for its
  deadline.
- **Stderr** stays with the supervisor's bounded capture: 64 KiB, past which
  the process is stopped, which counts as a crash. The host never reads it
  into a client, a diagnostic, or the journal.
- **The temporary folder** is made per process, private to the person's user,
  under the host's temporary root, and removed when the process stops or
  exits.

### Wire protocol

Line-delimited JSON-RPC 2.0 over the process's stdin and stdout; stderr is
diagnostics only. Schemas live in `@octant/contracts` and the author-facing
subset is re-exported by `@octant/provider-sdk`. Every message is decoded on
the host; an undecodable or unexpected message stops the process and reports
the instance `incompatible` with a closed reason.

| Direction     | Message                                                                                           | Mirrors                                                   |
| ------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| host → driver | `initialize` (protocol versions, non-secret configuration: base URL, model ids the person listed) | ready handshake                                           |
| host → driver | `probe`                                                                                           | `ProviderDriver.probe` (models and claimed facts)         |
| host → driver | `session/open`, `session/send`, `session/cancel`, `session/release`                               | `HarnessEndpointTransport.open`, `HarnessEndpointSession` |
| driver → host | `session/event` notification                                                                      | `HarnessEndpointStreamEvent`                              |
| driver → host | `http/request`, then `http/chunk` and `http/end` from the host                                    | the brokered call below                                   |

The host-side proxy implements `HarnessEndpointDriver` over this channel, so
`runOnNativeHarness` runs an outside driver exactly as it runs Ollama. Its
synchronous parts never cross the process boundary: `admitTurn` is computed on
the host from the last probe observation and Verify tools records (as Ollama's
already is), and `fits` from the bounds `session/open` returned, or `true` when
none were given, leaving overflow to the host's existing ladder.

### Wire protocol rules

These rules resolve what the protocol table above left to implementation; each
takes the fail-closed option.

- **The host's versions.** `HOST_HARNESS_ENDPOINT_PROTOCOL_VERSIONS`
  (`harness-endpoint/1`) lives with the schemas in `@octant/contracts`, so
  inspection and the handshake read one set. `initialize` sends that set with
  the base URL and the listed model ids; a reply naming any other version stops
  the driver.
- **What the host reads.** Every schema the driver writes is strict. The driver
  stops at the first line that is over the size cap, is not JSON, names a method
  the protocol does not have, carries a field it does not name (a
  `servedModelId`, an `instanceId`, a `verifiedToolModelIds`), answers or
  streams for a call the host never made, or announces a retry (retries are the
  host's). A late answer or event for a call the host already settled
  (cancelled or timed out) is ignored rather than treated as a violation, since
  a driver cannot see the host's cancel before it answers. A stopped driver's
  instance is `incompatible` with the closed reason `driver-incompatible`, no
  models, and every capability `unavailable`; a handshake on an unknown
  version reports the same reason.
- **Failures.** A driver's JSON-RPC error is read only as structure: a
  `category`, an optional `retryAfterMs`, and an optional `contextOverflow`
  with the window when known. The host writes the message for each category
  itself, and an overflow becomes the host's own overflow sentence so the
  window is still learned. Error text, data with any other field, and anything
  else a driver rejects with become the fixed `protocol` failure. Only failures
  the proxy wrote leave it, so nothing the driver wrote reaches the provider
  service, whose endpoint failures reach a client.
- **Models.** The probe returns model ids, an optional window each, and
  capability claims. The host offers only the ids the person listed that the
  probe also reported, each named by its id, so no name the driver chose
  reaches a person; a probe that reports none of them leaves the instance
  `unavailable` with `no-usable-model`. The probe cannot add to
  `verifiedToolModelIds`; that record is the host's alone.
- **The ceiling.** A claim can lower a capability but not raise one; streaming,
  reasoning, and usage lift from `unavailable` only once a response shows
  them. Image input stays `unsupported`: the bundled harness endpoints' column
  declares it so, and no response can show it while the host refuses every
  turn with a person's attachments, which never cross the channel.
  `appManagedTools` stays `unsupported` for the whole instance, so a gate that
  reads "provider-wide support, or this model verified" (picker reach,
  delegated work) sees only the host's per-model record.
- **Host-answered calls.** `admitTurn` comes from the last observation and the
  host's Verify tools record; `fits` from `session/open`'s
  `bounds.contextWindowTokens` at about four characters a token, or `true`
  without it. A cancel answers the send as `interrupted` at once and sends
  `session/cancel`; a release sends `session/release`, and the host refuses
  every later send itself. The proxy has no `verifyToolCapability`: Verify
  tools is the host's, built with admission in slice 5.
- **The brokered call.** `GET` or `POST`; headers as name and value pairs with
  no line breaks; bodies as UTF-8 text both ways, since the services a driver
  translates speak text. The driver may not set `authorization`,
  `proxy-authorization`, `cookie`, `host`, or the header it asks the key in,
  and may not ask the key in `proxy-authorization`, `cookie`, or `host`; the
  URL's own scheme, host, and port must be the configured origin's, so a
  `blob:` address minted on that origin is refused. The reply withholds that header, `authorization`, `proxy-authorization`, and
  `set-cookie`. No redirect is followed, even on the same origin, because a
  redirect could only carry the key somewhere the person did not enter. An
  instance has at most eight brokered calls in flight.
- **Bounds.** A driver line is at most 4 MiB. `initialize`, `probe`, and
  `session/open` get 30 seconds and `session/send` ten minutes; a brokered call
  gets 10 seconds to connect, 120 seconds between response chunks (including
  the start of a refused key's body the host reads to report it), and 16 MiB
  of response.
- **The channel.** The proxy reads and writes lines through a channel
  interface; slice 3 runs it in memory, and slice 4 attaches the confined
  process's stdin and stdout. The author-facing re-export from
  `@octant/provider-sdk` lands with the author kit in slice 7, by
  [decision 8](#maintainer-decisions).

### Admission rules

These rules resolve what the admission lifecycle and the catalog left to
implementation; each takes the fail-closed option.

- **Trust is admission.** Trusting an outside driver's source lifts the
  install hold for the version and digest selected at that moment (the
  command carries the package's state version, so the person trusts what they
  saw). Any later install, update, or rollback holds it again and clears
  trust, so trust never outlives its digest; withdrawing trust holds it again,
  so trusting stays the review step. The hold is its own projection fact
  (`awaitingAdmission`), apart from a quarantine for a failed integrity check
  or a supervisor verdict, which trust never lifts. Switches still start off.
- **Admission is per instance.** One family kind covers every outside driver,
  so no kind is admitted: an instance is admitted when the package it binds is
  effective on the ladder at host scope (`resolveOutsideDriverActivation` in
  `@octant/plugin-host`): installed, trusted, switched on, compatible, safe in
  all three modes, on a host that confines it, and still selecting the exact
  version and digest the instance was added with. Any other selection is
  `superseded`. The provider service, the driver factory, and every process
  start ask this before any driver code runs.
- **Adding a provider.** `create-outside-harness-endpoint-provider` carries
  the name, the driver reference, the address, how the key is sent, and the
  listed model IDs (one to 64, unique), and no `enabled`: the provider is
  created off. The host refuses it unless the driver is admitted, normalizes
  the address under the endpoint rule (HTTPS, or HTTP on loopback; no
  credentials, query, or fragment), and, as for any endpoint, refuses a
  provider that sends no key unless its address is on loopback. The key goes
  to the credential broker through the existing per-instance key routes. No
  command reconfigures an outside instance: its package, address, key
  placement, and models are fixed when it is added, so its records cannot
  outlive what they were made for; a change is a removal and a new provider.
- **Key placement.** The person chooses the one header the key travels in
  (lowercase, never `proxy-authorization`, `cookie`, `set-cookie`, or `host`)
  and whether it goes as `Bearer`. A brokered request that asks for the key
  anywhere else, or on a provider that sends none, is refused before the key
  is read.
- **Local window only.** The route refuses adding a provider from an outside
  driver, and Verify tools, from a paired device, in addition to remote
  forwarding never admitting provider commands.
- **When the process runs.** Nothing starts when a provider is added or
  turned on, when the catalog opens, or when the host starts (the warm pass
  skips outside instances). The first connection check, Verify tools, or turn
  starts one process, and later uses share it until it ends. Turning the
  provider off or removing it, turning the plugin or component off, a
  rollback, withdrawn trust, or another digest stops it; an uninstall stops
  it before the supervisor drains the package, so none of these counts toward
  the crash limit. A stopped process fails its calls in flight at once, and
  the instance then reports the block.
- **A crash is the instance's.** Runtime evidence that one driver process
  crashed is kept as a diagnostic but does not mark the package broken: one
  package serves every instance added from it, and the per-instance crash
  limit decides what a crash costs.
- **Verify tools.** The host opens one session through the proxy and sends one
  request with the echo tool and its fixed prompt. The model is verified only
  when the response holds a call to the echo tool; the driver's own words
  count for nothing. It is offered only for models the person listed that the
  last check reported, and its record lands in the provider catalogue like
  every endpoint's.
- **Digest-bound records.** An instance's observation, Verify tools record,
  and conformance belong to the digest it binds. A package that selects
  another digest leaves the instance `driver-not-admitted` with no models,
  keeping the instance, its records, threads, and key until the person
  removes them; slice 6 rebinds an instance on trust and clears its records.
- **The catalog group.** The registry snapshot lists every effective outside
  driver from a local folder (`outsideDrivers`), with the package's name, the
  exact reference, and installed and trusted from the activation context.
  Settings shows them under their own heading, labelled "Outside driver"
  rather than bundled, and continues only the providers bound to that digest.
  The setup adds a provider in place (name, address, how the key is sent, the
  key, the model IDs); the provider's card on Providers & Models holds its
  key, its facts, and Verify tools, since it has no Model endpoints page. The
  Package facts say "Local folder, unsigned", trusted by the person at this
  digest. A driver that is not effective is not listed; its instances show
  the block on their cards.

### Credentials and egress

- The driver never holds a credential. `http/request` names a URL, method,
  headers, body, and the auth header and scheme to use; the host leases a key
  for **this instance only** from the broker, adds the header, sends the
  request, and streams the response back without that header. A provider
  refusal of the key is reported to the pool by the host's own status check.
- The host refuses a URL whose origin is not the instance's configured base URL
  before it reads the key: HTTPS, or HTTP on literal loopback, as for every
  endpoint. Redirects are not followed off that origin, and the credential is
  never sent to a redirect target. Response bytes and time are host-bounded.
- With no network in the profile, the brokered call is the driver's only
  egress, so model traffic reaches only the address the person entered.

### Provenance and updates

- **Digest pinning.** Inspection and install pin `name@version` and its
  content digest; trust and Verify tools records bind that digest.
- **Signing.** A package from a marketplace source carries a publisher
  signature over its manifest and digest; first trust pins the publisher key,
  and a later version signed by another key is refused until the person
  re-trusts it as a new publisher. A local-folder package is unsigned developer
  input, labelled so in review ([decision 3](#maintainer-decisions)).
- **Updates are never automatic.** No background check runs. An update is an
  inspect and install of the new digest, which arrives quarantined while the
  trusted version keeps serving; trusting it switches the instances, restarts
  their processes, and clears their Verify tools records. Rollback uses the
  existing `rollback-package` and also clears them.

### Marketplace and catalog

- A new public schema in `@octant/plugin-api`, separate from the unchanged
  bundled `ProviderDriverCatalogEntry`, admits an outside entry: exactly one
  `provider-driver` component, a package-relative entry point, the declared
  protocol versions, **no declared capabilities**, no contributions, and a
  source that is not `bundled`. Any other field is refused.
- Sources: `local-folder` first, then the npm package source after signing is
  in place. Ingestion gains `provider-driver` only for packages that carry
  this schema; nothing infers a driver from another format.
- The provider catalog lists effective outside drivers in their own group,
  repeating installed and trusted from the activation context, as bundled
  entries do. Opening it starts nothing.

### Manifest, inspection, and quarantine

These rules resolve what the decisions above left to implementation; each
takes the fail-closed option.

- **The entry.** `OutsideProviderDriverEntry` (`@octant/plugin-api`) is
  `{ driverKind, protocolVersions, manifest }`: the family kind, one or more
  `harness-endpoint/<major>` versions, and an extension package manifest held
  to the rules under [Marketplace and catalog](#marketplace-and-catalog). Its
  entry point is a `.mjs` or `.js` file path inside the package with no
  scheme and no `.` or `..` segment. `readOutsideProviderDriverEntry` returns
  a closed `OutsideProviderDriverRefusalReason` instead of throwing.
- **A bundled-kind claim** is a `driverKind` other than the family, a slug
  equal to any `ProviderDriverKind` value, or a `builtin:` entry point. A slug
  is the package's name in Settings and in `@` addressing, so a bundled
  kind's name there would read as that driver.
- **The driver document.** A folder is a driver package when its root holds
  `octant-provider-driver.json`; such a folder is read as a driver and as
  nothing else, and no other layout is read as a driver. A folder whose root
  also holds a language server's `octant-language-server.json` is refused as
  neither, since each of those packages is read as nothing else. The
  document is the entry without the facts only the host can state: the
  manifest's `extensionId`, `packageId`, `source`, and `digest`, and
  provenance `reviewed` and `reviewedAt`. A document that states one is refused rather
  than overwritten, so the document a person reviews is the one the host
  used. The host derives the identity from the folder and the slug, so a
  package cannot name itself into another package's identity, and records a
  local folder as unreviewed.
- **Source.** Only a `local-folder` source yields a driver until publisher
  signatures exist ([decision 4](#maintainer-decisions)); a driver document
  in any other source is refused as `source-unsupported`.
- **Protocol.** A package that declares no version the host speaks
  (`harness-endpoint/1` today) is refused at inspection as
  `protocol-incompatible`, as an incompatible app range or platform already
  is, rather than installed only to block later.
- **Files.** Inspection refuses a package holding any file with an execute
  permission, native code (a `.node`, `.dylib`, `.so`, `.dll`, or `.exe`
  name, or a Mach-O, universal, ELF, or PE header under any name, since a
  name proves nothing), or an install script (an install lifecycle script or
  `gypfile` in any `package.json`, or a `binding.gyp`, either name matched in
  any letter case, as a case-insensitive macOS volume reads it). The entry module must
  exist and must not be executable; the package inspector holds every
  provider-driver entry to that.
- **Refusal copy.** The extension API answers each refusal reason with fixed
  Octant copy; nothing from the package is repeated.
- **Quarantined install.** Bundled drivers are never stored as packages, so
  a stored package holding a provider-driver component is an outside driver.
  The extension projection holds it `quarantined`, untrusted, and switched off
  whenever its selected version changes (install, update, rollback), with an
  `outside-driver-quarantined` diagnostic. Switches and runtime evidence are
  recorded but leave the hold in place; trusting the source is the admission
  step that lifts it at the selected digest (see
  [Admission rules](#admission-rules)). Until then every component reports
  `quarantined`, so no structured reference or mention can select one and no
  process exists.
- **Local window only.** The lifecycle route refuses every command from a
  paired device, in addition to remote forwarding never admitting it, and a
  paired device cannot inspect or preview a registered driver folder, since
  an inspection is what an install consumes. Registering a folder was already
  local-window only.

### Conformance

Conformance is enforced by the host, not trusted from the author:

- **By construction.** The proxy makes the kit's four properties hold whatever
  the driver does: unverified tools are refused before any request (host
  `admitTurn`); a cancel rejects as `interrupted` because the host aborts and
  answers; a released session is refused by the host without asking the
  driver; and any rejection that is not a decodable `ProviderFailure` becomes a
  fixed `protocol` failure. `runHarnessEndpointConformance` runs against the
  proxy with a misbehaving fixture driver to prove it.
- **At use.** The handshake must agree a protocol version and the probe must
  decode, or the instance is `incompatible`. Verify tools is run by the host
  through the proxy: it offers the echo tool and checks the returned tool calls
  itself, so a driver cannot certify its own models.
- **For authors.** An out-of-process kit runs the same properties against a
  driver binary in the author's CI. Its evidence is advisory and never enables
  anything.

### Capability honesty and fail-closed behaviour

- The driver's probe claims are clamped on the host by a ceiling equal to the
  bundled harness endpoints' column: conversation host-owned; no provider
  approvals, user questions, file changes, model switch, or runtime compaction;
  Octant's tools only for verified models; streaming, reasoning, usage, and
  image input only after a response shows them. A claim above the ceiling is
  ignored, not an error.
- Free-form driver text (probe messages, failure text, stderr) never reaches a
  client. Readiness and failures map to closed Octant-authored reasons.
- Any of: not effective on the ladder, protocol mismatch, process start
  failure, crash limit, digest change, or decode failure makes the instance
  contribute no models, tools, or capabilities, with a structured reason.

### Privacy and data lifecycle

- No telemetry and no Octant-hosted service. Network use is the inspect and
  install fetch on the person's action and the instance's own endpoint.
- The driver process sees the requests it translates, including file content
  that Work and Code tools put in the conversation; that content goes only to
  the endpoint the person configured. Project provider policy (including the
  person-maintained `eu` and `zdr` tags) applies to an outside instance like any
  other.
- Stored state: the package in the extension package store; the instance and
  its digest binding, probe observation, and Verify tools records in the
  journal; the key in the credential broker; transcripts in the host's harness
  journal. The driver has no persistent storage. Uninstall removes the package
  files; instance records, threads, and the key stay until the person removes
  them, and the host data map lists where each lives.

## Threat model

The attacker is the driver package (malicious or compromised) or whoever can
put a package in front of the person. Controls marked new are this design's;
"built" marks one a landed slice has made real.

| Threat                                                              | Control                                                                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exfiltrates prompts, code, or files                                 | New, built (escape tests pass on macOS): no network, read only its package, no Project path; only egress is the brokered call to the configured origin              |
| Steals or replays a credential                                      | New, built for the brokered call: never holds one; host injects the header per request and strips it from responses; broker coordinates absent from the environment |
| Uses another instance's or provider's credential                    | New, built: one process and one request channel per instance; the lease is keyed by that instance                                                                   |
| Escapes to the host (files, processes, other extensions)            | New, built (escape tests pass on macOS): deny-default Seatbelt without exec or fork; Linux refuses to launch                                                        |
| Over-claims capabilities (tools, approvals, resume)                 | New, built: host ceiling clamp; `admitTurn` computed by the host; host-run Verify tools                                                                             |
| Fabricates tool calls or injects instructions in output             | Existing: model output is untrusted; the harness offers, approves, and runs tools under thread authority; taint rules apply                                         |
| Puts attacker text in Settings or diagnostics                       | New, built: closed reasons only; stderr bounded and kept out of clients                                                                                             |
| Swaps code under a trusted name (update, mirror, typosquat)         | New, built for trust: digest-bound trust and records. New: publisher key pin, quarantined updates that clear verification                                           |
| Points the key at an internal service or attacker host              | Existing endpoint rule, built for the brokered call: HTTPS or loopback HTTP, origin-checked before the key is read; no redirect                                     |
| Exhausts the host (floods, hangs, crash loops)                      | Existing supervisor bounds; new, built: per-message cap, host-owned deadlines, bounded brokered calls, per-instance crash limit                                     |
| An agent, mention, routine, or paired device installs or trusts one | Existing and new, built: lifecycle, add-provider, and Verify tools only from a local window; structured references stay inert; install stays held until trusted     |
| Impersonates a bundled provider                                     | New, built: one reserved family; package-name identity with an outside label; no bundled logo, account profile, or sign-in dialect                                  |

Residual risk: the configured endpoint receives what the person sends it, as
for any endpoint; a trusted driver can mistranslate (send a different model id,
drop content) within that origin; and a person can trust a harmful package.
These are the same trust a person extends to an endpoint address and are made
explicit in review copy.

## Already settled by existing specifications

- Installation never implies trust, activation, enablement, or authority;
  structured references cannot install, trust, enable, or elevate (`AGENTS.md`
  product invariants).
- New providers reach the host only through the published seams, and a seam is
  extended in its own change rather than bypassed (`AGENTS.md`).
- The activation ladder and its block reasons, executable quarantine, and
  supervised processes ([Architecture: extensions and skills](../architecture.md#extensions-and-skills)).
- Honest capability, closed probe reasons, and verified-models tool reach for
  harness endpoints ([Architecture: providers](../architecture.md#providers)).
- Credentials live in the host credential broker and are referenced only by
  opaque id; the endpoint origin rule and host-authenticated calls
  ([Architecture: security and authority](../architecture.md#security-and-authority)).
- Marketplace network only on user action; no telemetry; local-first.

## Maintainer decisions

The maintainer accepted these on 2026-10-26. Each states the rule; the
alternatives considered and the reason for the choice follow it.

1. **Driver shapes admitted.** Harness endpoints only. Rejected for now: outside
   ACP profiles over the host's ACP stack, and managed processes. Both launch
   agent CLIs with filesystem and shell reach and need their own confinement
   design.
2. **Egress.** Only the configured base URL origin, for the first release.
   Deferred: fixed hosts the manifest declares, shown in review; considered only
   with a concrete driver that needs them.
3. **Signing.** Marketplace sources carry a publisher Ed25519 signature with the
   key pinned at first trust; local folders are digest-pinned only and labelled
   as developer input. Rejected: digest pinning alone for marketplace sources.
   Deferred: an Octant-signed allow-list, which needs an Octant review
   operation and signing key; and npm provenance attestations, which need a
   transparency-log client.
4. **Sources.** Local folders first, then npm packages once signing lands.
   Deferred: a curated driver catalog.
5. **Platforms.** macOS only. Linux follows a Linux extension-process
   confinement design; until then Linux reports `host-prohibited`.
6. **Driver runtime.** One ESM entry on the server's Bun runtime, with no
   executables. This keeps one measured profile and no native code to review.
   Rejected: any executable the package ships.
7. **Modes.** Chat, Work, and Code with verified-model tools, like bundled
   harness endpoints. The driver cannot reach anything the configured endpoint
   does not already receive. Rejected: Chat only at first.
8. **Author kit publication.** The protocol schemas and out-of-process
   conformance kit stay in this repository until slice 7. Publishing them to
   npm then needs an npm organization and account, and stays a maintainer
   action.

## Delivery slices

Each slice is one reviewable PR that updates this file's delivery state and the
threat model rows it makes real. "Linux container" means an agent can implement
and verify it without macOS, accounts, or hardware.

| #   | Slice                                  | Acceptance                                                                                                                                                                                                                                           | Verification                                                                                                  | Linux container                                                              |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Outside family identity                | `outside-harness-endpoint` kind, instance arm with driver reference, `outside-endpoint` host runtime, matrix column; nothing admits it yet, so an instance of it reports a structured block and no models                                            | Contract tests; `providerFeatureMatrix.test.ts`; replay of an existing journal; typecheck consumers           | Yes                                                                          |
| 2   | Outside driver manifest and quarantine | Public outside entry schema; local-folder inspection accepts it and refuses capabilities, contributions, executables, install scripts, bundled-kind claims; install leaves it quarantined; remote and structured-reference lifecycle actions refused | Schema tests; inspector tests; route permission negatives                                                     | Yes                                                                          |
| 3   | Wire protocol and host proxy           | Protocol schemas; proxy implementing `HarnessEndpointDriver` over an in-memory channel; brokered `http/request` with per-instance lease and origin check; ceiling clamp; closed reasons                                                              | `runHarnessEndpointConformance` against the proxy with a misbehaving fixture; credential and origin negatives | Yes                                                                          |
| 4   | Confined driver process                | Supervisor launch with the driver profile and minimal environment; one process per instance; Linux reports `host-prohibited`                                                                                                                         | Escape tests on macOS: network, files outside the package, exec, environment; crash-limit test                | Code and Linux refusal yes; acceptance runs in the `macos-15` CI job         |
| 5   | Admission end to end                   | Trust, enable, add provider, connection check, host-run Verify tools, digest-bound records, disable and uninstall behaviour; Settings catalog group                                                                                                  | Server integration test with the fixture driver; rendered Settings QA; live loopback smoke on macOS           | Server and rendered QA yes; live smoke needs macOS with a local model server |
| 6   | Provenance                             | Publisher signature verification, key pin at first trust, quarantined updates that clear verification, rollback                                                                                                                                      | Signature and update tests; journal replay                                                                    | Yes (decision 3)                                                             |
| 7   | Author kit and example driver          | Out-of-process conformance kit and serve helper; the example loopback driver passes it                                                                                                                                                               | Kit tests; example driver in CI                                                                               | Yes; npm publication is a maintainer action (decision 8)                     |
| 8   | npm source                             | Ingestion of signed `provider-driver` packages from npm with exact `name@version` and digest                                                                                                                                                         | Ingestion tests; pinned-fetch integration test                                                                | Yes, once slice 6 has landed signing (decision 4)                            |

Slice 1 depends only on this design. Slices 2 and 3 can proceed in parallel
after it; 4 needs 3; 5 needs 2 to 4; 6 to 8 follow 5. Slice 1 lands after, or
rebases onto, the change that makes bundled driver-kind registration
data-driven, since both touch driver registration.

## Verification

Each slice's verification is listed above. Evidence that the design holds
overall: the escape tests in slice 4 and the misbehaving-fixture conformance
run in slice 3 are the security acceptance; the macOS loopback smoke in slice 5
is the product acceptance. The security architecture threat model carries the
rogue provider driver abuse case
([AC6](../security/security-architecture-threat-model.md#ac6--rogue-outside-provider-driver)).

[macos-escape-2026-10-27]: https://github.com/Ogard-Labs/octant/actions/runs/40537495871/job/122306586053
