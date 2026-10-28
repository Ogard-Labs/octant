# Hub and spokes

This topic specification owns the design of a hub-and-spoke topology: one
Octant host acting as the hub for a person's other Octant hosts (spokes) and
paired devices, how a spoke enrolls with and leaves the hub, what the hub may
do on a spoke, how spokes find and delegate to each other, how they reach each
other, and the services the hub runs for them (wake, push, relay). Architecture
owns the boundaries it extends: remote clients and the rule that hosts never
trust each other
([Security and authority](../architecture.md#security-and-authority)),
routines ([Modes](../architecture.md#modes-chat-work-and-code)), host-initiated
network calls
([Overview and principles](../architecture.md#overview-and-principles)), and
release scope
([Current Release Boundary](../architecture.md#current-release-boundary)).

**Status: proposed 2026-10-28; not accepted, nothing built.** The maintainer
asked for this design and authorized it as post-preview, design-first work on
2026-10-28. The [open decisions](#open-decisions) below need the maintainer's
answer before slice 2 starts. Nothing here is in force until its slice lands;
until then each host is its own authority, paired computers federate reads as
Architecture describes, and routines are host-local.

## Outcome

A person runs Octant on several machines (laptops, a desktop, a home server, a
cloud box). They pick one as the hub. Every other machine joins by adding only
the hub, the way a phone pairs today. After that:

1. any window or phone that knows the hub can see every spoke and act on each
   one, within what that spoke allows;
2. an agent on one spoke can hand work to another spoke and get the result
   back, under the receiving spoke's own confinement and approvals;
3. spokes reach each other on the LAN, a private mesh, SSH, or through a
   ciphertext-only relay on the hub, with no port opened on any spoke;
4. routines can be scheduled to run on a spoke that is asleep, and the hub
   wakes it; and
5. phone notifications from every spoke go out through one sender the person
   runs on the hub.

## Terms

| Term          | Meaning                                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub           | An ordinary Octant host (desktop or headless) with the hub role turned on. It is also a host in its own right with its own threads                                                       |
| Spoke         | An Octant host enrolled with exactly one hub. It keeps its own journal, files, credentials, sandbox, and approval policy                                                                 |
| Paired device | A phone, browser, or desktop window paired as today. Paired with the hub, it can be introduced to spokes                                                                                 |
| Hub grant     | The closed set of things a spoke lets its hub do, chosen on the spoke at enrollment and changeable only there                                                                            |
| Peer grant    | The closed set of things a spoke lets another spoke do to it, chosen on the receiving spoke                                                                                              |
| Introduction  | A record the hub signs that binds a spoke's or device's name to its identity key and listener pin, so a receiver can check who is knocking. An introduction authorizes nothing by itself |

## What exists today

- **Each host is its own authority.** Every authority check runs on the host
  that owns the thread. A paired device holds a revocable device key and never
  exceeds host, mode, provider, Project, or thread authority.
- **Federation of reads.** A desktop window or phone keeps a registry of paired
  hosts and merges their read models client-side (`packages/client-runtime`,
  host federation registry). Credentials and mutable authority never cross
  hosts; create and mutation name one destination.
- **Paired computers.** A desktop can pair with another computer's listener and
  drive a fixed list of routes through the pinned main-process channel
  (Architecture: Security and authority, paired computers).
- **Headless hosts.** `octant server run` runs a host with no window
  (`packages/cli`, `scripts/package-headless.ts`), administered over the
  loopback channel and the `octant` CLI.
- **Relay.** The [hosted relay](hosted-relay.md) wire contract and policy are
  in `@octant/contracts` and `@octant/domain`; the relay service, host
  connector, and clients are not built.
- **Push.** The host seals redacted notifications per phone and hands them to a
  transport that never sends until the push gateway lands
  ([Mobile maturity: delivery path](mobile-maturity.md#delivery-path)).
- **Routines.** Definitions, revalidation, and the scheduler live in the host
  that owns the Project. Nothing wakes a sleeping computer.

## Settled by existing specifications

These hold for every slice and are not reopened here:

- The server that owns a thread is its authority. Authority checks run on that
  host before any side effect, never in a client and never on the hub on the
  owner's behalf.
- The journal is per host. No host replays, rewrites, or becomes the
  projection source for another host's journal.
- Credentials never leave the host that holds them except through an explicit,
  per-credential grant the person makes on that host (see
  [Credentials](#spoke-to-spoke-discovery-and-delegation)).
- Install never implies trust or enablement. Nothing the hub sends to a spoke
  installs, trusts, enables, or elevates anything there.
- Code starts approval-gated; Plan is read-only; Work never silently becomes
  Code; an agent cannot mark a thread Done. A request that arrives from the hub
  or another spoke changes none of these.
- Remote listener, pairing, and device administration stay on the loopback
  administration channel. Enrollment and grant changes on a spoke are local
  actions on that spoke.

## Design

### Roles

- **Hub.** Turned on in Settings › Remote access › **Act as hub** or
  `octant hub enable`, on a host with a running private listener. The hub keeps
  a directory of its spokes, signs introductions, and may run the wake service,
  the relay, and the push sender (each its own switch, all off by default).
  The hub is also its own spoke for its own threads, with no special authority
  over them beyond what it already has as their host.
- **Spoke.** Any Octant host that joins one hub. A spoke has at most one hub in
  this design; leaving one hub is required before joining another
  ([open decision H4](#open-decisions)).
- **Paired device.** A phone or window pairs with the hub as it pairs with any
  host today. The hub may then introduce it to spokes, and each spoke decides
  whether to accept that device (decision H2).

Rationale: making the hub an ordinary host with a role, rather than a separate
product or service, keeps one server, one listener, one pairing protocol, and
one update path. A headless Linux box or an always-on Mac mini is the expected
hub, because the hub's services only help while it is awake.

### Enrollment: a spoke adds only the hub

Enrollment reuses pairing. It runs on the spoke, as a local action:

1. On the hub, the person chooses **Add a computer**. The hub mints a pairing
   code, as for a phone, marked for a spoke.
2. On the spoke, the person runs **Join a hub** in Settings or
   `octant hub join <code>`. The spoke reaches the hub's listener over LAN, a
   private mesh, or an SSH tunnel; first contact never goes through a relay,
   for the same reason a device never pairs through one
   ([Hosted relay: decision 5](hosted-relay.md#maintainer-decisions)).
3. Both sides show the comparison code; the person approves on the hub.
4. The spoke shows the **hub grant** screen (below) with nothing ticked beyond
   the directory entry, and the person chooses what the hub may do. The spoke
   records the hub's identity key and listener pin.
5. Each side now holds a device key for the other: the spoke is a paired device
   of the hub, and the hub is a paired principal on the spoke, of a new kind
   `hub` whose authority is exactly the hub grant.

Leaving and removal:

- **Leave** (on the spoke, local only) revokes the hub principal, withdraws
  every peer grant made through the hub, unregisters relay routes the hub
  serves, and drops the hub's introductions. The spoke's threads, Projects,
  and credentials are untouched.
- **Remove spoke** (on the hub) revokes the spoke's device on the hub and drops
  it from the directory, so the hub stops introducing it. The spoke keeps
  working on its own and keeps any peer grant it made until it revokes them;
  the hub cannot reach into the spoke to remove them
  ([open decision H3](#open-decisions) asks whether a spoke should drop
  hub-introduced peers automatically when the hub disappears).
- Every enrollment, grant change, leave, and removal is journaled on the host
  where it happened, with its principal.

### What the hub may do on a spoke

The hub grant is a closed list. Each item is off unless the person on the
spoke turns it on, and the spoke checks it on every hub request:

| Hub grant item     | Lets the hub                                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Directory (always) | Know the spoke's name, identity fingerprint, listener pin, addresses, relay route, and online or asleep state                                                                                             |
| Status             | Read host resources, running threads' titles and states, waiting approvals (count and kind), and update status, the same read a paired device has                                                         |
| Introduce          | Introduce devices and other spokes to this spoke (they are then judged by decision H2 and the peer grant)                                                                                                 |
| Wake               | Hold this spoke's routine wake times and wake it (see [Wake service](#wake-service))                                                                                                                      |
| Push               | Receive this spoke's sealed phone notifications and send them through the hub's push sender                                                                                                               |
| Relay              | Serve this spoke's relay routes                                                                                                                                                                           |
| Provision          | Offer configuration (below). Every offer lands on the spoke as a proposal the person on the spoke applies, unless the person turned on auto-apply for that kind of offer ([decision H5](#open-decisions)) |
| Act                | Act on the spoke as a paired device would, within the Projects the person names: create threads, send turns, answer questions. Approvals stay on the spoke (below)                                        |

**Provisioning** offers are data, never code paths. The kinds are: an update
channel (the hub may mirror the signed update feed, because the feed signature,
not the server, is the trust root), a plugin or skill from the hub's catalog
(arriving installed-but-untrusted, under the ordinary activation ladder),
agent profiles and model endpoint rows without secrets, and a routine
definition. A routine definition offered by the hub is authored on the spoke
by the spoke's own principal when applied, so it gets the spoke's ordinary
authority ceiling and revalidation.

**What a spoke always keeps**, whatever the hub grant says:

- its files and checkouts, which the hub never reads except through a thread
  or tool read the spoke authorizes like any paired device's;
- its credentials (provider sign-ins, API keys, SSH identities, Keychain
  items), which never leave the spoke;
- its sandbox, confinement posture, and approval policy, which the hub cannot
  set or loosen;
- the final say on risky actions: a Full access posture, a remembered "always
  allow", a Code approval, a Work-to-Code promotion, a credential grant, and a
  pull-request merge are each decided only by a person on the spoke's local
  window or by a device the spoke itself accepted, never by the hub principal;
- its own enrollment: only the spoke joins, leaves, or changes the hub grant,
  and only locally.

Rationale: the hub is a convenience the person can lose without losing any
machine. If the hub could hold credentials or approve, compromising the one
always-on box would compromise every machine, which is the failure a
self-hosted control plane most needs to avoid.

### Spoke-to-spoke discovery and delegation

**Discovery.** A spoke with a hub reads the hub's directory: each spoke's
name, identity fingerprint, listener pin, addresses, relay route, online
state, and which delegation it accepts. A spoke appears only if its own hub
grant includes Directory, which is always on, and only to spokes of the same
hub.

**Introduction and the peer grant.** Before spoke A can do anything on spoke B,
the hub introduces A to B. B shows the introduction to its person, who chooses
a **peer grant** for A (default: none; [decision H2](#open-decisions) covers
auto-accept). A peer grant names:

- whether A may delegate work to B, and into which of B's Projects;
- the mode and the highest posture B will run that work at (Work ask-first,
  Code approval-gated, or Plan read-only; never Full access);
- which provider profiles on B that work may use; and
- whether A may read B's status.

**Delegation.** An agent on A delegates by asking A's host for a remote child
run on B. A's host checks A's own rules first (the parent thread's mode and
authority, and that subagents are allowed), then sends B a signed request
naming the target Project, the task, and a narrowed authority. B then:

1. checks the peer grant and clamps the request to the smaller of the peer
   grant and B's own Project authority (equal or narrower, as for any child
   run);
2. creates an ordinary thread on B, journaled with the principal `peer:A` and
   the delegating thread's reference, under B's confinement;
3. raises every approval on B, delivered to B's local windows and to devices B
   accepted. The person may answer from any of those; A's agent cannot answer
   B's approvals, and neither can the hub; and
4. returns the result to A as data with provenance (a summary, the final
   message, and artifact references), which A records as an external-content
   tool result. Nothing B returns becomes an instruction on A.

A delegated thread on B belongs to B: it appears in B's sidebar and board, and
only a person can mark it Done there. A's thread shows the remote child's
state as read through B, and cancelling the parent asks B to interrupt the
child.

**Credentials.** No credential crosses with a delegation. The work on B uses
B's own provider sign-ins and B's own Git and SSH identities. A grant that lets
a specific credential cross (for example, a provider API key A lends to B for
one Project) is a separate, per-credential action the person takes on the
host that holds the credential, through the credential broker, revocable
there, and is [open decision H6](#open-decisions); until it is decided, no
credential crosses.

Rationale: delegation as a remote child run reuses the existing subagent rule
(equal or narrower, clamped server-side) and the existing paired-principal
path, so B never needs a new authority model. The result coming back as data
keeps a compromised spoke from steering another spoke's agent.

### Connectivity

A spoke reaches the hub, and spokes reach each other, the way a paired device
reaches a host today, in this order:

1. **Direct**, under the existing address rule: a private LAN or Tailscale
   address, or an SSH tunnel the person set up.
2. **Relay**, when direct fails: the hub may run the self-hosted relay from the
   [hosted relay design](hosted-relay.md) (`apps/relay`, the same build), and
   each spoke registers its routes there. The inner session is still TLS 1.3
   pinned to the destination spoke's listener key, so the hub, as relay
   operator, forwards ciphertext and gains no authority from relaying. The
   relay's threat model applies unchanged, including that its operator can
   read listener certificates and connection metadata; here that operator is
   the person's own hub.

Spokes never open an inbound port to the internet. A spoke behind CGNAT keeps
one outbound control connection to the hub's relay. The hub's own listener
needs to be reachable from every spoke: on a mesh, a LAN, or through the relay
of another host the person runs.

### Wake service

Routines today run only while their host is awake, and nothing wakes it
(Architecture: Routines, asleep or offline). The hub may run a self-hosted
wake service for spokes whose hub grant includes Wake:

- **The spoke keeps the routine.** Definitions, authority snapshots,
  revalidation, and runs stay on the spoke. The spoke tells the hub only each
  routine's next occurrence time and an opaque routine id, never its prompt,
  Project, or profile.
- **The hub wakes, the spoke decides.** Shortly before an occurrence, the hub
  wakes the spoke. When the spoke's host is running, it fires its own timer
  and revalidates as today; a missed occurrence follows the routine's own
  missed-run policy. The hub's message is a nudge, never a command to run; a
  spoke that receives one for a routine it does not have, or early, does
  nothing.
- **How it wakes.** By Wake-on-LAN magic packet when the hub and spoke share a
  broadcast domain and the spoke's firmware and OS allow it (on a Mac, "Wake
  for network access"), or by a message over the spoke's existing connection
  when the machine is awake but the host is idle. A machine that is powered
  off, on a different network, or not set to wake cannot be woken; the hub
  records the occurrence as unreachable, and the spoke handles it on return
  under its missed-run policy. The hub stores each spoke's MAC address only if
  the person entered it on the spoke.
- **Hub-held schedules.** A routine the person wants to run "on whichever
  spoke is awake" is not in this design; a routine always belongs to one
  spoke's Project.

Rationale: keeping definitions on the spoke means a compromised hub can at
worst wake a computer early or not at all. It can never start work the spoke's
person did not define.

### Push sender on the hub

The hub can host the push sender that
[Mobile maturity](mobile-maturity.md#delivery-path) describes:

- Spokes whose hub grant includes Push hand their sealed notification
  envelopes to the hub instead of sending them themselves. The content is
  sealed to the phone's key on the spoke, so the hub forwards what it cannot
  read, exactly as the gateway does.
- The hub then either forwards to the push gateway named in its own
  Notifications setting, so phones get notifications from every spoke through
  one registration, or, when the person runs their own build of the phone app
  with their own Apple and Firebase credentials, sends to Apple and Google
  directly. Which of these is supported first is
  [open decision H7](#open-decisions): a hub cannot deliver to the store build
  of the phone app without the signing account's push credential, which only
  Octant holds.
- A notification remains awareness only; opening it lands on the thread on the
  spoke that owns it, where that spoke's authentication applies.

### Journal and authority boundaries

| Item                                             | Owner and journal                                          | Never                                                    |
| ------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------- |
| Threads, turns, approvals, Done                  | The spoke that runs them                                   | Mirrored into the hub's journal                          |
| Enrollment, hub grant, peer grants, leave        | The spoke, as local actions                                | Changed by the hub or a peer                             |
| Directory, introductions, removal                | The hub                                                    | Treated by a spoke as a grant                            |
| Delegation request and result reference          | The delegating spoke (A)                                   | Treated as authority on B                                |
| Delegated thread                                 | The receiving spoke (B), principal `peer:A`                | Approvable from A or the hub                             |
| Wake times (routine id, next time, optional MAC) | The hub, rebuilt from spoke reports                        | Holds the routine's prompt, Project, or profile          |
| Push envelopes in transit                        | Not journaled on the hub; counts and failure category only | Readable by the hub                                      |
| Relay routes                                     | As in the hosted relay design                              | Carry authority                                          |
| Credentials                                      | The host that holds them                                   | Sent anywhere except by an explicit per-credential grant |

All-hosts views stay client-side merges, as Architecture's federation rule
says. The hub does not serve a merged read model of spokes' threads; a client
that knows the hub reads each spoke directly after introduction.

## Threat model

| Party                             | Can                                                                                                                                                        | Cannot, and why                                                                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A compromised hub                 | Use every hub grant each spoke gave it; introduce a fake spoke or device; drop or delay wakes, push, and relay; read directory metadata and relay metadata | Approve on a spoke, read a spoke's credentials, change a hub or peer grant, loosen a sandbox, read sealed push content or relayed traffic, or act on a spoke that never granted Act |
| A compromised spoke               | Use the peer grants other spokes gave it; send bad results back to a delegating spoke                                                                      | Exceed those grants; answer approvals on another spoke; make another spoke's agent follow its output as instructions (results are data)                                             |
| A spoke's agent                   | Ask its own host to delegate within its thread's authority                                                                                                 | Choose the peer grant, approve on the receiver, widen authority, carry a credential                                                                                                 |
| A paired device introduced by hub | What each accepting spoke's device policy allows                                                                                                           | Reach a spoke that did not accept it; pair through a relay                                                                                                                          |
| Network observer                  | See that machines talk to the hub or relay                                                                                                                 | Read traffic (pinned TLS end to end) or forge an introduction (signed by the hub's identity key)                                                                                    |
| Someone on the hub's LAN          | Send Wake-on-LAN packets, as anyone on that LAN already can                                                                                                | Make a spoke run anything: a wake starts no routine the spoke did not define                                                                                                        |

The biggest risk is the hub as introducer: whoever controls the hub can tell a
spoke that an attacker's key belongs to another spoke. Two rules bound it:
an introduction authorizes nothing until the receiving spoke chooses a peer
grant (decision H2 decides whether that choice can be automatic), and a peer
grant never exceeds approval-gated Code, so every risky step still waits for a
person on the receiving spoke.

## Open decisions

These are the maintainer's to make; the design above notes where each one
matters. The recommendation is the option the design currently assumes.

| ID  | Question                                                                                       | Options                                                                                                                                                 | Recommended                                                                                     |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| H1  | Does the hub need to be always on, and what does a spoke do while the hub is down?             | (a) Spokes keep working alone; direct peer connections already set up keep working; wake, push, and relay pause. (b) A standby hub takes over           | (a). A standby hub is a later design                                                            |
| H2  | Does a spoke accept hub introductions (spokes and devices) automatically?                      | (a) Each introduction waits for a person on the spoke. (b) Auto-accept with a default peer grant of status-only. (c) Auto-accept with delegation        | (b) for status-only, (a) for anything that can start work                                       |
| H3  | When a spoke leaves or its hub disappears, are peer grants made through that hub dropped?      | (a) Dropped on leave; kept if the hub is merely unreachable. (b) Kept until revoked one by one                                                          | (a)                                                                                             |
| H4  | One hub per spoke, or several?                                                                 | (a) One. (b) Several, each with its own hub grant                                                                                                       | (a) for v1                                                                                      |
| H5  | May the person allow the hub's provisioning offers to auto-apply on a spoke?                   | (a) Never; every offer is a proposal. (b) Per kind (update channel, untrusted plugin install, profile without secrets), never routines                  | (b), off by default                                                                             |
| H6  | Can a credential ever cross to another spoke?                                                  | (a) Never. (b) A per-credential lend, made on the holding host, scoped to one peer and Project, revocable, never readable by the receiver's agent       | (a) for v1; (b) as its own design with the credential broker                                    |
| H7  | Which push path does the hub support first?                                                    | (a) Forward to the push gateway from Mobile maturity. (b) Send directly with the person's own Apple and Firebase credentials for a self-built phone app | (a); (b) only once self-building the phone app is documented                                    |
| H8  | Where does the hub's wake service and directory live?                                          | (a) In the Octant server (`apps/server`), on when the hub role is on. (b) A separate process like `apps/relay`                                          | (a), as the maintainer suggested; the relay stays its own process because it is internet-facing |
| H9  | Can a spoke itself act as a relay or introducer for another spoke when the hub is unreachable? | (a) No. (b) Yes, for spokes it already has a peer grant with                                                                                            | (a)                                                                                             |

## Delivery plan

Each slice is one reviewable PR and keeps everything off by default. The
Linux-container column says whether an agent can verify the slice without the
maintainer's hardware.

1. **This design and the rule changes.** Release boundary and architecture
   updated to allow a self-hosted wake service and hub-and-spoke work. Docs
   only. **Linux container: yes.**
2. **Contracts and pure policy.** The `hub` and `peer` principal kinds, the
   hub grant and peer grant schemas, introduction records and their
   signature, the directory entry, the delegation request and result, and the
   pure clamping policy (peer grant ∩ Project authority, never Full access).
   Acceptance: strict decode refuses unknown fields; clamping never widens;
   an introduction without a peer grant authorizes nothing. Verification:
   focused contract and domain tests. Waits on H2, H4, H6. **Yes.**
3. **Enrollment and the hub role.** Hub enable, Add a computer, Join a hub,
   Leave, Remove spoke, the hub grant screen, and the directory, all through
   the loopback administration channel and `octant hub`. Acceptance: only the
   spoke can join, leave, or change its grant; the hub principal is refused
   every route outside its grant; leave revokes everything the design lists.
   Verification: route registration, permission negatives, a two-host smoke on
   loopback. **Yes.**
4. **Introductions and client views.** A device paired with the hub is
   introduced to spokes and appears in federation; spokes see each other in
   the directory. Acceptance: a spoke that has not accepted a device refuses
   it; a forged introduction refuses. Verification: client-runtime tests and a
   three-host smoke. **Yes**, rendered QA in a headless browser.
5. **Delegation.** Remote child runs from A to B with the peer grant,
   `peer:A` principal, approvals on B, results as data, and cancel.
   Acceptance: B refuses a request outside the grant or above approval-gated
   Code; an approval on B cannot be answered from A or the hub; the result is
   recorded on A as external content. Verification: server tests and a
   three-host smoke with a fake provider; a real-provider run is a maintainer
   gate.
6. **Relay on the hub.** Run `apps/relay` beside the hub and register spokes'
   routes. Depends on hosted-relay slices 2 and 3. **Yes.**
7. **Wake service.** Spokes report wake times; the hub sends Wake-on-LAN or a
   nudge; the spoke fires its own timer. Acceptance: the hub never learns a
   routine's prompt or Project; a nudge for an unknown routine does nothing.
   Verification: server tests; a real Wake-on-LAN wake of a sleeping Mac is a
   maintainer gate (hardware).
8. **Push through the hub.** Spokes hand sealed envelopes to the hub, which
   forwards per H7. Depends on the push gateway slices in Mobile maturity.
   Verification: transport tests against a local gateway; a device delivery
   is a maintainer gate.
9. **Provisioning.** Update-feed mirror, catalog offers, profiles, and routine
   offers as proposals, with per-kind auto-apply per H5. Acceptance: nothing
   offered installs trusted, enables, or carries a secret. **Yes.**

Any slice that would deploy an Octant-operated service, create an account, or
spend money stops for a separate maintainer action.

## Verification

This change is design only; the format, path, and decision-archive checks cover
it. The invariants every slice must keep testable: the spoke is the only
authority over its threads; the hub principal is refused outside its grant;
no approval, credential, or sandbox change can come from the hub or a peer;
results from another spoke are data; and every hub service is off until the
person turns it on.
