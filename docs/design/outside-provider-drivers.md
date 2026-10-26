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
`outside-endpoint` host runtime, and the capability matrix column. Nothing
admits an outside driver yet, so an outside instance reports
`driver-not-admitted` with no models and runs no turn; slices 2 and 3 are
next. The maintainer authorized this scope as post-preview work and accepted
the [maintainer decisions](#maintainer-decisions) below on 2026-10-26; the
release boundary in `AGENTS.md` and the architecture is updated separately.
Today only bundled drivers are admitted. Slices and their evidence are tracked
in Linear; this file states the rules they implement.

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
  bundled harness endpoints' static blocks, which are its ceiling, until the
  host's ceiling clamp has a block of its own.
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

| Threat                                                              | Control                                                                                                                                |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Exfiltrates prompts, code, or files                                 | New: no network, read only its package, no Project path; only egress is the brokered call to the configured origin                     |
| Steals or replays a credential                                      | New: never holds one; host injects the header per request and strips it from responses; broker coordinates absent from the environment |
| Uses another instance's or provider's credential                    | New: one process and one request channel per instance; the lease is keyed by that instance                                             |
| Escapes to the host (files, processes, other extensions)            | New: deny-default Seatbelt without exec or fork; Linux refuses to launch                                                               |
| Over-claims capabilities (tools, approvals, resume)                 | New: host ceiling clamp; host-run Verify tools; `admitTurn` computed by the host                                                       |
| Fabricates tool calls or injects instructions in output             | Existing: model output is untrusted; the harness offers, approves, and runs tools under thread authority; taint rules apply            |
| Puts attacker text in Settings or diagnostics                       | New: closed reasons only; stderr bounded and kept out of clients                                                                       |
| Swaps code under a trusted name (update, mirror, typosquat)         | New: digest-bound trust, publisher key pin, quarantined updates that clear verification                                                |
| Points the key at an internal service or attacker host              | Existing endpoint rule: HTTPS or literal-loopback HTTP, origin-checked before the key is read; no cross-origin redirect                |
| Exhausts the host (floods, hangs, crash loops)                      | Existing supervisor bounds plus new per-message cap and host-owned deadlines                                                           |
| An agent, mention, routine, or paired device installs or trusts one | Existing and new: lifecycle actions only from a local window; structured references stay inert                                         |
| Impersonates a bundled provider                                     | New, built: one reserved family; package-name identity with an outside label; no bundled logo, account profile, or sign-in dialect     |

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
| 4   | Confined driver process                | Supervisor launch with the driver profile and minimal environment; one process per instance; Linux reports `host-prohibited`                                                                                                                         | Escape tests on macOS: network, files outside the package, exec, environment; crash-limit test                | Code and Linux refusal yes; acceptance needs a macOS host                    |
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
is the product acceptance. The security architecture threat model gains an
abuse case for a rogue provider driver when slice 3 lands.
