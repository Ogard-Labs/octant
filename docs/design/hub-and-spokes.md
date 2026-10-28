# Hub and spokes

This topic specification owns the design of a hub-and-spoke topology on a
person's own devices: one running Octant host turned into the hub, an optional
standby hub that takes over when the hub is down, the person's other computers
joining as spokes, and their phones joining as guests. It covers how a member
joins and leaves, what the hub may do on a spoke, how spokes find and delegate
to each other, failover, and the services the hub runs for its members (wake
and push). Architecture owns the boundaries it extends: remote clients and the
rule that hosts never trust each other
([Security and authority](../architecture.md#security-and-authority)),
routines ([Modes](../architecture.md#modes-chat-work-and-code)), host-initiated
network calls
([Overview and principles](../architecture.md#overview-and-principles)), and
release scope
([Current Release Boundary](../architecture.md#current-release-boundary)).

**Status: proposed 2026-10-28; decisions settled, nothing built.** The maintainer
asked for this design and authorized it as post-preview, design-first work on
2026-10-28, and set its shape the same day: a running instance enabled as hub,
members paired by QR or manual code over a private network such as Tailscale,
a standby hub for failover, personal devices only, phones as guests that run
no agents, and a hub that runs as a server without the desktop app and serves
the web app to a phone or laptop over Tailscale. The maintainer settled the [decisions](#decisions) below
the same day. Nothing here is in force until its
slice lands; until then each host is its own authority, paired computers
federate reads as Architecture describes, and routines are host-local.

## Outcome

A person runs Octant on their own devices, for example a Mac mini at home and
two laptops, and has a phone. The Mac mini runs the Octant server with no
desktop app open, and they turn it into the hub. Each laptop and the phone
joins by scanning the hub's QR code or typing its code, over Tailscale or the
home LAN. A phone or laptop with no Octant installed opens the hub's web app
in a browser at its Tailscale name. After that:

1. any member window or phone sees every spoke and can act on each one, within
   what that spoke allows;
2. an agent on one spoke can hand work to another spoke and get the result
   back, under the receiving spoke's own confinement and approvals;
3. every member knows every other member's private-network address and role,
   so it can reach them directly;
4. if the hub goes down, members switch to the standby hub the person chose,
   and switch back when the hub returns;
5. routines can be scheduled to run on a spoke that is asleep, and the hub
   wakes it;
6. phone notifications from every spoke go out through the hub; and
7. a device the person marks as their own (an owner device) can set up and run
   any member as if sitting at it, after Face ID, Touch ID, a device passcode,
   or a passkey, so a headless hub never needs a screen or a shell after the
   first owner exists.

**Not in scope:** members that are not the person's own devices (teams, shared
machines, other people's computers), cloud machines Octant provisions, and
members reachable only over the public internet. A person who needs to reach
the hub off their private network uses the
[hosted relay](hosted-relay.md) for their phone or a mesh such as Tailscale.

## Terms

| Term         | Meaning                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub          | A running Octant host (desktop or headless) with the hub role turned on. It is also a host in its own right with its own threads                                                                        |
| Standby hub  | A spoke the person names to take over the hub's role while the hub is unreachable. It holds a copy of the roster and wake times                                                                         |
| Spoke        | A computer running Octant, joined to one hub. It runs agents and keeps its own journal, files, credentials, sandbox, and approval policy                                                                |
| Guest        | A phone app or a browser joined to the hub. It runs no agents, has no files or Projects of its own, and acts on spokes as a paired device. It is a member of the roster like a spoke                    |
| Member       | The hub, the standby hub, a spoke, or a guest                                                                                                                                                           |
| Roster       | The hub's signed list of members: each one's name, role, identity key fingerprint, listener pin, private-network host names and addresses, and the standby order                                        |
| Hub grant    | The closed set of things a spoke lets its hub (and standby hub) do, chosen on the spoke when it joins and changeable only there                                                                         |
| Peer grant   | The closed set of things a spoke lets another member do to it, chosen on the receiving spoke                                                                                                            |
| Owner device | A member the person marked as their own. With a fresh unlock it acts on a host that honors owners with the powers of a window on that host                                                              |
| Unlock       | A signature from a key the device's platform uses only after the person proves presence (biometrics, device passcode, or a passkey with user verification)                                              |
| Introduction | The hub vouching, through the signed roster, that a name belongs to an identity key and listener pin, so a receiver can check who is knocking. What the member may then do is the receiver's peer grant |

## What exists today

- **Each host is its own authority.** Every authority check runs on the host
  that owns the thread. A paired device holds a revocable device key and never
  exceeds host, mode, provider, Project, or thread authority.
- **Pairing.** A phone or computer pairs with a host's private listener (HTTPS
  on a LAN or Tailscale address only) by a pairing code, shown as a QR code
  and as text; both sides compare a code and the host approves.
- **Federation of reads.** A desktop window or phone keeps a registry of paired
  hosts and merges their read models client-side (`packages/client-runtime`,
  host federation registry). Credentials and mutable authority never cross
  hosts; create and mutation name one destination.
- **Paired computers.** A desktop can pair with another computer's listener and
  drive a fixed list of routes through the pinned main-process channel
  (Architecture: Security and authority, paired computers).
- **Headless hosts.** `octant server run` runs a host with no window
  (`packages/cli`, `scripts/package-headless.ts`), administered over the
  loopback channel and the `octant` CLI. The private listener serves the web
  app to an authenticated remote browser. A browser pairs only with a
  listener whose certificate it trusts, which today means a certificate the
  person pasted (for example one `tailscale cert` issued); a self-made
  certificate works only for the desktop and phone apps, which check its pin.
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
- Credentials stay in the credential broker of each host that holds them, are
  never readable by an agent, and never appear in the journal, a log, or
  diagnostics. Copying one to another host is an owner's explicit act (see
  [Shared sign-ins](#shared-sign-ins)).
- Install never implies trust or enablement. Nothing the hub sends to a spoke
  installs, trusts, enables, or elevates anything there.
- Code starts approval-gated; Plan is read-only; Work never silently becomes
  Code; an agent cannot mark a thread Done. A request that arrives from the hub
  or another member changes none of these.
- The private listener binds only private LAN or Tailscale addresses.
  Listener, pairing, and device administration need window authority on the
  host: the loopback administration channel, or, once this design lands, an
  owner device with a fresh unlock ([Owner devices](#owner-devices)).

## Design

### The hub is a server first

Octant is server and client. The server is the authority and runs on its own;
the desktop app is one client of it, as are the web app, the phone app, and
the CLI. The hub depends on that:

- **Runs without the desktop app.** A hub is normally a headless host:
  `octant server run`, kept running by the CLI's service manager (a login
  service on macOS, a user service on Linux), so it starts at boot and keeps
  running with no one signed in to a window. A Mac that also runs the desktop
  app uses the same server; quitting the desktop app does not stop a hub
  ([decision H13](#decisions)).
- **Serves the web app.** The hub's private listener, on its Tailscale or LAN
  address, serves the same web app the desktop window shows. A phone or
  laptop with no Octant installed opens `https://<hub>.<tailnet>.ts.net` in a
  browser, joins as a guest with the hub's code, and from then on uses Octant
  in that browser.
- **A certificate the browser trusts.** A browser cannot check a pin, so the
  web app needs a certificate the browser already trusts. On a tailnet with
  HTTPS turned on, the hub can ask the local Tailscale daemon for its
  `*.ts.net` certificate and renew it before it expires, instead of the person
  pasting one ([decision H14](#decisions)). Tailscale obtains that
  certificate from a public certificate authority, so the machine's tailnet
  name appears in public certificate-transparency logs; the hub says so
  before it asks. The phone and desktop apps keep using the pinned self-made
  certificate and need none of this.
- **Administration needs window authority.** Turning the hub role on, the
  listener, and the join codes are administered over the loopback channel
  (Settings in a desktop window on the hub, or `octant hub` and
  `octant listener` in a shell on it) or from an owner device with a fresh
  unlock. A headless hub needs a shell once, over SSH, to turn the listener on
  and show the first join code with `octant hub join-code --owner`; after
  that the person sets it up from the browser or phone they joined as owner.
  An ordinary guest never administers the hub.

### Roles

- **Hub.** The person turns it on in a running Octant: Settings › Remote
  access › **Act as hub**, or `octant hub enable`. It needs a running private
  listener on a Tailscale or LAN address. The hub keeps the roster, shows the
  join code, and may run the wake service and the push sender (each its own
  switch, off by default). The hub is also its own spoke for its own threads,
  with no special authority over them beyond what it already has as their
  host. The expected hub is an always-on machine at home, such as a Mac mini.
- **Standby hub.** On the hub, the person may mark one or more spokes as
  standby, in order. A standby is a spoke whose computer can also act as hub;
  see [Failover](#failover).
- **Spoke.** Any of the person's computers running Octant, joined to one hub.
  A spoke is in one hub's roster at a time: one active hub, with standbys
  that take over the roster and coordination only while it is down
  ([decision H4](#decisions)).
- **Guest.** A phone app or a browser joined to the hub. A guest runs no
  agents, so it has no threads, Projects, files, or routines of its own and
  receives no delegated work. Otherwise it is a member like a spoke: it is in the roster,
  it learns every spoke's address and role, it follows failover, and each spoke
  decides what it may do there ([decision H2](#decisions)). A guest acts
  on a spoke as a paired device does today, and can start work on a spoke the
  same way.

Rationale: making the hub an ordinary host with a role, rather than a separate
product or service, keeps one server, one listener, one pairing protocol, and
one update path. A phone as a guest rather than a plain paired device lets it
follow failover and reach every spoke after joining once.

### Joining: a member adds only the hub

Joining reuses pairing. It runs on the joining member:

1. On the hub, the person chooses **Add a device**. The hub shows a join code
   as a QR code and as text, with a short lifetime, as pairing does today. The
   code carries the hub's listener origin on its private-network address and
   its listener pin.
2. On a laptop, the person chooses **Join a hub** in Settings, or runs
   `octant hub join <code>`, and scans or types the code. On a phone, they
   scan or type it in the app's add-computer flow. The member must reach the
   hub's listener over Tailscale, a similar private mesh, or the same LAN;
   joining never goes through a relay, for the same reason a device never
   pairs through one
   ([Hosted relay: decision 5](hosted-relay.md#maintainer-decisions)).
3. Both sides show the comparison code; the person approves on the hub.
4. A spoke then shows the **hub grant** screen (below) with nothing ticked
   beyond the roster entry, and the person chooses what the hub may do. A
   guest has no hub grant to choose, because there is nothing on a phone the
   hub can act on.
5. The member records the hub's identity key and listener pin, and receives
   the roster. For a spoke, the hub becomes a paired principal of a new kind
   `hub`, whose authority is exactly the hub grant; the spoke is a paired
   device of the hub.

Leaving and removal:

- **Leave** (on the member, local only) revokes the hub principal, withdraws
  every peer grant made through the hub, and forgets the roster. A spoke's
  threads, Projects, and credentials are untouched.
- **Remove** (on the hub) revokes the member's device on the hub and drops it
  from the roster, so other members stop seeing it at the next roster update.
  The removed spoke keeps working on its own and keeps any peer grant it made
  until it revokes them; the hub cannot reach into the spoke to remove them
  ([decision H3](#decisions)).
- Every join, grant change, leave, and removal is journaled on the host where
  it happened, with its principal.

### What the hub may do on a spoke

The hub grant is a closed list. Each item is off unless the person on the
spoke turns it on, and the spoke checks it on every hub request. The same
grant applies to a standby hub while it acts as hub:

| Hub grant item  | Lets the hub                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roster (always) | List the spoke in the roster with its name, role, identity fingerprint, listener pin, private-network names and addresses, and online or asleep state                                                |
| Status          | Read host resources, running threads' titles and states, waiting approvals (count and kind), and update status, the same read a paired device has                                                    |
| Introduce       | Introduce other members to this spoke; each becomes a full member here (decision H2). Ticked by default                                                                                              |
| Wake            | Hold this spoke's routine wake times and wake it (see [Wake service](#wake-service))                                                                                                                 |
| Owners          | Let the person's owner devices act on this spoke with a window's powers after a fresh unlock (see [Owner devices](#owner-devices)). Ticked by default                                                |
| Standby         | Let a standby hub the person named use this same grant while it stands in for the hub (see [Failover](#failover))                                                                                    |
| Push            | Receive this spoke's sealed phone notifications and send them through the hub's push sender                                                                                                          |
| Provision       | Offer configuration (below). Every offer lands on the spoke as a proposal the person on the spoke applies, unless the person turned on auto-apply for that kind of offer ([decision H5](#decisions)) |
| Act             | Act on the spoke as a paired device would, within the Projects the person names: create threads, send turns, answer questions. Approvals stay on the spoke (below)                                   |

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
  items), which leave the spoke only when an owner copies one
  ([Shared sign-ins](#shared-sign-ins));
- its sandbox, confinement posture, and approval policy, which the hub cannot
  set or loosen;
- the final say on risky actions: a Full access posture, a remembered "always
  allow", a Code approval, a Work-to-Code promotion, a credential copy, and a
  pull-request merge are each decided only by a person: on the spoke's local
  window, on an owner device with a fresh unlock, or (for approvals) on a
  member the spoke accepted for that; never by the hub principal, a peer, a
  routine, or an agent;
- its own membership: only the spoke joins, and only it, locally or from an
  owner device with a fresh unlock, leaves or changes the hub grant.

Rationale: the hub is a convenience the person can lose without losing any
machine. If the hub could hold credentials or approve, compromising the one
always-on box would compromise every machine, which is the failure a
self-hosted control plane most needs to avoid.

### Owner devices

All members are the person's own devices, so the person should be able to do
from their phone or laptop what they could do sitting at any of them. An
**owner device** is a member the person marked as their own; with a fresh
**unlock** it has the powers of a window on every host that honors owners.

- **Marking the first owner.** On the hub itself: in a desktop window, or by
  making the join code with `octant hub join-code --owner` in a shell on it.
  The member that joins with that code is an owner. After that, an owner
  device with a fresh unlock may mark or unmark other members. Each mark and
  unmark is journaled on the hub and carried in the signed roster.
- **Which hosts honor owners.** Each spoke chooses at join, as the hub grant
  item **Owners** ("let my owner devices act as if they were here"). It is
  ticked by default, because every member is the person's own device, and
  can be unticked for a machine that should only ever be run in person
  ([decision H16](#decisions)). A spoke that honors owners still checks
  every owner request itself.
- **The unlock key.** When a member becomes an owner, it makes a second key
  that its platform uses only after the person proves presence: Face ID,
  Touch ID, or the device passcode on a phone (a Secure Enclave key, or an
  Android Keystore key that needs user authentication); Touch ID or the login
  password on a Mac; a passkey with user verification in a browser. The
  private key never leaves that hardware. The device registers the public key
  with each host that honors owners, over its authenticated session, and the
  host shows the person the device's name before it records the key.
- **Using it.** An owner request that needs window authority carries the
  unlock key's signature over a fresh host challenge and the request's command
  id. The host accepts it for that one request, or, for administration screens
  only, for a short window ([decision H17](#decisions)). Without a fresh
  unlock, an owner device is an ordinary member.
- **What it allows,** on a host that honors owners: listener, pairing, and
  device administration (approving joins, revoking devices); setting provider
  keys and adding MCP servers with secrets; remembering Full access or an
  "always allow"; a Terminal Browser grant; the confirmed pull-request merge;
  changing that host's hub and peer grants; and copying sign-ins
  ([Shared sign-ins](#shared-sign-ins)). Each use is journaled on the host
  with the device and `owner-unlock`.
- **What it never allows.** An unlock answers one person's direct action in a
  client. An agent, a routine, the hub principal, a standby, and a peer
  never carry one, and no tool can ask a device for it. An agent still cannot
  approve its own steps or mark a thread Done. Joining a spoke to a hub still
  happens on that spoke.
- **Browsers.** A passkey belongs to one web origin, so a browser owner
  registers one passkey per host origin it uses (with decision H15's direct
  option, one per spoke). A browser without a platform authenticator cannot
  be an owner.
- **Losing a device.** Remove on the hub, an unmark from another owner device,
  or a revoke on any host ends its owner powers there; Remove ends them
  everywhere at the next roster. A thief holding the device without the
  person's face, finger, passcode, or passkey has only ordinary member powers
  until then.

Rationale: the earlier rule, that only a window on the host may administer it
or hold its most sensitive powers, assumed every other device might belong to
someone else. Inside one person's own devices that rule makes a headless hub
impossible to run without a shell, while adding little safety, because the
person is the same. The unlock key keeps what the rule protected: possession
of a member key alone, or a compromised hub, still cannot reach those powers
without the person's presence on the device.

### Shared sign-ins

An owner device with a fresh unlock can copy a sign-in from one host to
another, so the person signs in once:

- **What can be copied.** API keys and model endpoint keys from the credential
  broker, and MCP server secrets. The source host sends the value over the
  pinned session to the target host's broker, and the target stores it like a
  key the person typed there. No agent on either host can read it.
- **Records.** Both hosts journal the copy with the owner device, the source,
  the target, and the credential's name, never the value. The hub's view lists
  where each sign-in was copied.
- **Removing.** Removing a sign-in on the source does not remove the copies;
  the person removes each one, or chooses **Remove everywhere**, which asks
  each reachable host to delete its copy and lists the ones it could not
  reach. A leaked key still needs rotating at the provider.
- **Not copied yet.** Subscription sign-ins held by a provider's own app (for
  example a Claude or Codex account login) stay per machine until each
  provider's terms and token binding are checked
  ([decision H6](#decisions)). Delegated work never carries a sign-in;
  it uses what the receiving host holds.

### Spoke-to-spoke discovery and delegation

**Discovery.** Every member holds the latest roster the hub signed: each
member's name, role, identity fingerprint, listener pin, private-network host
names (for example a Tailscale name) and addresses, online state, which
delegation it accepts, and the standby order. A member checks the hub's
signature and keeps the roster with the highest sequence number it has seen.

**Introduction and the peer grant.** Before member A can do anything on spoke
B, A must appear in B's roster and B must accept it. A spoke that ticked Introduce
accepts every new member automatically as a **full member**, tells its person,
and lets them narrow or revoke that member's **peer grant** at any time
([decision H2](#decisions)). A peer grant names:

- whether A may delegate work to B, and into which of B's Projects;
- the mode and the highest posture B will run that work at (Work ask-first,
  Code approval-gated, or Plan read-only; Full access only when an owner chose
  it for that peer and Project with a fresh unlock, and only where B's own
  Project allows Full access);
- which provider profiles on B that work may use; and
- whether A may read B's status.

The full-member grant lets A read B's status and delegate into every Project
on B, at Work ask-first or Code approval-gated (never Full access), with B's
default provider profile. For a guest it is the ordinary paired-device
authority in every Project on B, including answering B's approvals the way a
paired phone does today. A browser guest reaches a spoke the way
[decision H15](#decisions) settles.

**Delegation.** An agent on spoke A delegates by asking A's host for a remote
child run on B. A's host checks A's own rules first (the parent thread's mode
and authority, and that subagents are allowed), then sends B a signed request
naming the target Project, the task, and a narrowed authority. B then:

1. checks the peer grant and clamps the request to the smaller of the peer
   grant and B's own Project authority (equal or narrower, as for any child
   run);
2. creates an ordinary thread on B, journaled with the principal `peer:A` and
   the delegating thread's reference, under B's confinement;
3. raises every approval on B, delivered to B's local windows and to members B
   lets answer. A's agent cannot answer B's approvals, and neither can the
   hub; and
4. returns the result to A as data with provenance (a summary, the final
   message, and artifact references), which A records as an external-content
   tool result. Nothing B returns becomes an instruction on A.

A delegated thread on B belongs to B: it appears in B's sidebar and board, and
only a person can mark it Done there. A's thread shows the remote child's
state as read through B, and cancelling the parent asks B to interrupt the
child. A guest never receives delegated work.

**Credentials.** No credential crosses with a delegation. The work on B uses
B's own provider sign-ins and B's own Git and SSH identities, including any an
owner copied there ([Shared sign-ins](#shared-sign-ins)).

Rationale: delegation as a remote child run reuses the existing subagent rule
(equal or narrower, clamped server-side) and the existing paired-principal
path, so B never needs a new authority model. The result coming back as data
keeps a compromised spoke from steering another spoke's agent.

### Connectivity

All members are the person's own devices on one private network. Members reach
the hub, and each other, directly under the existing address rule: a
Tailscale (or similar mesh) address, or a LAN address. The roster carries each
member's private-network names and addresses, so members connect without the
hub in the path. No member opens a port to the internet.

A phone off the private network uses the mesh app on the phone, or the
[hosted relay](hosted-relay.md) the person runs themselves, exactly as it would
without a hub. Running that relay on the hub is possible because the relay is
the same self-hostable build, but it is not part of this design's core and is
not needed when every member is on the mesh.

### Failover

The person keeps one hub active and may name standby hubs in order. Members
connect only to the active hub; the roster tells every member who the standbys
are and how to reach them.

- **What a standby holds.** A standby is a spoke whose hub grant to the hub
  includes Standby, and which the person marked on the hub. The hub sends it
  each new roster and the wake times, so it can take over the hub's services.
  It holds no more authority on other spokes than the hub has: each spoke's
  hub grant names whether it applies to the standby too, and it does by
  default only when the spoke's person ticked it at join.
- **When members switch.** A member that cannot reach the active hub for a
  set time (default five minutes) tries the first standby, then the next. A
  standby that sees no hub for that time starts acting as hub: it serves the
  roster it has, runs wake and push for members whose grants allow it, and
  tells members it is standing in.
- **Membership while standing in.** A standby that is standing in may add
  and remove members, signing each roster update with its own key. A member
  accepts a standby-signed roster only from a standby the latest hub-signed
  roster names, and only while that member cannot reach the hub. A standby
  never changes the standby order or promotes itself
  ([decision H10](#decisions)).
- **Switching back.** When the hub is reachable again, the standby steps down
  and hands back the wake times and membership changes it made, and members
  return to the hub. The hub's next signed roster includes those changes; when
  a member was both added and removed in the meantime, removal wins. If
  both are reachable at once to different members (a split network), the only
  duplicated work is a second wake nudge or a delayed notification: neither
  can start work, because spokes decide.
- **Replacing the hub for good.** Promoting a standby to hub permanently, for
  example after the Mac mini dies, is a local action on the standby that the
  person confirms, followed by each spoke accepting the new hub
  ([decision H11](#decisions)).

Rationale: the hub holds little authority (a roster, wake times, and a send
path), so a short-lived second hub costs little, and failover needs no
consensus protocol. Membership changes made during a stand-in merge back
under one rule (removal wins), so a split network cannot keep a removed
member in the roster.

### Wake service

Routines today run only while their host is awake, and nothing wakes it
(Architecture: Routines, asleep or offline). The hub, inside the Octant server,
may run a self-hosted wake service for spokes whose hub grant includes Wake:

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
  LAN and the spoke's firmware and OS allow it (on a Mac, "Wake for network
  access"), or by a message over the private network when the machine is awake
  but the host is idle. A machine that is powered off, away from home, or not
  set to wake cannot be woken; the hub records the occurrence as unreachable,
  and the spoke handles it on return under its missed-run policy. The hub
  stores each spoke's hardware address only if the person entered it on the
  spoke.
- **Hub-held schedules.** A routine the person wants to run "on whichever
  spoke is awake" is not in this design; a routine always belongs to one
  spoke's Project.

Rationale: keeping definitions on the spoke means a compromised hub can at
worst wake a computer early or not at all. It can never start work the spoke's
person did not define.

### Push sender on the hub

The hub can send phone notifications for every spoke, so a guest gets
notifications from all of them after joining once:

- Spokes whose hub grant includes Push hand their sealed notification
  envelopes to the hub instead of sending them themselves. The content is
  sealed to the phone's key on the spoke, so the hub forwards what it cannot
  read, exactly as the gateway does.
- The hub then either forwards to the push gateway that
  [Mobile maturity](mobile-maturity.md#delivery-path) describes, or, when the
  person runs their own build of the phone app with their own Apple and
  Firebase credentials, sends to Apple and Google directly. Which of these is
  supported first is [decision H7](#decisions): a hub cannot deliver
  to the store build of the phone app without the signing account's push
  credential, which only Octant holds.
- A notification remains awareness only; opening it lands on the thread on the
  spoke that owns it, where that spoke's authentication applies.

### Journal and authority boundaries

| Item                                              | Owner and journal                                          | Never                                               |
| ------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| Threads, turns, approvals, Done                   | The spoke that runs them                                   | Mirrored into the hub's journal                     |
| Joining, hub grant, peer grants, leave            | The member, locally or by an owner's unlocked act          | Changed by the hub or a peer                        |
| Roster, standby order, removal                    | The hub; a standby adds and removes while standing in      | Changed in standby order by a standby               |
| Delegation request and result reference           | The delegating spoke (A)                                   | Treated as authority on B                           |
| Delegated thread                                  | The receiving spoke (B), principal `peer:A`                | Approvable from A or the hub                        |
| Wake times (routine id, next time, hardware addr) | The hub and standbys, rebuilt from spoke reports           | Holds the routine's prompt, Project, or profile     |
| Push envelopes in transit                         | Not journaled on the hub; counts and failure category only | Readable by the hub                                 |
| Credentials                                       | The broker of each host that holds them                    | Copied except by an owner's unlocked act; journaled |

All-hosts views stay client-side merges, as Architecture's federation rule
says. The hub does not serve a merged read model of spokes' threads; a member
reads each spoke directly.

## Threat model

| Party                      | Can                                                                                                                         | Cannot, and why                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A compromised hub          | Use every hub grant each spoke gave it; add a fake member to the roster; drop or delay wakes and push; read roster metadata | Approve on a spoke, read a spoke's credentials, change a hub or peer grant, loosen a sandbox, read sealed push content, or act on a spoke that never granted Act                     |
| A compromised standby      | While standing in, what a compromised hub can, limited to the spokes whose grant covers the standby                         | Stand in while members still reach the hub, change the standby order, promote itself, or anything a compromised hub cannot                                                           |
| A compromised spoke        | Use the peer grants other spokes gave it; send bad results back to a delegating spoke; claim to be standing in as hub       | Exceed those grants; answer approvals on another spoke; make another spoke's agent follow its output as instructions; stand in unless it is a named standby in the hub-signed roster |
| A stolen owner device      | What an ordinary member can, until removed or revoked                                                                       | Use owner powers without the person's face, finger, passcode, or passkey                                                                                                             |
| A lost or stolen phone     | What each spoke allows that guest, until revoked                                                                            | Run agents, receive delegated work, or outlive Remove on the hub and revocation on each spoke                                                                                        |
| A spoke's agent            | Ask its own host to delegate within its thread's authority                                                                  | Choose the peer grant, approve on the receiver, widen authority, carry a credential                                                                                                  |
| Someone on the private net | Reach members' listeners, as today, and send Wake-on-LAN packets, as anyone on that LAN already can                         | Pass device authentication; make a spoke run anything: a wake starts no routine the spoke did not define                                                                             |

The biggest risk is the hub as introducer: whoever controls the hub can tell a
spoke that an attacker's key belongs to another member, and with full
membership by default (decision H2) that fake member gets a full-member grant
at once. The maintainer accepted this for a person's own devices. Three rules
bound it: every spoke tells its person when a member joins, so a member they
do not recognize can be revoked there; the full-member grant never reaches
Full access, which only an owner can choose with a fresh unlock; and an agent
from another member never answers an approval, so every risky step on a spoke
still waits for a person. Owner powers move the main risk to
the unlock key; it lives in each device's secure hardware and is used only
after the person proves presence.

## Decisions

The maintainer settled these on 2026-10-28. Where the maintainer left the
choice to the design, the design's recommendation was taken.

| ID  | Question                                                              | Decision                                                                                                                                                                    |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H2  | Does a spoke accept new roster members automatically?                 | Yes, as full members: delegation into every Project up to Code approval-gated, and for a guest paired-device authority. The spoke's person can narrow or revoke it          |
| H3  | When a member leaves or is removed, are its peer grants dropped?      | Dropped on leave and on a removal seen in a newer roster; kept while the hub is merely unreachable                                                                          |
| H4  | One hub per spoke, or several?                                        | One active hub. A standby takes over the roster and coordination only while the hub is down                                                                                 |
| H5  | May the hub's provisioning offers apply on a spoke without asking?    | Per kind (update channel, untrusted plugin install, profile without secrets), off by default; a routine always asks                                                         |
| H6  | Can a subscription sign-in held by a provider's own app be copied?    | Not yet; each machine signs in to its subscription itself until each provider's terms and token binding are checked. API keys copy already                                  |
| H7  | Which push path does the hub support first?                           | Forward to the push gateway from Mobile maturity; direct sending only once self-building the phone app is documented                                                        |
| H8  | Where do the hub's roster, failover, and wake service live?           | In the Octant server (`apps/server`), on when the hub role is on                                                                                                            |
| H10 | May a standby add or remove members while standing in?                | Yes; the hub takes the changes back on return, and removal wins                                                                                                             |
| H11 | How is a standby promoted to hub for good?                            | A local action on the standby; spokes whose grant covers the standby follow it, and the rest confirm the new hub locally                                                    |
| H12 | How long without the hub before members fail over?                    | A setting on the hub, carried in the roster, default five minutes                                                                                                           |
| H13 | Does the hub keep running when the desktop app on the same Mac quits? | Yes; the hub always runs as a service, and the desktop app connects to it                                                                                                   |
| H14 | Does the hub fetch its own Tailscale certificate for the web app?     | Yes, through the local Tailscale daemon, off until the person turns it on after the certificate-transparency note                                                           |
| H15 | How does a browser guest reach a spoke?                               | Directly: each spoke serves its own web app at its own Tailscale name, and the hub's web app links to it, so the hub never sees spoke traffic                               |
| H16 | Do spokes honor owner devices by default?                             | Yes: ticked at join, clearly labeled, and untickable                                                                                                                        |
| H17 | How long does one unlock last?                                        | One Face ID, Touch ID, passcode, or passkey check covers five minutes of administration screens; Full access, merge, credential copy, and owner changes each need their own |

Earlier the same day the maintainer settled that a standby hub exists (was
H1), and that no member acts as a relay or introducer except the hub and a
named standby (was H9).

## Delivery plan

Each slice is one reviewable PR and keeps everything off by default. The
Linux-container column says whether an agent can verify the slice without the
maintainer's hardware.

1. **This design and the rule changes.** Release boundary and architecture
   updated to allow a self-hosted wake service and hub-and-spoke work. Docs
   only. **Linux container: yes.**
2. **Contracts and pure policy.** The `hub` and `peer` principal kinds, the
   guest role, the hub grant and peer grant schemas, the signed roster and its
   sequence rule, the delegation request and result, and the pure clamping
   policy (peer grant ∩ Project authority; Full access only by an owner's
   choice). Acceptance:
   strict decode refuses unknown fields; clamping never widens; a roster entry
   without a peer grant authorizes nothing; an older roster never replaces a
   newer one. Verification: focused contract and domain tests. **Yes.**
3. **Hub role and joining.** The hub as a service that runs without the
   desktop app (H13), Act as hub, Add a device with QR and text codes,
   Join a hub on a computer, Leave, Remove, the hub grant screen, and the
   roster, through the loopback administration channel and `octant hub`.
   Acceptance: only the member can join, leave, or change its grant; the hub
   principal is refused every route outside its grant; joining refuses any
   path that is not private. Verification: route registration, permission
   negatives, a two-host smoke on loopback. **Yes.**
4. **Guests and client views.** The phone app or a browser joins by QR or
   code as a guest, receives the roster, and reaches each spoke that accepted
   it (H15); the hub can fetch its Tailscale certificate for the web app
   (H14); desktop windows show every member. Acceptance: a spoke that has not accepted a
   guest refuses it; a forged roster refuses. Verification: client-runtime
   tests and a three-host smoke; a phone run is a maintainer gate.
5. **Owner devices and shared sign-ins.** Owner marking, the Owners hub grant
   item, unlock keys on the phone (Secure Enclave, Android Keystore), the Mac
   (Touch ID or password), and the browser (passkey), unlock verification on
   the host, the owner routes for administration, credentials, and postures,
   and sign-in copy. Acceptance: an owner request without a fresh unlock is
   refused every window power; an agent, routine, hub, or peer request never
   reaches them; a copied key is unreadable by agents on both hosts and never
   journaled; a headless hub is set up end to end from a browser owner.
   Verification: server permission negatives and a two-host smoke with a
   software authenticator; phone and Touch ID runs are maintainer gates.
6. **Delegation.** Remote child runs from A to B with the peer grant, `peer:A`
   principal, approvals on B, results as data, and cancel. Acceptance: B
   refuses a request outside the grant or above approval-gated Code; an
   approval on B cannot be answered from A or the hub; the result is recorded
   on A as external content. Verification: server tests and a three-host smoke
   with a fake provider; a real-provider run is a maintainer gate.
7. **Failover.** Standby order, roster and wake-time copies, stand-in and
   step-down. Acceptance: members switch after the set time and return when
   the hub is back; a standby's membership changes merge back with removal
   winning; a spoke not named as
   standby cannot stand in. Verification: a three-host smoke that stops the
   hub. **Yes.**
8. **Wake service.** Spokes report wake times; the hub sends Wake-on-LAN or a
   nudge; the spoke fires its own timer. Acceptance: the hub never learns a
   routine's prompt or Project; a nudge for an unknown routine does nothing.
   Verification: server tests; a real Wake-on-LAN wake of a sleeping Mac is a
   maintainer gate (hardware).
9. **Push through the hub.** Spokes hand sealed envelopes to the hub, which
   forwards per H7. Depends on the push gateway slices in Mobile maturity.
   Verification: transport tests against a local gateway; a device delivery
   is a maintainer gate.
10. **Provisioning.** Update-feed mirror, catalog offers, profiles, and routine
    offers as proposals, with per-kind auto-apply per H5. Acceptance: nothing
    offered installs trusted, enables, or carries a secret. **Yes.**

Any slice that would deploy an Octant-operated service, create an account, or
spend money stops for a separate maintainer action.

## Verification

This change is design only; the format, path, and decision-archive checks cover
it. The invariants every slice must keep testable: the spoke is the only
authority over its threads; the hub principal is refused outside its grant;
no approval, credential, or sandbox change can come from the hub, a standby,
or a peer; owner powers need a fresh unlock and never reach an agent or
routine; results from another spoke are data; joining happens only over a
private network; the hub runs and serves the web app with no desktop window; and every hub service is off until the person turns it on.
