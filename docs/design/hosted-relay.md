# Hosted relay

This topic specification owns the design of a ciphertext-only relay that lets
an already-paired Octant app reach its host when no LAN, private-mesh, or SSH
path works: the relay service, the host's outbound connection to it, the
client's path choice, the relay grant, and what the relay operator can learn.
Architecture owns the boundaries it must keep: remote access and the client
trust rule ([Security and authority](../architecture.md#security-and-authority)),
host-initiated network calls
([Overview and principles](../architecture.md#overview-and-principles)), and
release scope ([Current Release Boundary](../architecture.md#current-release-boundary)).

**Status: accepted 2026-10-26; slice 1 (contracts and policy) is built and in
review, reached by no transport.** The maintainer unlocked
this parked workstream as authorized post-preview work and accepted the
decisions below on 2026-10-26. Nothing below is in force until its slice
lands; until then the private-network-only rules in Architecture are the whole
behavior. Opening hosted-relay scope in `AGENTS.md`
and the architecture's Current Release Boundary is a separate change, and no
implementation slice merges before it.

## No reachability gap has been demonstrated

This design exists because the maintainer asked for it, not because evidence
requires it. The earlier assessment still stands: no dogfood run has produced a
reachability failure that LAN, a private mesh, or a user-managed SSH tunnel
could not fix. Symptoms that look like relay demand usually have another
cause:

| Symptom                                    | Usual cause                            | Prefer                                                         |
| ------------------------------------------ | -------------------------------------- | -------------------------------------------------------------- |
| Phone cannot reach the host off home Wi-Fi | No mesh; CGNAT; host asleep            | A private mesh on host and phone; wake policy                  |
| Browser on another LAN machine fails TLS   | Wrong bind, cert trust, HTTP attempted | The listener rules in Architecture                             |
| SSH tunnel works but is fiddly             | User-managed tunnel UX                 | Docs and pairing polish                                        |
| Work laptop cannot join a personal mesh    | Organization policy, not product       | That organization's mesh or SSH; Octant must not be the bypass |

The evidence that would justify operating a relay is written dogfood showing
an already-paired device and an awake host with no ciphertext path between
them after a mesh and SSH were each tried. Until it exists, the rule
(Maintainer decisions, 1) is self-hosting only: a person who has the problem
runs their own relay, and Octant operates nothing.

## Outcome

A person who turns the relay on for a host can reach that host from an
already-paired desktop or phone app over any network that allows outbound
HTTPS, through a relay they or Octant run. The relay forwards opaque bytes. It
holds no authority, sees no plaintext, needs no Octant account, and can be
self-hosted as one process with no database.

## What exists today

- **Private listener.** HTTPS bound only to an address the classifier calls
  private LAN or Tailscale (`classifyRemoteListenerAddress` in
  `packages/domain/src/remoteAccessPolicy.ts`; `apps/server/src/privateListener.ts`),
  administered only over the loopback administration channel
  (`apps/server/src/remote/privateListenerAdministrationRoutes.ts`).
- **End-to-end authentication already independent of the network.** A
  self-made listener certificate whose SubjectPublicKeyInfo hash the pairing
  code carries as `tlsPin` (`selfMadeListenerCertificate.ts`,
  `packages/domain/src/remotePairingCode.ts`); a signed host hello answering a
  client nonce (`packages/client-runtime/src/hostHelloVerification.ts`); and a
  device-key proof, replay nonce, CSRF value, and exact-origin check on every
  request (`packages/domain/src/remoteRequestProofPolicy.ts`,
  `apps/server/src/remote/remoteHttpAuthentication.ts`).
- **Client trust rule.** `packages/client-runtime/src/remoteListenerTrust.ts`
  and the TLS 1.3 Node transport `remoteListenerTlsNode.ts`; the phone's
  `apps/mobile/modules/octant-pinned-tls`. A pinned origin replaces platform
  validation with the pin; every resolved and connected address must be
  private. That address rule is the only thing a relay path changes.
- **Source classes are closed allow-lists.** Transport facts carry
  `sourceClass` (`loopback`, `lan-private`, `tailscale`, `unknown`) and an
  HMAC `sourceKey` of the peer address (`apps/server/src/remoteRequestFacts.ts`).
  Admission refuses `unknown` (`remoteAdmissionPolicy.ts`); pairing claim and
  negotiation (`remoteProtocolService.ts`), authenticated requests
  (`remoteHttpAuthentication.ts`), and ticket minting
  (`localDeviceAdministrationRoutes.ts`) each accept only the three named
  classes. The audit projection's `source_class` column has a `CHECK` on the
  same four values (`apps/server/src/persistence/migrations.ts`).
- **No relay in use.** There is no outbound host connection for remote access
  and no relay service. The wire contract and pure policy below exist
  (`packages/contracts/src/hostedRelay.ts`, and `hostedRelayProtocol.ts`,
  `remoteSourceAdmission.ts`, and `hostedRelayPathPolicy.ts` in
  `packages/domain/src`), but no listener gate, transport, or client calls
  them, and no transport produces the `relayed` class.

## Settled by existing specifications

- The host is the only authority; a remote principal never exceeds host, mode,
  provider, Project, or thread authority, and every remote mutation is
  journaled with its principal (Architecture: Security and authority).
- Listener, pairing, and device administration are loopback-only; the listener
  forwards none of those routes.
- Pinned trust replaces platform validation and never falls back. A browser
  cannot check a self-made certificate, so it never pairs with one and so
  cannot use a relay.
- Disconnected clients follow the existing Recovery rule (Architecture:
  Persistence): reads catch up from the snapshot on reconnect; nothing queues
  an authority-bearing mutation for later delivery.
- Remote/mobile core capability, lifecycle, and security stay app-managed
  (Architecture: Plugin boundaries). The relay connector is host transport, not
  a plugin; no plugin registers a relay or sees a relayed stream.
- No Octant account; a host-initiated external connection needs a Settings off
  switch and is listed in Overview and principles when it ships.

## Design

### Shape: a blind pipe for the existing pinned TLS

The relay splices two TCP streams. Inside the splice runs the same TLS 1.3
session, pinned to the same listener key, carrying the same signed requests a
device sends on the private network. The relay terminates only an outer TLS
hop to itself.

```text
device ──TLS(relay)──▶ relay ◀──TLS(relay)── host connector
   └──────── inner TLS 1.3, pinned to the listener key ────────┘
```

- **Outer hop.** TLS 1.3 to the relay's own HTTPS origin on port 443 with ALPN
  `octant-relay-1`, validated by the platform (a self-hosted relay may instead
  be pinned by a `sha256-` pin the person enters with its URL). Before the
  splice, each side exchanges a few length-prefixed JSON frames (at most 4 KiB
  each, decoded strictly) defined in `@octant/contracts`.
- **Host side.** The host keeps one outbound control connection to the relay.
  When a device arrives, the relay names a fresh 256-bit stream id on that
  connection; the host opens a new outbound connection presenting the stream
  id, and the relay splices it to the device. The host has no inbound port.
- **Inner session.** The host hands the spliced bytes to the listener's own TLS
  configuration through an in-process entry, never through a socket whose peer
  address the classifier could read as private. Those streams carry
  `sourceClass: "relayed"` and a `sourceKey` derived from the route id, so each
  device has its own budget. The request origin is still the paired listener
  origin; the relay adds no origin to admit.
- **Inner ClientHello.** Over the relay the device sends no SNI (pinned trust
  checks no name, and a mesh name would tell the relay the person's tailnet),
  offers ALPN `http/1.1` only, and sends no TLS early data. TLS 1.3 encrypts
  the listener certificate, so a relay that forwards a device's handshake
  never sees the pin.
- **Active probing.** That guarantee covers forwarded traffic only. The relay
  operator, or anyone holding a route id, can open its own inner handshake
  through a registered route and receive the listener certificate: its key
  (so the pin) and the name it is made for, a private address or a mesh name.
  Neither lets the prober impersonate the host or pass device authentication,
  and the person is told before turning the relay on.

Rationale for accepting the probe: the certificate authenticates the host but
is not a secret, and a prober can already run the pre-authentication routes
(see the threat model). Hiding it would need a device-authenticated gate in
front of the listener handshake, a second authentication protocol with its own
proofs and replay rules, which is what reusing the pinned session avoids. A
person who does not want an operator to learn the mesh name self-hosts the
relay.

Rationale: reusing the pinned listener session keeps one cryptographic
protocol, one audited trust rule, and one set of request proofs. A separate
end-to-end layer (a Noise channel or WebRTC data channel) would add a second
key-agreement stack to review and keep in step. A service that terminates the
listener's TLS was rejected because it would hold plaintext and could act as
the device. Hole punching still needs a rendezvous service and fails under the
symmetric NAT that motivates a relay. Public ingress to the listener (port
forwarding or a public mesh funnel) is what the address classifier exists to
refuse.

### Wire contract

- **Framing.** Each frame is a 2-byte big-endian body length, then a compact
  JSON body of at most 4,096 bytes of printable ASCII. A reader refuses a
  length over the limit from the prefix alone, before buffering the body, and
  refuses an empty body, any byte outside printable ASCII, an unknown kind,
  and any field the kind does not define. The ALPN `octant-relay-1` versions
  the protocol, so frames carry no version field.
- **Frames.**

  | Connection          | Sender | Frames, in order                                                                                                |
  | ------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
  | Host control        | Host   | `control-open`, then any of `route-challenge-request`, `route-register`, `route-unregister`                     |
  | Host control        | Relay  | `control-ready`, then `route-challenge`, `route-registered`, `route-unregistered`, `stream-offer`, or `refused` |
  | Host stream         | Host   | `stream-accept` naming the offered stream id                                                                    |
  | Device              | Device | `route-open` naming the grant's route id                                                                        |
  | Host stream, device | Relay  | `splice-ready`, after which every byte is the spliced inner session, or `refused` and close                     |

- **Registration.** The host asks for a challenge (256 random bits, single
  use, 30 seconds), then sends the route id, the route key as an Ed25519
  SubjectPublicKeyInfo in unpadded base64url, the challenge, and an Ed25519
  signature over `octant.relay-route-registration.v1`, the challenge, and the
  route id, each on its own line. The relay registers the route only when the
  key derives the route id and the signature verifies. A key in any other
  algorithm is refused rather than negotiated. `route-unregister` carries no
  proof, so a control connection may unregister only a route it registered;
  any other is refused as `route-unavailable`, so a route id alone neither
  cuts a host off nor confirms the route exists.
- **Refusals.** `route-unavailable` (an unknown route and an offline host
  alike), `stream-unavailable`, `challenge-unavailable`, `proof-refused`,
  `route-limit`, `rate-limited`, and `frame-refused`. Only a refusal on the
  control connection names a route id.
- **Grant.** `relayOrigin` is one canonical HTTPS origin: a lowercase name, a
  dotted-decimal IPv4 address, or a bracketed IPv6 address in its shortest
  form, and an optional port other than 443, with no path, credentials, or
  trailing slash. A spelling a URL parser would rewrite, such as `127.1`, is
  refused. `relayPin` is a `sha256-` pin in the listener pin's form. Any other
  field is refused.

Rationale: a 2-byte prefix covers the 4 KiB bound, and printable ASCII is
all any field can hold, so refusing early on either costs nothing.
Binding the route id into the signed message means one signature answers one
challenge for one route. The grant allows a port other than 443 because a
self-hosted relay, and the loopback relay the host and client smokes run, may
not own port 443; the outer hop's own trust still judges whatever origin it
names.

### Routes, grants, and pairing

- **Pairing stays on the private network.** A relayed stream can never pair:
  ticket minting, claim, and pairing status do not admit `relayed`, and the
  host never mints a ticket for it. A device reaches the host directly once
  (LAN, mesh, or an SSH tunnel to the listener) before it can use a relay.
- **Route.** For each paired app device with pinned trust, the host makes an
  Ed25519 route key. The route id is the unpadded base64url SHA-256 of
  `octant.relay-route.v1`, a newline, and the public key's
  SubjectPublicKeyInfo. The host registers a route by signing the relay's
  fresh challenge for it, so a route id cannot be claimed by anyone who only
  knows it. A host registers at most 64 routes.
- **Grant.** The host gives a device its grant only over that device's
  authenticated session: `{relayOrigin, relayPin?, routeId}`. The grant
  carries no key and authorizes nothing at the host; it only says where the
  device may knock. The device keeps it in that origin's pairing record beside
  the pinned trust.
- **Withdrawal.** Revoking the device, the device's credential expiring,
  turning the relay off, changing the relay URL, or Reset relay routes
  unregisters the route at the relay and deletes its key. Revocation already
  ends the device's sessions and streams; a withdrawn route ends its splices.
  Turning the relay on again mints new routes, so an old grant never revives.

Rationale: one route per device, rather than one per host, lets the host cut
one device off at the relay without rotating every other device's grant. The
cost is that the relay can count a host's relayed devices and tell them apart
pseudonymously; it already sees each device's address.

### Path choice on the client

- A client uses the relay for an origin only when the origin's record holds
  pinned trust and a grant, and the person has not turned the relay off for
  that host on this device.
- It tries the direct private path first, under the existing address rule,
  and falls back to the relay only when that path fails to connect within
  three seconds. It re-tries direct on each reconnect.
- A direct path that fails to connect includes a name that does not resolve
  and the address rule refusing every resolved address before anything is
  sent. A direct path that reaches a peer which then fails the pin or the
  signed host hello does not fall back: that refusal is shown, because a relay
  would hide a wrong host on the person's network.
- On the relay path the address rule is replaced, not relaxed: the client
  dials only the grant's relay origin, judged by the outer hop's own trust,
  and runs the inner handshake held to the pin exactly as on the private path.
  A pin mismatch over the relay is the same refusal, with the same copy, as
  on the private path.
- The client shows when a host is reached through a relay and names the relay
  host, so the person knows who sees the connection metadata.

### Authority over a relayed stream

A relayed device keeps the authority its device session has. The `relayed`
class is admitted for hello, negotiation, authentication challenge, session,
and authenticated product requests, and refused for every pairing route and
ticket. Everything else an admission or route classifier refuses stays
refused. Network position grants nothing in the current model, so the device
key, not the path, carries authority (Maintainer decisions, 4).

The listener's other unauthenticated routes (health, the host list, the
sandboxed design page) and the web client's static files refuse `relayed`
too. Only a browser or a web view uses them, and neither holds pinned trust,
so neither can reach a relay; refusing them keeps the internet-reachable
surface to the steps a paired app takes. Loopback, private LAN, and Tailscale
sources keep every gate they have today, and an unclassified source is
refused at every gate. One difference from today is deliberate and left to
slice 3: the listener boundary hands a static-file request from an
unclassified peer to the file handler's own Host and origin check rather than
refusing it, and slice 3 either keeps that pass-through or adopts the table's
refusal knowingly. The server's source-class checks keep their current
three-class allow-lists until slice 3 replaces them with this table.

### Settings and administration

- **Host.** Settings › Remote access › **Reach this computer through a relay**
  is off by default, with a relay URL field that starts empty: Octant offers no
  relay of its own (Maintainer decisions, 1). The switch requires a running
  listener with a self-made certificate. `octant relay enable --url
<origin> [--pin <sha256-…>]`, `octant relay disable`, and `octant relay
status` use the same loopback administration channel. A paired device can
  read whether a relay is on but can never turn it on, change its URL, or ask
  for another device's grant.
- **Off means off.** While the switch is off the host opens no connection to a
  relay. Turning it off closes the control connection and every splice.
- **Device.** A paired computer or phone lists each host's relay use and can
  turn it off for that host; Forget and Remove delete the grant with the key.

### Data lifecycle

| Item                                         | Where                                                                  | Removed by                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| Relay setting (URL, pin)                     | Host data directory, owner-only, beside the listener setting           | Disable; complete data removal                                 |
| Route private keys                           | Host data directory, owner-only, atomic write like the TLS key         | Withdrawal (above); complete data removal                      |
| Relay enabled, grant issued, route withdrawn | Journal, with device id and a route-id fingerprint, never the route id | Journal retention                                              |
| Grant                                        | Device's pairing record                                                | Forget, Remove, sign-out, re-pair, a newer grant from the host |
| Route table                                  | Relay memory only                                                      | Host disconnect, unregister, relay restart                     |

Route keys and route ids never appear in a route response other than the
device's own grant, a log line, diagnostics, or an error message.

### Relay service

- One stateless process: an in-memory route table, the frame protocol, the
  splice, and limits. No database, no account, no content inspection beyond
  requiring the device's first inner byte to be a TLS handshake record.
- An unknown route and an offline host get the same refusal, and the relay
  never buffers bytes for a host that is not connected.
- It persists no per-connection record by default. Aggregate counters (routes
  registered, splices open, bytes) are the only operational data.
- Self-hosting is the same build: one executable or container behind the
  operator's own TLS certificate, configured by environment (listen address,
  certificate, limits).

## Threat model

What each party can do once the relay is on:

| Party                                    | Can                                                                                                                                                                                             | Cannot, and why                                                                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay operator, honest but curious       | See host and device IP addresses, when each connects, splice durations and byte counts, relayed devices per host, client TLS fingerprints                                                       | From forwarded traffic, read content or learn the listener key, host identity, device keys, host name, or mesh name: inner TLS 1.3 encrypts the certificate and no SNI is sent              |
| Relay operator, malicious                | Drop, delay, or cut streams; swap a device onto another host's route; run handshakes against a route it knows and so read the listener certificate (key, pin, and private address or mesh name) | Impersonate the host (pin), replay a session (fresh TLS 1.3, no early data), mint or forge a grant (only the host issues one, over the pinned session), act as a device (device-key proofs) |
| Network observer near either end         | See that the device or host talks to the relay                                                                                                                                                  | See route ids or inner traffic: the outer hop is TLS                                                                                                                                        |
| Anyone without a route id                | Reach the relay                                                                                                                                                                                 | Reach the host: no inbound port; an unknown route is refused                                                                                                                                |
| Holder of a leaked or revoked route id   | Open the listener's TLS handshake and pre-authentication routes over the relay, and read the listener certificate                                                                               | Pass device authentication; once withdrawn, reach the host at all                                                                                                                           |
| A stolen paired device                   | Reach the host from any network, not only the private one, until revoked                                                                                                                        | Exceed its device authority; outlive revocation or the existing inactivity and absolute device lifetimes                                                                                    |
| Someone using the relay as a free tunnel | Move opaque bytes between two endpoints that both speak the frame protocol                                                                                                                      | Exceed per-route quotas and lifetimes (below)                                                                                                                                               |

Three changes are real and are stated where the person turns the relay on:

- **Metadata leaves the private network.** The operator can link a device's
  address to the host's address and see when the host is used. Traffic size
  and timing can reveal activity such as a streaming turn. No padding is
  planned.
- **The pre-authentication surface widens.** Hello, negotiation, and the
  authentication challenge become reachable from the internet by anyone
  holding a route id, where today they are reachable only from the private
  network. The existing budgets apply per route, and withdrawal cuts a route
  off.
- **The listener certificate becomes readable.** Whoever can use a route,
  the operator included, can read the listener's key and the private address
  or mesh name it is made for (Active probing, above).

### Abuse and denial of service

Relay limits, each a configured default the operator can change:

- per source address: 4 control connections, 30 new connections a minute;
- per route: 8 concurrent splices, 12 hours per splice (a device session's
  absolute lifetime), an idle cut after 5 minutes without bytes in either
  direction (slice 3 confirms the host's long-lived streams write within that
  window), and a daily byte quota;
- per host control connection: 64 routes; registration and stream ids are
  single-use and expire after 30 seconds.

The relay cannot tell Octant traffic from other TLS traffic and does not try
beyond the first-record check; quotas bound what misuse costs. The host keeps
its own per-route pre-authentication budget and refuses a route whose budget
is exhausted until it recovers.

### Availability

The relay is a fallback with no availability promise. The direct path is always
tried first. A relay that is down, slow, or refusing leaves the device where it
is today off-network: disconnected, reconnecting, with nothing queued. A
relayed request in flight when a splice breaks has the same unknown outcome as
any dropped connection and the same idempotent command-id handling. One relay
per host in v1.

## Maintainer decisions

The maintainer accepted these on 2026-10-26. Each states the rule; the
alternatives considered and the reason for the choice follow it.

1. **Who operates a relay.** Self-host only: the URL field starts empty and
   user docs show how to run the relay. An Octant-run relay makes Octant the
   custodian of who connects to whose computer and when, for no demonstrated
   need. Considered:
   - Octant runs one, offered as the default URL when the switch is turned on
     (deployment, DNS, TLS, operator contact, terms, abuse handling, and cost
     become release steps). Rejected.
   - Both, with the Octant-run relay only after written evidence. This is the
     only way the decision is revisited, and only with the evidence above;
     operating a relay would still need its own maintainer action for
     deployment, accounts, and spending.

2. **Where the relay service lives.** In this repository as `apps/relay`, with
   the frame contract in `@octant/contracts` and end-to-end tests in one CI.
   The protocol is coupled to the host and client, and self-hosters build from
   the release they run. The slice that creates it adds the ownership row to
   `AGENTS.md`. Rejected: `octant-webapp` beside the Canvas share service, and
   a repository of its own.

3. **How far to build before evidence.** The self-hostable path end to end
   (slices 1–4), off by default. Self-hosting adds no Octant cloud dependency,
   and the slices are independently reviewable. Slice 6 waits on decision 1.
   Rejected: design only, and contracts and pure policy only.

4. **Authority of a relayed device.** The device session's full authority,
   minus pairing. Authority is bound to the device key; narrowing by path would
   make the same device behave differently by network without stopping a
   thief, who can also use a mesh. Rejected: narrower authority (for example,
   no terminal or dev-server relaying).

5. **Pairing over a relay.** Never. First contact stays on a network the person
   controls, and SSH covers a headless remote host. Rejected: a later pairing
   code that carries a grant.

## Delivery plan

Each slice is one reviewable PR; slices 2 and 3 can proceed in parallel after
slice 1. No implementation slice merges before the release-boundary change.

1. **Contracts and policy.** Frame schemas (`RelayFrameV1`), the grant schema,
   the route id derivation, the `relayed` source class and the admission table
   that admits it for session routes and refuses it for pairing, and the client
   path-choice policy. Acceptance: strict decode refuses unknown fields and
   oversized frames; route ids derive from the key; pairing, claim, and
   ticket minting refuse `relayed`; path choice picks relay only with pinned
   trust and a grant, after direct fails. Verification: focused contract and
   domain tests, typecheck of consumers. **Linux container: yes.**
   **Built, in review:** the schemas in `packages/contracts/src/hostedRelay.ts`;
   route ids, the registration message, and frame reading and writing in
   `packages/domain/src/hostedRelayProtocol.ts`; the admission table in
   `remoteSourceAdmission.ts`; and path choice in `hostedRelayPathPolicy.ts`.
   Nothing outside their tests calls them yet.
2. **Relay service.** `apps/relay`: registration with possession proof, route
   table, splice, limits, the first-record check, and identical refusal for
   unknown and offline routes; a compiled executable and a container recipe.
   Acceptance: a spliced stream passes bytes unchanged; squatting, unknown
   routes, expired stream ids, and every quota are refused; nothing is
   written to disk. Verification: unit and hostile tests over real sockets on
   loopback. **Linux container: yes.**
3. **Host connector.** Loopback administration routes and `octant relay`, the
   Settings switch, owner-only route-key storage, the control connection with
   backoff, the in-process relayed entry with `relayed` transport facts and
   per-route source keys, grants issued over authenticated sessions,
   withdrawal on revoke, expiry, off, and reset, and the audit-projection
   migration. Acceptance: off opens no connection; a paired device cannot
   enable the relay or read another grant; a relayed stream cannot pair;
   revoke ends its splices; nothing secret reaches the journal or
   diagnostics. Verification: route registration, permission negatives,
   migration and replay tests, and a host-plus-relay smoke on loopback.
   Overview and principles gains the relay as a host-initiated connection.
   **Linux container: yes.**
4. **Desktop client.** Node transport over the relay (inner TLS over the outer
   stream, no SNI, no early data), direct-first path choice, the "through a
   relay" indicator, Forget and per-host off. Acceptance: a paired desktop
   reaches a second host through a local relay with the private address
   unreachable, a swapped route fails the pin before any request byte, and
   Forget removes the grant. Verification: client-runtime tests, the two-host
   smoke extended through a relay, rendered QA of Settings and the indicator.
   **Linux container: yes** (rendered QA in a headless browser).
5. **Phone client.** The pinned TLS module layered over an outer relay
   stream on iOS and Android, path choice, and the indicator. Acceptance: the
   phone reaches its host through a relay off the home network, and a pin
   mismatch refuses before any request byte. Verification: module tests and
   a device run. **Needs macOS, Xcode, and physical devices (maintainer).**
6. **Octant-run relay (only if decision 1 is revisited on evidence).** Deployment, DNS, TLS,
   limits, operator contact, terms, and the default URL. Acceptance: the
   service runs the slice 2 build unchanged and keeps no per-connection logs.
   **Needs accounts, spending, and deployment authority (maintainer).**

Evidence gate, in parallel and maintainer-owned: a written dogfood run that
records a reachability failure with LAN, mesh, and SSH results, which revisiting
decision 1 needs.

## Verification

This change is design only; the format and path checks cover it. Each slice
names its own evidence above. The relay invariants every slice must keep
testable: ciphertext only (no relay code parses inner bytes beyond the first
record type), no authority (the relay holds no key the host or device trusts
for anything but the outer hop), no account, off by default, and fail closed
when the relay is gone.
