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

**Status: approved design 2026-10-28; the hub role, joining, phone guests, and
owner devices are built.** A host can act as hub, make a join code, approve and
remove members, and keep the roster; another computer can join, change its hub
grant, and leave. This works from Settings in a desktop window and from
`octant hub`, and the hub can run as a boot service. A phone can join as a
guest and reach each spoke that accepted it, and Settings and
`octant hub certificate` turn on the Tailscale certificate request, which the
listener serves to browsers beside the pinned one. Each host keeps its own owner
list; an owner device acts on a host after a fresh unlock; Confirm new members
and new-member alerts work; a window lists, confirms, and removes owners (the
roster carries each owner's unlock key, so nothing is pasted) and settles
alerts; a phone that joined with an owner code makes an unlock key and removes,
confirms, or dismisses alerts, and a passkey owner can confirm too. A remote
browser can join the hub that serves its page as a guest, with a plain or owner
code (Settings → Remote access → Hub); with an owner code it makes a passkey for
that origin first and keeps its identity, and it fails closed to a plain guest
when it cannot make one. A browser cannot check a pin, so it reaches only the
origin that served its page and the web app origins the hub's signed roster
names for spokes (a member's Tailscale name and port), each under its own
certificate check. The hub's page lists the members, links each spoke's own web
app, and can ask a spoke directly to admit the browser as a guest, as slice 4
records; the owner panel reads each spoke's alerts from that spoke's origin, and
acting on one still happens on that spoke's own page, where its passkey is. The
browser flow is tested with a faked authenticator and has not been run against a
real hub or a real Tailscale certificate. Nothing here has been run on a real phone, a real
passkey, or Android. An owner device's one unlock covers five minutes of
administration (the host keeps the session in memory), copies an API-key
sign-in between two spokes, reads a Code posture, and applies or dismisses a
provisioning proposal, read narrowly as slice 5 and slice 10 record; an owner can change an active Code thread or Code Project posture through the existing owner route, with host-local current-state checks and owner-device journal attribution. A Mac's Touch ID unlock key is built
(a Secure Enclave key made through the desktop's native helper and registered
when the Mac joins a hub, read narrowly as slice 5 records); the real Touch ID
prompt has not been run. The wake service is built (the hub's own
switch, spokes reporting opaque routine times, the Wake-on-LAN packet and signed
nudge, standbys holding the times), read narrowly as the last item of slice 8
records; it has run only between hosts on loopback with a fake socket, and a real
Wake-on-LAN wake of a sleeping Mac has not been tried. Delegation is
built for Work Projects, including an agent's own helper request that names a
member, read narrowly as the last item of the delivery plan's slice 6 records. Failover is built (a named standby, member switching, stand-in,
step-down with merge-back, and promotion, which spokes that ticked Standby
follow without a person), read narrowly as the last item of
slice 7 records; it has run only between hosts on loopback, with the hub
stopped by blocking its address, never on a real network or after a real
reboot. Push through the hub is built (the hub's own switch, a spoke handing it
sealed, spoke-signed delivery requests, the hub forwarding them unchanged to the
push gateway, and a standing-in standby doing the same), read narrowly as the
last item of slice 9 records; it has run only between hosts on loopback against a
local stand-in for the gateway, never against the real gateway or to a real
phone. Direct sending is built too (the hub serves the gateway's two routes for a
phone app its person built, and sends to Apple and Google itself with the
person's own credentials), and has run only against local stand-ins for Apple and
Google, never to a real phone. Provisioning is built (the
hub's own switch, offers as data, proposals the spoke's person applies or
dismisses, and applying on arrival for three kinds), read narrowly as the last
item of slice 10 records; it has run only between hosts on loopback with fake
services behind each kind, though a real host now builds a routine offer and
checks a mirrored feed against the shared release keys. Hub-started sign-in is
built (the Sign-in grant item, a request the hub relays and a spoke's person
accepts, and one outcome word back), read narrowly as the delivery plan's
closing note records; it has run only between hosts on loopback with a fake
view of the provider's own app, never against a real provider sign-in. After this slice every delivery-plan slice up to 10 is built. Slice 11,
[messaging between members](#messaging-between-members), was added on
2026-11-07 and is designed, not built. Slice 12,
[moving a thread to another member](#moving-a-thread-to-another-member), was
added the same day and is designed, not built. What remains of slices 1 to 10 is
the maintainer's: the live checks the slices name (a real Wake-on-LAN wake, a
delivery to a real phone, a phone, passkey, and Touch ID run, a failover on a
real network, a browser against a real hub, a real Claude or Codex sign-in on a
second computer started from the hub) and Windows.
The hub uses only the Roster and Status grant items, the Owners item for
owner devices, the Standby item for naming a standby, the Wake item for the
wake service, the Push item for push, the Provision item for offers, and the Sign-in item for sign-in requests. The maintainer
asked for this design and authorized it as design-first work on
2026-10-28 (in scope for the first preview since 2026-11-06), and set its shape the same day: a running instance enabled as hub,
members paired by QR or manual code over a private network such as Tailscale,
a standby hub for failover, personal devices only, phones as guests that run
no agents, and a hub that runs as a server without the desktop app and serves
the web app to a phone or laptop over Tailscale. The maintainer settled the [decisions](#decisions) below
the same day. A rule below is in force once its
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
6. phone notifications from every spoke go out through the hub;
7. a device the person marks as their own (an owner device) can set up and run
   any member as if sitting at it, after Face ID, Touch ID, a device passcode,
   or a passkey, so a headless hub never needs a screen or a shell after the
   first owner exists; and
8. before shutting down or restarting a computer, the person can move its
   threads to another member and carry on there, and a Code thread that cannot
   move hands over through its branch.

**Not in scope:** members that are not the person's own devices (teams, shared
machines, other people's computers), cloud machines Octant provisions, and
any path over the public internet. A person who needs to reach the hub away
from home turns on the mesh (such as Tailscale) on that device.

## Terms

| Term         | Meaning                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub          | A running Octant host (desktop or headless) with the hub role turned on. It is also a host in its own right with its own threads                                                                        |
| Standby hub  | A spoke the person names to take over the hub's role while the hub is unreachable. It holds a copy of the roster and wake times                                                                         |
| Spoke        | A computer running Octant, joined to one hub. It runs agents and keeps its own journal, files, credentials, sandbox, and approval policy                                                                |
| Guest        | A phone app or a browser joined to the hub. It runs no agents, has no files or Projects of its own, and acts on spokes as a paired device. It is a member of the roster like a spoke                    |
| Member       | The hub, the standby hub, a spoke, or a guest                                                                                                                                                           |
| Roster       | The hub's signed list of members; its fields are listed once, under [Discovery](#spoke-to-spoke-discovery-and-delegation)                                                                               |
| Hub grant    | The closed set of things a spoke lets its hub do (and a standby, when the spoke ticked Standby), chosen on the spoke when it joins and changeable only there                                            |
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

- **Runs without the desktop app.** A hub is normally a headless host running
  `octant server run`. A Mac that also runs the desktop app uses the same
  server; quitting the desktop app does not stop a hub
  ([decision H13](#decisions)).
- **Starts and runs unattended, on every platform.** A hub must come back by
  itself after a restart, a power cut, or an update, with no one logged in and
  no window open, on macOS, Linux, and Windows alike. Turning the hub role on
  therefore installs the server as a boot service, not the login service an
  ordinary host uses, always running as the person's own account:
  - macOS: a system launch daemon;
  - Linux: a systemd user service with lingering turned on;
  - Windows: a Windows service set to start automatically.

  Installing it needs administrator approval once. The service restarts the
  server if it exits, and an update restarts it the same way. The CLI never
  runs an administrator command on its own: it runs the step only when the
  person passes `--install-service` (or `--remove-service` to undo it), and
  otherwise prints the one command. Rationale: an administrator step that
  runs because a command was typed for something else is the surprise the
  person did not approve.
  - **Secrets at boot.** A platform's login-bound secret store (the macOS
    login keychain, a Linux desktop keyring, Windows Credential Manager) is
    not reliably open before someone logs in. So on every platform the hub
    keeps what it needs to serve in one store of its own: its identity key,
    roster signing key, listener and web certificates, and owner and member
    keys. That store is a file in the Octant data folder that only the
    person's account can read (file mode on macOS and Linux, an access list on
    Windows), on an encrypted disk ([decision H18](#decisions)). The hub's
    setup checks that the disk is encrypted and warns when it is not.
    Credentials held only in a login-bound store, such as a provider app's own
    sign-in, are unavailable until someone logs in, and the hub says which
    ones.
  - **The machine itself.** The hub's setup turns on starting up after a
    power failure where the platform allows it, and explains what full-disk
    encryption asks at boot. FileVault, and LUKS with a passphrase, ask for a
    password before the system starts, so a planned restart or update uses
    the platform's unattended restart where one exists (an authenticated
    restart on macOS), and after a power cut someone unlocks the machine once.
    BitLocker with a TPM, and LUKS unlocked by a TPM, boot unattended. A
    standby keeps the members working meanwhile.
  - **Windows.** Windows has no Octant design yet. The Windows parts of
    this design (the Windows service and the access-list key file) are built
    only when the Windows track starts, after the macOS preview and Linux
    self-update evidence, as the
    [release boundary](../architecture.md#current-release-boundary) orders.
    Even then, a Windows hub runs the hub role, the web app, and the hub's
    services; running agents on Windows waits for an approved Windows
    confinement design.

- **Serves the web app.** The hub's private listener, on its Tailscale or LAN
  address, serves the same web app the desktop window shows. A phone or
  laptop with no Octant installed opens `https://<hub>.<tailnet>.ts.net` in a
  browser, joins as a guest with the hub's code, and from then on uses Octant
  in that browser.
- **A certificate the browser trusts.** A browser cannot check a pin, so the
  web app needs a certificate the browser already trusts. On a tailnet with
  HTTPS turned on, the hub (and each spoke a browser guest reaches directly) can ask the local
  Tailscale daemon for its `*.ts.net` certificate and renew it before it expires, instead of the person
  pasting one ([decision H14](#decisions)). Tailscale obtains that
  certificate from a public certificate authority, so the machine's tailnet
  name appears in public certificate-transparency logs; the hub says so
  before it asks. The phone and desktop apps keep using the pinned self-made
  certificate and need none of this. The listener serves the self-made
  certificate by default, to every client that sends no server name, an
  address, or any other name, and serves the Tailscale certificate only to a
  client whose TLS server name (SNI) is exactly this machine's `*.ts.net` name,
  which it also accepts as the Host. The second certificate is checked as the
  first is (it parses, its key matches, it is current, and it covers that
  name) and is refused otherwise, leaving the listener on its own certificate.
  Turning it on or off, and each renewal, restarts the listener the way its
  administration does, because neither server swaps TLS in place; the
  self-made key, certificate, and pin do not change, and the roster's pin
  never does. One port and one listener, so pinned clients are unaffected and
  nothing new is exposed.
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
  - A guest knocks on each spoke itself, with the device key it paired with at
    the hub. The spoke checks the signature against the roster entry's
    fingerprint and against its own Introduce item before it makes an
    ordinary paired device. The hub never carries a guest's request to a spoke,
    so a hub cannot admit a guest to a spoke that has not accepted it.
  - A guest's roster entry has no listener: the all-zero pin and no addresses.
    A guest is never dialled, so nothing in the roster could be pinned to it.
  - A roster entry may carry the port its listener serves on. A listener is
    not always on the default port, and a member without it cannot be reached.

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
4. A spoke then shows the **hub grant** screen (below) with the roster entry,
   Introduce, and Owners ticked and everything else off, and the person
   chooses what the hub may do. If Owners stays ticked, the same screen lists
   the current owner devices and the person confirms them there
   ([Owner devices](#owner-devices)). A
   guest has no hub grant to choose, because there is nothing on a phone the
   hub can act on.
5. The member records the hub's identity key and listener pin, and receives
   the roster. For a spoke, the hub becomes a paired principal of a new kind
   `hub`, whose authority is exactly the hub grant; the spoke is a paired
   device of the hub.

A joining spoke needs its own private listener running with a certificate the
host made itself, as the hub does, so the hub can pin it. The hub and the spoke
each refuse to join or act while their listener is off, not on a private
address, or without a pin. Rationale: the join code carries the hub's pin, and
the hub reaches the spoke back only over a connection held to the spoke's pin.

After joining, members talk to each other on four signed routes on the private
listener: `/api/hub/join`, `/api/hub/leave`, `/api/hub/roster`, and
`/api/hub/status`. Each request is signed with the sender's host identity key
over its method, path, body hash, time, a nonce, and the recipient's member
id. The receiver accepts only the key the sender joined with, refuses a time
more than two minutes from its own clock, and refuses a nonce it has seen.
A request signed this way makes the hub a principal of kind `hub` on that
route and nowhere else; it never becomes an ordinary device principal and
carries no window capability. Rationale: a signature over the whole request
stops a change, a replay, or a forward to another host.

Leaving and removal:

Peer grants run in two directions, and the rules below name them. Grants
**held for** a member are the ones other spokes gave it. Grants **given by** a
member are the ones it gave other members on itself.

- **Leave** (on the member) revokes the hub principal, drops every grant given
  by the member, and forgets the roster. It also tells the hub, when the hub is
  reachable, so the hub drops the member from the next roster. A spoke's
  threads, Projects, and credentials are untouched. From the moment Leave
  starts, the spoke admits no more guests, and it revokes every guest device it
  holds when Leave ends. A device it cannot revoke yet, because the private
  listener has not started, is kept on a pending list on disk and revoked as
  soon as the listener's device pairing exists.
- **Remove** (on the hub) revokes the member's device on the hub and drops it
  from the roster.
- **Every spoke drops the grants held for a member** when it sees a newer
  roster without that member, whether it left or was removed. It keeps them
  while the hub is merely unreachable ([decision H3](#decisions)).
- **A removed spoke keeps the grants given by it** until it revokes them or
  sees itself missing from a newer roster; the hub cannot reach into the spoke
  to revoke them.
- Every join, grant change, leave, and removal is journaled on the host where
  it happened, with its principal.

### What the hub may do on a spoke

The hub grant is a closed list. Each item is off unless the table says it is
ticked by default, the person on the spoke can change every item, and the
spoke checks it on every hub request. A standby hub acting as hub uses the
same grant only on spokes that ticked Standby:

| Hub grant item | Lets the hub                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roster         | The hub's signed list of members; its fields are listed once, under [Discovery](#spoke-to-spoke-discovery-and-delegation)                                                                             |
| Status         | Read host resources, running threads' titles and states, waiting approvals (count and kind), and update status, the same read a paired device has                                                     |
| Introduce      | Introduce other members to this spoke; each becomes a full member here (decision H2). Ticked by default                                                                                               |
| Wake           | Hold this spoke's routine wake times and wake it (see [Wake service](#wake-service))                                                                                                                  |
| Owners         | Let the person's owner devices act on this spoke with a window's powers after a fresh unlock (see [Owner devices](#owner-devices)). Ticked by default                                                 |
| Standby        | Let a standby hub the person named use this same grant while it stands in for the hub (see [Failover](#failover))                                                                                     |
| Push           | Receive this spoke's sealed phone notifications and send them through the hub's push sender                                                                                                           |
| Provision      | Offer configuration (below). Every offer lands on the spoke as a proposal the person on the spoke applies, unless the person turned on auto-apply for that kind of offer ([decision H5](#decisions))  |
| Sign-in        | Ask this spoke's person to sign in to a provider account on this spoke. Nothing starts until a person on the spoke accepts; the hub learns one outcome word (see [Shared sign-ins](#shared-sign-ins)) |
| Act            | Act on the spoke as a paired device would, within the Projects the person names: create threads, send turns, answer questions. Approvals stay on the spoke (below)                                    |

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

- **Each host keeps its own owner list.** A host honors only the owner
  devices on its own list, each recorded with its identity key and unlock
  key. The hub's roster may show who the owners are, but an owner mark in the
  roster never adds anyone to a host's list, so a compromised hub cannot
  create an owner.
- **The first owner.** On the hub: in a desktop window, or by making the join
  code with `octant hub join-code --owner` in a shell on it; the member that
  joins with that code is the hub's first owner. On a spoke: when the spoke
  joins with Owners ticked, the person confirms the listed owner devices in
  the spoke's own window or `octant hub join` prompt, by name, identity-key
  fingerprint, and unlock-key fingerprint.
- **Adding later owners.** A host adds an owner to its list only when a
  window on that host confirms it, or when a device already on that host's
  list approves it with a fresh unlock that names the new device's
  identity-key and unlock-key fingerprints. Removing an owner works the same
  way. Each change is journaled on the host.
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
  private key never leaves that hardware. The public key reaches the hub when
  the device joins with an owner code, and the hub's signed roster carries it
  on that member's entry. A host copies it into its own list only after its
  person, or an owner already on that list with a fresh unlock, confirms the
  device by name and both fingerprints (the two ways above that add an
  owner); a device cannot register its own unlock key on a spoke.
- **Using it.** An owner request that needs window authority carries the
  unlock key's signature over a fresh host challenge and the request's command
  id. The host accepts it for that one request, or, for administration screens
  only, for a short window ([decision H17](#decisions)). Without a fresh
  unlock, an owner device is an ordinary member.
- **One unlock, one action, 60 seconds.** The host's challenge names the
  owner, the method, the path, and the hash of the request body, ends 60
  seconds after the host issued it, and is forgotten once any request answers
  it, whether or not that request succeeds. Rationale: a signature that names
  its action cannot be replayed for another, and a client that never keeps an
  unlock open has nothing to leak.
- **An administration session, five minutes.** An owner device may spend one
  such unlock on a session for the administration scope
  ([decision H17](#decisions)). The host answers with a secret id, keeps it in
  memory only (a restart ends it), and binds it to that owner device and to the
  owner list as it stood; the device presents it beside its signed requests for
  actions of the administration class. It ends five minutes after it opened,
  when anything is added to or removed from the host's owner list, and when the
  device is revoked or no longer listed. Full access, merge, a sign-in copy, an
  owner change, leaving the hub, and opening a session each need their own
  challenge and are refused with `own-unlock-required` when a session is all
  that is presented.
- **Alerts live on spokes.** Each spoke compares a newer roster with the one it
  held and keeps an alert for every member added, whatever Confirm new members
  says. An owner device reads them from the spoke it concerns; the hub holds no
  alert and cannot clear or write one. Rationale: the party that might be
  compromised cannot be the one that reports.
- **Browser control is its own finite action.** Selecting an already-open Code
  Private page is an owner administration read. Taking control requires a fresh
  own-class unlock even when an administration session is open. The resulting
  target-bound controller lasts at most 60 seconds and authorizes only signed,
  sequenced person frames and fixed inputs for that exact native resource.
  It cannot administer the host, select a profile, create a page or lend a local
  window capability. Stop/reclaim/expiry leave the agent's person hold in place;
  only explicit Hand back releases it. See [Owner control of an open Code
  page](browser-agent-tool.md#owner-control-of-an-open-code-page) for the supported
  resource, volatile credential-bearing frames, cancellation and audit rules.
- **Confirming a new member is signed by the unlock key.** The owner's unlock
  key signs a note naming the spoke, the member, its identity-key fingerprint,
  the owner, and the unlock key's fingerprint, and the spoke checks it against
  the key on its own owner list. A raw key signs the note itself. A passkey
  answers the note as a WebAuthn assertion whose challenge is the SHA-256 of
  the note, under the same rule as an unlock (the person present and
  verified), so a passkey owner can confirm too. A passkey signs one challenge
  per prompt, so a passkey owner is asked twice: once for the note, once for
  the action that carries it. A phone's raw key opens once for the whole
  action, so the person authenticates once and the key is dropped from memory
  afterwards.
- **Held members are readable.** A window, and an owner device (a read that
  asks for no unlock), can list the members a host holds status-only under
  Confirm new members. Confirm shows only for those.
- **The roster carries unlock keys but adds no owner.** When a member joins
  with an owner code, the hub records its unlock public key and the signed
  roster carries it as an optional field on that member's entry. A spoke never
  adds an owner because the roster says so: its window, or an owner already on
  its list with a fresh unlock, confirms each listed owner by name,
  identity-key fingerprint, and unlock-key fingerprint, and only then does the
  spoke copy that entry into its own owner list. Nothing is pasted by hand.
  If a later roster lists a different unlock key for an owner already on the
  list, the spoke keeps the key it confirmed and shows the mismatch. Rationale:
  a key that arrived through the hub could be one the hub chose, so the
  person's confirmation is what makes it an owner's.
- **The phone's unlock key is a biometric-gated secure-store key.** The phone
  makes a P-256 key, keeps its private half only in the platform's secure
  storage with user authentication required on every read, and asks for the
  system prompt before reading it. It is not a Secure Enclave or Keystore key:
  it is not bound to hardware, and it is in memory while it signs. Rationale:
  the app has no native module for a hardware key yet; the narrower key still
  keeps a thief without the person's face, finger, or passcode out of the owner
  powers.
- **What it allows,** on a host that honors owners: listener, pairing, and
  device administration (approving joins, revoking devices); setting provider
  keys and adding MCP servers with secrets; remembering Full access or an
  "always allow"; a Terminal Browser grant; the confirmed pull-request merge;
  changing that host's hub and peer grants; and copying sign-ins
  ([Shared sign-ins](#shared-sign-ins)). Each use is journaled on the host
  with the device and `owner-unlock`.
- **Before a paired client's merge.** A host may also ask a paired phone or
  web client's merge for an owner unlock, under a switch its window sets, off
  by default. The owner device answers a challenge this host's owner route
  issued for the merge route's own path and body, and the merge carries the
  proof. The rule and its rationale are in
  [Architecture: pull-request merge](../architecture.md#modes-chat-work-and-code).
- **What it never allows.** An unlock answers one person's direct action in a
  client. An agent, a routine, the hub principal, a standby, and a peer
  never carry one, and no tool can ask a device for it. An agent still cannot
  approve its own steps or mark a thread Done. Joining a spoke to a hub still
  happens on that spoke.
- **Browsers.** A passkey belongs to one web origin, so a browser owner
  registers one passkey per host origin it uses (with decision H15's direct
  option, one per spoke). A browser without a platform authenticator cannot
  be an owner. A browser cannot check a certificate pin, so it reaches a host
  only at the origin that served its page, under the browser's own certificate
  check ([decision H14](#decisions)); it joins with only the ticket of a join
  code, never the code's address or pin.
- **Losing a device.** Remove on the hub, an unmark from another owner device,
  or a revoke on any host ends its owner powers there; Remove ends them
  everywhere at the next roster. A thief holding the device without the
  person's face, finger, passcode, or passkey has only ordinary member powers
  until then.

#### Recovery inventory

Code posture recovery is the bounded owner-device path. It does not grant an
owner device every action that can unblock a task. The inventory below keeps
those decisions separate. A refused request has no effect; retry requires a
new authoritative reading and the proof required for that action.

| Request                                  | Eligible responder and current boundary                                                                                                                                                                     | Queue and resume                                                                                     | Additional authority needed                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Code thread or Code Project posture      | An owner on this host's current owner list; Full access needs its own fresh unlock. The existing owner route applies the change through the Code or Project service after checking its current-state token. | Changing a level affects subsequent launches; it does not answer a waiting prompt or restart a turn. | Built through the existing posture routes and Settings/phone controls; no other grant follows.               |
| Work level                               | The existing host-local controls; the Code posture routes do not accept Work subjects.                                                                                                                      | No owner recovery queue or automatic resume is added.                                                | A separate Work posture decision and route.                                                                  |
| Approval answer                          | A paired device may approve once or deny prompts its own turns raised. A prompt raised by a local window stays local. The existing approval service checks the recorded turn and Project.                   | Existing prompt expiry and settlement apply; an owner unlock does not transfer a prompt.             | A separate decision for any additional eligible responder; no general owner approval route is granted.       |
| File restore                             | The existing restore command and its approval, checkout freshness and live-writer checks.                                                                                                                   | An owner posture change neither approves nor retries a restore.                                      | Any owner recovery path must reuse those checks and define its own proof.                                    |
| Saved-action launch                      | Existing action-launch authority on the selected host and checkout.                                                                                                                                         | No automatic relaunch after a lost reply or posture change.                                          | Server action delivery remains a separate slice; posture recovery adds no launch grant.                      |
| Browser interaction, profile or transfer | Existing host-local take-over, profile and transfer rules. Owner posture recovery adds no remote controller or profile access.                                                                              | Preserve the existing pause, hand-back and disconnect rules.                                         | A separate owner browser decision must name permitted operations, controller arbitration and local recovery. |

Rationale: the earlier rule, that only a window on the host may administer it
or hold its most sensitive powers, assumed every other device might belong to
someone else. Inside one person's own devices that rule makes a headless hub
impossible to run without a shell, while adding little safety, because the
person is the same. The unlock key keeps what the rule protected: possession
of a member key alone, or a compromised hub, still cannot reach those powers
without the person's presence on the device.

### Recovery and approval scenarios

Every power above comes back from a machine the person can sit at, because a
window on a host always has that host's authority and needs no other device.
Losing one device never locks the person out, and a lost device is removed
from any device they still have.

| Situation                                                   | What the person does                                                                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a new phone or laptop                                   | Scan the hub's QR code or type its code over the private network. With Confirm new members on, compare the short code and confirm in a spoke's window or on an owner device                           |
| Approve an agent's risky step                               | Answer it in the spoke's own window, or on a member that spoke lets answer approvals (a guest phone, by default)                                                                                      |
| Turn on Full access, merge, copy a sign-in, or add an owner | In the host's own window, or on an owner device with its own fresh unlock for that action                                                                                                             |
| Lose the phone                                              | On a laptop's window, or another owner device: Remove the phone. Confirm and administer from the laptop's window until a new phone joins; mark the new phone as owner there                           |
| Lose a laptop                                               | Remove it from the hub (from a window on the hub, an owner device, or the hub's shell). Every spoke drops what it held for that laptop at the next roster; revoke anything left from each spoke       |
| Lose every owner device                                     | Sit at any spoke and use its window. For a headless hub, reach it over SSH on the private network and run `octant hub join-code --owner`; the device that joins with that code is the hub's new owner |
| The hub is down                                             | Members switch to the standby. Approvals and window powers on each spoke keep working, because they never went through the hub                                                                        |
| The hub is lost for good                                    | Promote the standby on its own window; spokes follow it as decision H11 says. With no standby, set up a new hub and join each spoke to it from that spoke's window                                    |
| An alert shows a member the person did not add              | Tap Remove in the alert on any spoke or owner device, then check the hub; a member nobody added means the hub may be compromised                                                                      |

Owner powers on a stolen device still need the person's face, finger,
passcode, or passkey, so a thief has only ordinary member powers until the
device is removed.

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
- **Never copied.** Subscription sign-ins held by a provider's own app (for
  example a Claude or Codex account login) are never copied
  ([decision H6](#decisions)). These tokens refresh, so a copy and its source
  would log each other out, and the provider's terms are unchecked. Delegated
  work never carries a sign-in; it uses what the receiving host holds.
- **Hub-started sign-in.** Instead, an owner can ask a spoke to sign in
  itself. A window on the hub, or an owner device with a fresh administration
  unlock on the hub, asks one spoke to sign in to one kind of provider account
  (a Claude or Codex account). The hub relays only the kind and a request id
  over the signed member link; it never signs in for a spoke, and a peer, a
  guest, an agent, and a routine cannot send the request. A spoke holds the
  request only if its person ticked the Sign-in grant item (off by default), and
  then shows it as a question. Nothing starts until a person in that spoke's own
  window, or that spoke's own owner device after an unlock, accepts. Accepting
  shows the provider's own sign-in command on the spoke, which the person runs
  in a terminal there; any code or address the provider prints appears only in
  that terminal. No token, code, address, or account name reaches the hub, the
  journal, or an answer. When the request ends, the spoke tells the hub one word:
  `signed-in`, `declined`, `expired`, or `failed`, which the hub shows beside the
  member. A spoke refuses a request when the grant is off, the kind is unknown
  or has no provider there, the account is already signed in, a request for that
  account is already open, or the requester has sent three in an hour; a request
  lapses ten minutes after it arrives.

### Spoke-to-spoke discovery and delegation

**Discovery.** Every member holds the latest roster the hub signed. The
roster holds, for each member, its name, role, identity key fingerprint,
listener pin, private-network host names (for example a Tailscale name) and
addresses, and owner mark (with the unlock public key of a member that joined
with an owner code; it adds no owner), plus the standby order and a sequence
number. A
member checks the hub's signature and keeps the roster with the highest
sequence number it has seen. Live data travels beside the roster, unsigned
and advisory: each member's online or asleep state from the hub, and what
delegation a spoke accepts, which only that spoke can say and serves itself.

**Introduction and the peer grant.** Before member A can do anything on spoke
B, A must appear in B's roster and B must accept it. A spoke that ticked Introduce
accepts every new member automatically as a **full member** and lets its
person narrow or revoke that member's **peer grant** at any time
([decision H2](#decisions)). Pairing by QR or code over the private network is
the check that the new member is the person's own.

- **Alerts.** Every spoke, and every owner device, shows an alert when a new
  member is accepted: its name, role, and key fingerprint, with **Remove** one
  tap away. The alert comes from each spoke itself, not from the hub, so a
  hub that adds a member cannot hide it.
- **Confirm new members (optional).** A spoke can turn on a setting that
  holds each new member at status-only until the person confirms it, after
  comparing a short code shown on the new device. They confirm either in that
  spoke's own window (a window on a host always has its authority) or from an
  owner device with a fresh unlock, which signs the confirmation with its
  unlock key; the spoke checks the signature against its own owner list. The
  hub cannot confirm for the person. It is off by default. Losing a device
  never locks the person out; see
  [Recovery and approval scenarios](#recovery-and-approval-scenarios).

A peer grant names:

- whether A may delegate work to B, and into which of B's Projects;
- the mode and the highest posture B will run that work at (Work ask-first,
  Code approval-gated, or Plan read-only; Full access only when an owner chose
  it for that peer and Project with a fresh unlock, and only where B's own
  Project allows Full access);
- which provider profiles on B that work may use;
- whether A may read B's status; and
- whether A may list and message B's tagged threads (the Message item, see
  [Messaging between members](#messaging-between-members)).

The full-member grant lets A read B's status, message B's tagged threads, and
delegate into every Project on B, at Work ask-first or Code approval-gated
(never Full access), with B's default provider profile. For a guest it is the ordinary paired-device
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
child. B answers for the turn the request started: a follow-up a person runs on
that thread is neither the result A receives nor something A can interrupt. A
guest never receives delegated work.

A keeps the request on file before it sends it. If B's answer is lost (a
timeout, a reset connection, a reply that cannot be read), B may already run the
child, so the request stays pending under its id: A reports it as pending, a
later read finds B's child by that id, and cancel reaches B the same way. A
refusal B itself wrote removes the request. A pending request B has no record of
is dropped once its signature could no longer be accepted; a request B has
accepted and is still starting reads as starting, never as unknown, so A keeps
it. Erasing the parent thread stops its remote children and erases what A kept
of them, a result included; a read for them then answers as unknown. If B could
not be reached for that stop, A keeps only the request id and target, no task,
result or thread, and asks again until B answers or a day has passed.

**Credentials.** No credential crosses with a delegation. The work on B uses
B's own provider sign-ins and B's own Git and SSH identities, including any an
owner copied there ([Shared sign-ins](#shared-sign-ins)).

Rationale: delegation as a remote child run reuses the existing subagent rule
(equal or narrower, clamped server-side) and the existing paired-principal
path, so B never needs a new authority model. The result coming back as data
keeps a compromised spoke from steering another spoke's agent.

### Messaging between members

An agent's thread on one member can message a running thread on another
member, so agents on the person's computers can coordinate, whichever provider
each runs. It extends the one-host channel in
[Architecture: agent-to-agent messaging](../architecture.md#modes-chat-work-and-code):
everything that rule says holds on each host, and this section states only what
changes when the two threads live on different members. Delegation hands work
to another spoke; a message hands text to a thread that already runs there.

**The tag.** A Code thread takes part only when a person turned on **Reachable
from my other computers** for it, in the thread's header menu and its row's
context menu, on the host that owns the thread (a window there, or an owner
device after a fresh unlock). It is off for every thread by default; an agent,
the hub, and a peer cannot turn it on; and turning it on or off is journaled on
that host as `thread.member-reachable-set@1` with its principal. A thread that
is completed, archived, deleted, or in Plan keeps its tag but takes part in
nothing until it is active Code outside Plan again. Both ends need the tag: a
thread may send to another member only while it is tagged itself, so the
person opted in on both sides and the recipient can always answer. Turning the
tag on also turns on the thread's **Wake when a message arrives** switch,
which can then be turned off on its own (see
[Waking an idle thread](#waking-an-idle-thread)).

**Who.** Spokes, the hub's own threads (the hub is also its own spoke), and a
standby's own threads may send and receive; a guest runs no agents and does
neither. Only Code to Code, as on one host: Chat, Work, and child runs neither
send nor receive across members, and a delegated thread on B takes part only if
a person tags it.

**The Message item.** A peer grant gains one item, **Message**: member A may
list B's tagged threads and send them messages. It is in the full-member grant
(decision H2), because the tag, off by default, is the consent that matters,
and the item only says which members may use it. A spoke also holds a peer
grant for its hub whose only item is Message, ticked at join and changeable
there, so the hub's own threads can take part. Rationale: a compromised hub can
already introduce a fake member that gets the full-member grant, so this adds
no power a compromised hub lacked; a spoke that wants none unticks it.

**Finding a thread.** `octant_threads list` takes an optional `member`, a roster
member id. A's host then asks B with a signed member request
(`POST /api/hub/peer/threads`), and B answers with its active tagged Code
threads, at most 32, in the row shape of a local `list` (reference, title,
state, when the state changed). A remote reference is
`<thread id>@<project id>@<member id>`; the local form stays as it is. A `list`
with no `member` stays local, and `read` and `wait` stay local only. B answers
a member without the Message item, and one it does not hold, with an empty
list, the same answer as a member with no tagged threads, so the answer
reveals nothing.

**Sending.** A's host admits the send under the local rules (Code, not Plan,
the profile names `octant_threads.send`, at most four recipients, a 64 KiB
body, eight messages waiting per sender), journals `agent.message-sent@1` with
the remote recipient's reference, and keeps the body in its own store. It then
sends B a signed member request (`POST /api/hub/peer/messages`) over B's
pinned listener, signed with A's identity key the way delegation is. B checks
that A is in the roster it holds, that A's peer grant carries Message, and that
the recipient is an active tagged Code thread. If all hold, B journals
`agent.message-received@1` on its own `agent-message` aggregate with principal
`peer:A`, the sender's remote reference, and an opaque reference to the body in
B's store, and answers `accepted`; A journals `agent.message-forwarded@1` and
deletes its copy of the body. Any other answer is `unauthorized`, in the same
words for every reason, and A journals `agent.message-refused@1`. B holds at
most eight waiting messages per remote sender thread and 32 per member; past
either, it refuses until a turn carries some.

**A member that cannot be reached.** A message B has not answered stays
waiting on A. A sends it again with backoff while the member is unreachable,
until B answers or the 24-hour deadline passes, when A journals
`agent.message-expired@1`. Every try carries the same message id, and B keeps
one message per id, so a lost answer never doubles a message. Rationale:
Architecture says nothing queues offline work for another host. A message is
not work: it carries no authority, starts nothing, and B decides afresh when it
arrives. Waiting on the sender is what the one-host channel already does, so
this is the same rule with a network in between.

**Delivery on B.** Delivery follows the one-host rule on B. When the
recipient's next Code turn assembles its context, B rechecks that the recipient
is still active and tagged, that A is still in the roster, that A's grant
still carries Message, and that A has not withdrawn the message (below), and
refuses otherwise. A delivered message marks the
recipient with `thread.external-content-ingested@1` under the source label
`member-message` and joins the turn as one context block: a host sentence that
names the sending member and the sender's remote reference, then the body
inside the shared external-data frame. A message grants no authority on B and
never answers an approval there; the only turn it can start is the wake turn
below. The agent on B replies by sending to the reference in that sentence.

#### Waking an idle thread

Waking follows the one-host rule in
[Architecture: agent-to-agent messaging](../architecture.md#modes-chat-work-and-code):
a message to an idle thread whose **Wake when a message arrives** switch is on
starts one bounded, `agent`-initiated turn there. Across members, only these
parts differ:

- B starts the wake turn when it accepts the message, and the turn's host
  sentence and the thread's row name the member that woke it. The turn is
  journaled with the initiator kind `member-message`.
- The hop count travels in A's signed request, set by A from its own record.
  B cannot check it, so a member that sends a false count is still held by
  B's one-at-a-time and hourly bounds, which B counts itself and which cover
  local and member messages together.
- Turning the tag off stops new wake turns from members, as turning off the
  wake switch does.

Rationale: a compromised member could otherwise turn one message into
unbounded turns on B. B's own bounds cap what it can spend there without B
having to trust anything A counts.

**The sender's end after B accepts.** The one-host rule rechecks the sender at
delivery. Across members B cannot see the sender, so A tells it. When a
sending thread stops being eligible (it is completed, archived, deleted, or
purged, or a person turns its tag off), A sends B a signed member request
(`POST /api/hub/peer/messages/withdraw`) naming every message from that thread
that B accepted and has not yet delivered. B refuses each one at once, deletes
its body, and sends the `refused` receipt back. A withdraw that cannot reach B
is sent again with the same ids until B answers or the message's 24-hour
deadline passes. A thread that only dropped to Plan withdraws nothing, because
Plan stops a thread from sending, not from having sent. Rationale: if B asked A
before every delivery, delivery would depend on A being online, and waiting for
an unreachable member would no longer work. The cost is a window: while A
cannot reach B, B may still deliver a message whose sender A already closed.
That message is unchanged text the sender wrote while it was eligible, framed
and tainting, so the window exposes nothing the person had not allowed when it
was sent.

**Receipts.** B sends `delivered`, `acknowledged`, `refused`, and `expired`
back to A as signed member requests (`POST /api/hub/peer/messages/receipts`)
that name only the message id. A records them on its own message, so the
sender's `receipts` reads the same states as on one host, plus `forwarded`. A
receipt that cannot reach A is sent again with the same id until A answers or
a day has passed; a receipt A cannot match to a message it sent is dropped.

**Leaving and revoking.** When B's person unticks Message for A, removes A, or
B sees A's removal in a newer roster, B refuses every waiting message from A at
its next delivery check, and every new one. Turning off a thread's tag makes B
refuse messages to it the same way. On A, messages waiting for a member that
left the roster are refused at the sender's next send. The hub never carries a
message: members reach each other directly, as for delegation, and the hub only
introduces them.

Rationale: tagging threads rather than whole Projects lets a person open one
long-running coordinator on each computer without exposing every thread there.
Reusing delegation's signed member request gives each message a sender
identity checked against the roster and a receiver that keeps the final say,
so no host trusts another more than the hub-and-spoke rules already allow.

### Moving a thread to another member

A person about to shut down or restart the computer a thread runs on can move
that thread to another of their computers and carry on there. The move happens
before the source goes away: the source freezes the thread and sends it
directly to the chosen member, which opens it as a new thread with the whole
history and the work in progress, and the source erases its copy once the
destination has it. When a move cannot finish, a Code thread falls back to a
**handover**: its work is committed to its branch with a note, so the person
picks it up on any computer that can fetch that branch.

Only planned moves are in scope ([decision H19](#decisions)). A computer that
dies or loses power without warning hands nothing over; that would need a
continuously updated copy on another member, and threads are in no replica
log.

**Who starts it.** Only a person, and for one thread only from that thread's
Environment tool: its Computer card lists the member computers, and the move
sheet states what moves, what stays, and that the source is erased
([Design system: moving a thread](../../DESIGN.md#shell-and-layout) owns the
screens). No header menu, row menu, or command palette entry moves a thread.
[Prepare to shut down](#prepare-to-shut-down) is the one host-wide entry,
for many threads at once. An owner device acting on the source host uses the
same Environment view. An agent, a routine, the hub, a standby, and a peer
cannot start a move or a handover, and no tool offers either.

**Every move is an owner act on the destination** ([decision H20](#decisions)).
The destination accepts a move only when it carries a fresh unlock, of the
own-unlock class (an administration session never covers it), from an owner
device on the destination's own owner list, and only when the destination's
peer grant for the source has the **Move in** item. Move in is in the
full-member grant ([decision H2](#decisions)); a destination with Owners
unticked refuses every move. Usually the source is itself an owner device, so
the person touches Touch ID on the laptop they are leaving; a phone that is an
owner on both hosts can start the move instead. A source that is not an owner
on the destination is told so, with how to mark it.

A full member's grant stored before Move in existed has no such item. It
reads as on while the rest of it is still exactly the full-member grant, and
as off once the person narrowed it, so existing hubs take moves without
re-joining. Rationale: a member joining now gets Move in, and the owner
unlock, not the item, is what authorizes a move.

**The hub as a destination.** The hub keeps no peer grants, so its own
**Accept moved threads** setting stands where a spoke's Move in item does. It
is on by default, only a window on the hub turns it on or off (Settings ›
Hub › Moved threads), and each change is journaled. The hub checks a move's
sender against the identity key that member joined with, takes moves only
from a spoke or a standby (never a guest), and still requires the fresh
own-class unlock from an owner device on the hub's own owner list. Off, it
answers every move with the same `refused` as a spoke without Move in. A
host whose hub role is on judges a move only as the hub, as its owner routes
do: a spoke that turned its hub role on keeps its old link, and the peer grants
from that link never let a move past Accept moved threads. The hub moves no
thread away: no spoke grants it Move in.

On a Mac source, the window asks its own host for the destination's owner
challenge, which the source fetches signed with its member identity and which
names the ticket route and that exact request body; the desktop's unlock key
signs it after Touch ID, and only the signature passes back through the
source, which sends the ticket request with it. The ticket that answers lasts
fifteen minutes and opens one move from that source. Rationale: Move after
this turn waits for the turn to end without asking the person again, and a
turn that outlasts the ticket ends the move with `unlock-required`.

**The person is the same everywhere.** A host has one person, and every member
is that person's own device, so a moved thread arrives as the person's own
thread, as if they had made it in a window on the destination. It is journaled
with the owner device and `owner-unlock`, never as `peer:A`, and its history is
the person's own conversation, not outside content. Taint the history already
carried travels with it. Rationale: the owner unlock is what makes this safe. A
member key alone cannot plant a thread with an invented history, because a
move without the person's presence on an owner device is refused.

**Where it can go.** A thread moves only into a Project of its own mode, and
its kind never converts:

- a Chat thread into a Chat Project, or into no Project;
- a Work thread into a Work Project the person picks; the files in its source
  folder do not move, only the thread; and
- a Code thread only into a Code Project bound to a clone of the same
  repository: a remote the source checkout also has, and a base commit the
  destination holds or fetches with its own Git identity.

A move is refused for a thread delegated to this host by a peer (it belongs to
that delegation), a thread with a running turn, a thread waiting on the
person, and a thread with a running child run or a pending remote child run.
The move sheet offers **Move after this turn**, which waits for the turn to
end, and **Stop and move**, which stops it and cancels its pending approvals
and questions.

**What moves.**

- The thread's journal cut in the `octant.thread-bundle/1` form (transcript,
  evidence, provenance, and taint), plus each thread-owned part that export
  lists as an omission: attachment bytes, admitted original inputs, generated
  images, retained Browser captures, and the Canvases the thread owns with
  their versions. Each is its own manifest part with its size and digest, and
  the destination records it under the new thread with new ids:
  - An attachment arrives on the turn that sent it, and one added but not
    sent arrives unsent. An original input a turn admitted from another
    thread arrives as an attachment of the moved turn, because that thread
    stays on the source.
  - A generated image arrives as a completed image of the new thread. It
    records no usage on the destination: it ran, and was billed, on the
    source, whose accounting keeps it.
  - A Browser capture arrives without the name of the Browser profile its
    page lived in, because profiles never move.
  - The Canvases the thread owns are every Canvas whose provenance names it,
    the ones its erase would remove. Each arrives with every version, in
    order, in the Project the thread moves into (none for a Chat thread moved
    into none). Its content is unchanged, so a source reference in it still
    names the computer it was read on. A Canvas that recorded outside content
    on the source carries that mark from its first version, and marks every
    agent that reads it.
  - A part whose bytes cannot be read on the source, or no longer match the
    digest a turn admitted, stays behind. The move goes on, because the person
    is about to shut the computer down, and the "Moved to" record names each
    part that stayed, up to the first 1,000 (each name cut to 512
    characters), and counts them all. The source bounds the list when it
    packs, before anything is erased, so the record it writes after the erase
    always fits. The erase removes the part with the thread. A part the
    destination cannot record refuses the arrival with `transfer-failed`, so
    the source keeps the thread.
  - The Secret guard reads the checkout, not these parts. Rationale: they are
    content the thread already holds and handed its provider, sent to the
    person's own computer over the pinned member link, and a part the guard
    kept back would be destroyed by the erase rather than kept the way a
    refused worktree file is.
- For a Code thread, a Git bundle of its checkout: the commits on the thread's
  branch that the source's remote-tracking refs do not hold, and the
  uncommitted work as two snapshot commits that never join the branch: an
  index commit whose tree is the staged state, on the branch's head, and a
  working-tree commit on top of it whose tree is the working tree, including
  untracked files Git does not ignore. The destination restores the index from
  the first and the working tree from the second, so a file with both staged
  and unstaged edits arrives with both. Rationale: one commit holds one tree,
  and a file staged at one version and edited again holds two. The Secret
  guard checks every file that travels; a file it refuses stays behind and is
  listed. Ignored files (build output, installed dependencies, `.env` files)
  never travel.
- There is no size limit ([decision H22](#decisions)). A large thread or
  worktree takes longer; the move sheet shows the size and an estimate.
- Never: credentials and sign-ins, the provider's own session, remembered Full
  access, session grants and "always allow" answers, running terminals and
  processes, dev-server previews, Browser pages and profiles, device panes,
  routines, the Reachable tag, Project memory, and Project artifacts (which
  [artifact replica sync](artifact-replica-sync.md) carries when it is on).
  The receipt names each one that applied to the thread.

**Steps.**

Before the person picks a destination, the Computer card asks each member
which of its Projects would take the thread
(`POST /api/hub/peer/thread-moves/projects`, naming the mode and, for Code,
the source checkout's remotes). A member answers with Project names and ids
only when its peer grant for the source has Move in; every other sender gets
the refusal a move would, and a member that does not answer is listed as
unreachable.

1. **Freeze.** The source journals `thread.move-started@1`, and the thread
   becomes read-only, showing "Moving to" and the member's name. Nothing leaves
   the source before the freeze is recorded, so at most one copy can take a
   turn.
2. **Offer.** The source asks the destination for an owner challenge naming
   the offer route and the offer's hash, the person unlocks, and the source
   sends the signed offer (`POST /api/hub/peer/thread-moves`): the move id, the
   mode, the destination Project, and the manifest of parts with their sizes
   and digests. The destination checks the unlock, the Move in item, and the
   Project rule above, and answers `ready` with a one-use receiving ticket
   bound to that move id.
3. **Transfer.** The source sends the parts in chunks
   (`POST /api/hub/peer/thread-moves/chunk`, naming the move, part, and chunk) directly over the
   destination's pinned listener; the hub carries nothing. Each chunk is
   checked against its digest. A cut transfer resumes from the last chunk the
   destination acknowledged, after a reconnect or a source restart, and the
   destination keeps a partial transfer for seven days.
4. **Arrive.** `POST /api/hub/peer/thread-moves/finish`. The
   destination checks the whole manifest, creates the new thread with its own
   id, journals `thread.moved-in@1` with the origin member, the origin thread
   reference, and the move id, and holds the thread as **arriving**: listed,
   read-only, and unable to start a turn. For Code it makes a managed
   worktree, checks out the branch (keeping its name when that is free there,
   otherwise adding a suffix), and restores the index and the working tree
   from their two snapshots. It answers
   `arrived` with the new thread's reference.
5. **Commit.** The source sends
   `POST /api/hub/peer/thread-moves/commit`. The destination journals
   `thread.move-committed@1`, makes the thread active, and answers
   `committed`. The source then journals `thread.moved-out@1` and erases its
   copy.

Every request carries the move id and is idempotent, the way a delegation
request is: a lost answer is asked again, and a state the destination already
reached is answered again rather than repeated.

**Erase on the source** ([decision H21](#decisions)). Once the destination
answers `committed`, the source erases the thread through the ordinary thread
purge: its bulk content, projections, attachments, and child runs go, and its
token and cost aggregates stay for host accounting, as for any purge. The
journaled `thread.moved-out@1` keeps the move id and the destination reference,
so an old link, a notification, or a search on the source shows "Moved to" the
member with **Open there**; the purge tombstone itself stays as it is for
every purge. A managed worktree the thread owned is removed with its
local branch only when everything in it travelled. When it holds anything that
stayed behind (a file the Secret guard refused, or any ignored file such as a
`.env` or a local configuration, or an edit made in the folder after the
snapshot), the source moves the worktree out of the managed folder, beside it
as `<worktree>-moved-out-<move>`, so the purge leaves it in place; it is no
longer owned by any thread, and the tombstone lists those files with **Remove
worktree**, which only a person can choose. The source decides this at erase
time by comparing the folder with the snapshot it sent, because a Code
thread's freeze stops its turns and commands but not an editor or terminal the
person has open there. The move sheet names the same
files before the move starts. Rationale: those files have no other copy, so
removing the folder would destroy work the move never carried. Nothing is
pushed or deleted on a remote. A thread that worked
in the Project's current checkout leaves that folder as it is, because Octant
never resets the person's own checkout, and the receipt says the changes also
remain there. The purge also starts the existing withdrawals: messages the
thread sent that are not yet delivered are withdrawn, and messages waiting for
it are refused.

**Interruptions.**

- **The source goes away after `arrived` and before `commit`.** Once the
  source has been unreachable for five minutes, the destination offers
  **Activate anyway** on the arriving thread, a person's act there (a window,
  or an owner device with a fresh unlock). The source's freeze is already
  recorded, so the source cannot have continued. When the two next reach each
  other, the source learns `committed` and erases.
- **The source restarts during a move.** A frozen thread with a move in
  progress resumes by itself: a `committed` answer erases it, `arrived` sends
  the commit, a partial transfer resumes, and a refused, discarded, or unknown
  move unfreezes it with a receipt that says why.
- **Cancel.** The person can cancel until `committed`. The source asks the
  destination to discard what it holds and unfreezes when the destination
  answers. While the destination cannot be reached the thread stays frozen and
  offers **Take back here**, which unfreezes it at once and journals that the
  destination may still hold a copy. If that copy is later activated, both
  threads show "Also continues on" the other member, and neither is erased
  automatically.

**Continuing on the destination.** The thread keeps its guardrail level where
the destination Project allows it; Full access never carries and needs its
own unlock there. Its provider and model are re-resolved against the
destination's catalog, as for any handoff: a Code thread arrives on the
destination's own instance of the provider kind it ran on, with the same
model, and a destination with no provider of that kind refuses the move with
`no-matching-provider`, because another kind cannot be assumed to know the
model. A Code thread arrives as a managed thread started from the moved
commit and the two snapshots, and its earlier conversation arrives as a moved
transcript the first turn carries once; past operations are not recreated
one by one.
The next turn runs on the destination's own sign-in with the ordinary
disclosed text handoff and original-input checks
([Architecture: stop reasons](../architecture.md#stop-reasons)). The
provider's own session never moves.

#### Prepare to shut down

Prepare to shut down moves many threads at once, for the moment the person is
leaving. It asks before anything moves, and its defaults are chosen so that
the usual case is one press and one unlock.

- **Where it opens.** From **Prepare to Shut Down…** in the application menu
  and the menu bar, and from the existing quit confirmation: when Quit would
  ask about open sessions and this host is in a hub with a member that can take
  at least one of its threads, the confirmation gains **Move threads first…**,
  which opens Prepare to shut down instead of quitting. Cancel stays the
  default there and Quit and stop work is unchanged. An operating-system
  shutdown, logout, or updater restart stays immediate and offers nothing,
  because it cannot wait for a person.
- **Which threads.** Every thread on this host with a running turn or a
  question waiting on the person, and every open (not completed or archived)
  thread with a turn in the last 14 days. Older open threads fold under one
  "Older threads" row, closed, each staying here unless the person opens it and
  chooses otherwise. Delegated threads are listed as staying here with their
  reason.
- **The destination.** One **Move to** choice applies to every row set to
  move: the member the person last moved a thread to, otherwise the hub when it
  can take threads, otherwise the first eligible member that is online. A row
  may name another member through its own choice.
- **Each row's starting choice.** A thread the destination can take starts on
  **Move**. One with a running turn or a waiting question starts on **Move
  after this turn**; nothing is stopped unless the person picks Stop and move.
  One the destination cannot take starts on **Leave here** with its
  [reason](#a-thread-that-cannot-move) shown, and when it is a Code thread its
  choice also offers **Hand over**. A handover writes a commit and may push, so
  it is never preselected. Changing the destination re-evaluates every row that
  still holds its starting choice and leaves the person's own choices alone.
- **One press, one unlock per destination.** The primary action moves every
  row set to move or hand over. A batch is one ticket per destination naming
  every thread in it: the destination's owner challenge covers that list, and
  the ticket then opens one move of each named thread and nothing else, so
  one unlock covers the batch it names and nothing else. The batch's moves run
  one after another, so most are done early, and a thread set to move after
  its turn starts when that turn ends.
- **Finishing.** The screen says **Safe to shut down** only when every chosen
  thread is committed, or handed over and pushed. A thread whose move cannot
  finish shows [This thread can't move](#a-thread-that-cannot-move) with its
  reason and recovery on its row, and while any chosen thread failed, the
  screen says how many threads stay on this computer and lists them instead.
  When it was opened from the quit confirmation, it ends with Quit Octant as
  its primary action; quitting still goes through the guarded shutdown.

Rationale: a person shutting down wants their work to come with them, so
moving is the default wherever it can succeed, and the screen asks once, not
once per thread. Anything that writes outside the thread (a commit, a push) or
stops work (Stop and move) stays a choice the person makes.

#### Handover

When a Code thread cannot move properly (no member is reachable, the
destination has no Project bound to the repository, the destination refuses,
or the transfer fails or cannot finish in time), or the person picks **Hand
over instead**, the source offers a handover:

1. **Freeze**, as for a move, journaled as `thread.handover-started@1`.
2. **Write the note.** The host composes it from the journal: the thread's
   title and objective or delivery target, the person's latest instructions,
   the agent's latest answer, the plan or task list, the files changed against
   the branch's base, the last recorded check or test result, the approvals and
   questions the freeze cancelled, and what stays behind (ignored files,
   terminals, previews). When the thread's provider is reachable and the person
   left **Ask the agent to summarize** on, one bounded turn of the thread's own
   agent adds where the work stands and what comes next; if that turn fails or
   runs past two minutes, the note goes without it. The note is at most
   32 KiB, passes the Secret guard and redaction, and names no absolute path.
3. **Commit everything.** One commit on the thread's branch, or on a new
   `octant/handover/<thread slug>` branch when the thread works on the default
   branch or a detached head, takes the tracked changes and the untracked files
   Git does not ignore, under the Secret guard as for a move. Its message is
   the note, with the trailers `Octant-Handover: <handover id>` and
   `Octant-Origin: <member name>`, under the thread's own commit identity.
4. **Push**, when the branch has a remote: the existing Code push with the
   person's own Git identity, never forced and never to the default branch.
   Without a remote, or when the push fails, the handover stays on this
   computer and the receipt says so.
5. **Tell the destination**, when one was chosen and can be reached: a signed
   notice (`POST /api/hub/peer/handovers`) naming the repository remote, the
   branch, and the handover id, so it shows under **Handovers** on the
   destination's start screen before its next fetch.

The source thread stays frozen, marked "Handed over" with the branch. It is
erased the same way as a moved thread once a destination reports that it
continued the handover (`POST /api/hub/peer/handovers/:handoverId/continued`),
then or the next time the two reach each other. **Take back here** unfreezes it
instead; a handover continued after that leaves both threads with the "Also
continues on" notice.

On the destination, **Continue handover** is a person's act. It fetches the
branch with the destination's own Git identity, creates a Code thread in a
Project bound to that repository on a managed worktree at that branch, and gives
the first turn the note as a labeled text handoff. A branch whose tip carries
an `Octant-Handover` trailer is listed after the destination's next fetch even
without a notice: the destination reads the remote-tracking branches its Code
Projects' clones already have and fetches nothing to look. A found branch names
no provider, so it continues on the destination's own default model (the one
delegated Work runs on) and is refused as `no-matching-provider` without one.
Its continued report goes to the one member whose name its `Octant-Origin`
trailer gives; with none or several, no report goes and Take back here stays
open on the source. A found handover the destination made itself, already
lists from a notice, or already settled is not offered. A host tells its own
handovers by their ids, never by the `Octant-Origin` name, which another
computer may share; it keeps the id of each handover continued here, and of
each it made that was continued elsewhere or taken back, because the branch
tip still names it. A notice that arrives for a handover already settled
here is answered but not listed. The source
erases only for a report naming the commit it made, since anyone who can push
to the repository can write a branch claiming a handover's id. A note read
from a branch came through a remote others may be
able to push to, so it is framed as outside content and marks the thread with
`thread.external-content-ingested@1` under the source label `handover-note`.

Chat and Work threads have no branch to carry them, so they have no handover:
when their move cannot finish they stay on the source, unfrozen. Nothing is
exported to a file ([decision H23](#decisions)).

#### A thread that cannot move

A move that cannot finish always ends in an explicit error, never a silent
return to the source. The source journals `thread.move-failed@1` with one
reason, unfreezes the thread, and shows **This thread can't move** with that
reason in the move sheet and as a notice on the thread itself, which stays until
the person dismisses it or the thread moves. The reasons are:

| Reason                    | Meaning                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `busy`                    | A turn runs, the thread waits on the person, or a child run or remote child run is still going, and the person did not choose Stop and move          |
| `delegated`               | The thread was delegated to this host by a peer and belongs to that delegation                                                                       |
| `unlock-required`         | The person declined the unlock, it expired, or this device is not an owner on the destination                                                        |
| `refused`                 | The destination refused: no Move in item, Owners unticked, or the source is no longer in its roster. It answers every one of these in the same words |
| `no-eligible-project`     | The destination has no Project of the thread's mode that accepts it (for Code, none bound to the same repository)                                    |
| `destination-unreachable` | The destination could not be reached before the offer, or stopped answering during the transfer and the person gave up waiting                       |
| `transfer-failed`         | A part failed its digest check twice, or the destination could not unpack it                                                                         |
| `no-matching-provider`    | The destination has no provider of the kind the thread ran on, so it cannot continue it                                                              |

For a Code thread the same error offers **Hand over instead**. A handover that
cannot finish its push says so as its own error (`push-failed`, or `no-remote`
when the branch has no remote): the commit and note stay on this computer, and
the receipt says the work is not on any other computer yet. Rationale: the
person is about to switch the computer off, so a thread left behind without a
clear error would look moved and be unreachable until the computer comes back.

Rationale: a move is a fork to another computer with an erase behind it, not a
shared or replicated journal. Each host keeps one writer and its own journal,
which the rest of this design depends on, and freezing before anything is sent
and erasing only after `committed` means two copies can take turns only when
the person chose Take back or Activate anyway. Git carries a handover because a
Code thread's work already lives there and every member fetches it with its
own identity, so no new transport or file format is needed.

### Connectivity

All members are the person's own devices on one private network, and
hub-and-spoke traffic never touches the public internet. Members reach the
hub, and each other, directly under the existing address rule: a Tailscale
(or similar mesh) address, or a LAN address. The roster carries each member's
private-network names and addresses, so members connect without the hub in
the path.

- **Private only.** The hub role, joining, and every member-to-member request
  are served only on the private listener, which binds only LAN and mesh
  addresses. A host refuses to turn the hub role on while its listener has a
  public address, and refuses a join code or roster entry that names one.
- **No relay, no port forwarding.** Hub-and-spoke traffic never goes through a
  relay, including a self-hosted [hosted relay](hosted-relay.md), and no
  member opens or asks for a port on the internet. A device away from home
  joins the mesh to reach its members.

Rationale: the private network is the first lock. Only the person's own
devices can reach a member at all, and pairing over that network is what
proves a new member is theirs.

### Failover

The person keeps one hub active and may name standby hubs in order. Members
connect only to the active hub; the roster tells every member who the standbys
are and how to reach them.

- **What a standby holds.** A standby is a spoke whose hub grant to the hub
  includes Standby, and which the person marked on the hub. The hub sends it
  each new roster and the wake times, so it can take over the hub's services.
  It holds no more authority on other spokes than the hub has: each spoke's
  hub grant names whether it applies to the standby too, and it does only
  when the spoke ticked Standby at join (off by default).
- **When members switch.** A member that cannot reach the active hub for a
  set time (default five minutes) tries the first standby, then the next. A
  standby that sees no hub for that time starts acting as hub: it serves the
  roster it has, runs wake and push for members whose grants allow it, and
  tells members it is standing in.
- **Membership while standing in.** A standby that is standing in may add
  and remove members, signing each roster update with its own key. A member
  accepts a standby-signed roster only from a standby the latest hub-signed
  roster names, and only while that member cannot reach the hub. A member
  that joins for the first time during a stand-in has no hub-signed roster
  yet, so it trusts the standby the way a device trusts the hub when it
  joins: it reads the standby's join code and compares codes, and it receives
  the hub-signed roster that names the standby along with the update. A
  standby never changes the standby order or promotes itself
  ([decision H10](#decisions)). A member installs a roster, whoever signed it
  and however it arrives (a push, the hub's heartbeat answer, a hand-back),
  only where its person ticked Roster. Where Roster is off, a heartbeat still
  shows the hub is reachable, but nothing it carries is installed.
- **Switching back.** When the hub is reachable again, the standby steps down
  and hands back the wake times and membership changes it made, and members
  return to the hub. From the moment the hand-back is built until the hub has
  taken it, the standby refuses joins and removals (`handing-back`), so none
  is lost when the stand-in ends; if the hub does not take the hand-back, the
  standby unfreezes and tries again at the next look. The hub's next signed roster includes those changes; when
  a member was both added and removed in the meantime, removal wins. If
  both are reachable at once to different members (a split network), the only
  duplicated work is a second wake nudge or a delayed notification: neither
  can start work, because spokes decide.
- **Replacing the hub for good.** Promoting a standby to hub permanently, for
  example after the Mac mini dies, is a local action on the standby that the
  person confirms, followed by each spoke accepting the new hub
  ([decision H11](#decisions)): a spoke that ticked Standby takes it after the old
  hub has been silent for the failover time, and any other spoke accepts it in
  its own window.

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
- **The switch is the hub's own, and a stand-in obeys it.** The hub hands each
  standby its wake switch with the copy of the times. A standby that is
  standing in takes reports and wakes spokes only while the copy says the
  switch is on; a copy that does not say so (missing, or from an older hub)
  counts as off, and the standby refuses a report with `wake-service-off`.
- **Times the hub cleared are sent again.** Turning the switch off or on
  clears the hub's times and moves a wake generation. Turning the hub role off
  and on does the same, and the generation never goes backwards. The hub's report answer
  and heartbeat carry it, and a spoke that sees it change forgets what it last
  sent and reports in full on its next look, without any routine changing.
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
  read, exactly as the gateway does. The spoke also signs the delivery request
  with its own host identity key, as the gateway requires, and the hub passes
  it on unchanged; the hub never signs for a spoke.
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

| Item                                              | Owner and journal                                                                                                         | Never                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Threads, turns, approvals, Done                   | The spoke that runs them                                                                                                  | Mirrored into the hub's journal                                                                             |
| Joining, hub grant, peer grants, leave            | The member, locally or by an owner's unlocked act                                                                         | Changed by the hub or a peer                                                                                |
| Roster, standby order, removal                    | The hub; a standby adds and removes while standing in                                                                     | Changed in standby order by a standby                                                                       |
| Delegation request and result reference           | The delegating spoke (A)                                                                                                  | Treated as authority on B                                                                                   |
| Delegated thread                                  | The receiving spoke (B), principal `peer:A`                                                                               | Approvable from A or the hub                                                                                |
| A message between members                         | The sender (A) until B accepts it, then B, `peer:A`                                                                       | Carried by the hub; a body in either journal                                                                |
| A moved thread                                    | The source until the destination commits, then the destination, as the person's own thread (owner device, `owner-unlock`) | Able to take turns on two hosts unless the person chose Take back or Activate anyway; journaled as `peer:A` |
| A handover                                        | The source until a destination reports it continued, then the destination's new thread                                    | Carried by the hub; a credential or an absolute path in its note                                            |
| A thread's Reachable tag                          | The host that owns the thread, set by a person                                                                            | Set by an agent, the hub, or a peer                                                                         |
| Wake times (routine id, next time, hardware addr) | The hub and standbys, rebuilt from spoke reports                                                                          | Holds the routine's prompt, Project, or profile                                                             |
| Push envelopes in transit                         | Not journaled on the hub; counts and failure category only                                                                | Readable by the hub                                                                                         |
| Credentials                                       | The broker of each host that holds them                                                                                   | Copied except by an owner's unlocked act; journaled                                                         |

Hub and spoke membership state (the hub's roster and members, and a spoke's
hub link, grant, and roster) lives in one file in the Octant data folder that
only the person's account can read; a file that cannot be read back exactly is
treated as no state. Each change to it is also written to the journal with its
principal. Rationale: the file is what a restart reads, and the journal is the
record of who changed what.

All-hosts views stay client-side merges, as Architecture's federation rule
says. The hub does not serve a merged read model of spokes' threads; a member
reads each spoke directly.

## Threat model

| Party                                | Can                                                                                                                                                                                                                                                                                                                 | Cannot, and why                                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A compromised hub                    | Use every hub grant each spoke gave it; add a fake member to the roster, which spokes accept as a full member unless they turned on Confirm new members, and which every spoke alerts on; drop or delay wakes and push; read roster metadata                                                                        | Approve on a spoke itself, hide a new-member alert, read a spoke's credentials, add an owner to any host's owner list, change a hub or peer grant, loosen a sandbox, read sealed push content, or act on a spoke that never granted Act                 |
| A compromised standby                | While standing in, what a compromised hub can, limited to the spokes whose grant covers the standby                                                                                                                                                                                                                 | Stand in while members still reach the hub, change the standby order, promote itself, or anything a compromised hub cannot                                                                                                                              |
| A compromised spoke                  | Use the peer grants other spokes gave it; send bad results back to a delegating spoke; post text into the threads other members tagged Reachable, which arrives framed and tainting and can wake an idle tagged thread within the wake bounds, spending that spoke's provider usage; claim to be standing in as hub | Exceed those grants; answer approvals on another spoke; make another spoke's agent follow its output as instructions; stand in unless it is a named standby in the hub-signed roster; move a thread onto another member without an owner's fresh unlock |
| A stolen owner device                | What an ordinary member can, until removed or revoked                                                                                                                                                                                                                                                               | Use owner powers without the person's face, finger, passcode, or passkey                                                                                                                                                                                |
| A lost or stolen phone               | What each spoke allows that guest, until revoked                                                                                                                                                                                                                                                                    | Run agents, receive delegated work, or outlive Remove on the hub and revocation on each spoke                                                                                                                                                           |
| A spoke's agent                      | Ask its own host to delegate within its thread's authority; from a tagged thread, message other members' tagged threads                                                                                                                                                                                             | Choose the peer grant, tag a thread, start more than the bounded wake turns on a tagged receiver, approve on the receiver, widen authority, carry a credential                                                                                          |
| Someone on the private net           | Reach members' listeners, as today, and send Wake-on-LAN packets, as anyone on that LAN already can                                                                                                                                                                                                                 | Pass device authentication; make a spoke run anything: a wake starts no routine the spoke did not define                                                                                                                                                |
| Someone who can push to a repository | Push a branch whose tip carries an `Octant-Handover` trailer, which a member lists under Handovers                                                                                                                                                                                                                  | Make its note more than outside content, or start a turn: only a person continues a handover                                                                                                                                                            |

The biggest risk is the hub as introducer: whoever controls the hub can tell a
spoke that an attacker's key belongs to another member, and with full
membership by default (decision H2) that fake member gets a full-member grant
at once. A fake guest could then answer approvals for work it starts, and a
fake spoke could delegate work that reads a Project and returns it. The
maintainer accepted this for a person's own devices, on these grounds: the
hub is reachable only over the person's private network, so the attacker must
first control the hub itself; every spoke and owner device alerts on each new
member, and those alerts come from the spokes, so the hub cannot hide them;
the full-member grant never reaches Full access, which only an owner can
choose with a fresh unlock; and a spoke whose person wants no exposure turns
on **Confirm new members**, which closes the gap at the cost of one unlock per
new device. Owner powers move the main risk to
the unlock key; it lives in each device's secure hardware and is used only
after the person proves presence.

## Decisions

The maintainer settled these on 2026-10-28. Where the maintainer left the
choice to the design, the design's recommendation was taken.

| ID  | Question                                                                    | Decision                                                                                                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H2  | Does a spoke accept new roster members automatically?                       | Yes, as full members: delegation into every Project up to Code approval-gated, and for a guest paired-device authority. Every spoke and owner device alerts on each new member; an optional per-spoke setting holds new members until an owner confirms them. The spoke's person can narrow or revoke any member |
| H3  | When a member leaves or is removed, are its peer grants dropped?            | Dropped on leave and on a removal seen in a newer roster; kept while the hub is merely unreachable                                                                                                                                                                                                               |
| H4  | One hub per spoke, or several?                                              | One active hub. A standby takes over the roster and coordination only while the hub is down                                                                                                                                                                                                                      |
| H5  | May the hub's provisioning offers apply on a spoke without asking?          | Per kind (update channel, untrusted plugin install, profile without secrets), off by default; a routine always asks                                                                                                                                                                                              |
| H6  | Can a subscription sign-in held by a provider's own app be copied?          | Never; these tokens refresh, so a copy and its source would log each other out, and the provider's terms are unchecked. Each machine signs in itself, and the hub can ask a spoke to start that sign-in (hub-started sign-in); the person finishes it on the spoke. API keys copy already                        |
| H7  | Which push path does the hub support first?                                 | Forward to the push gateway from Mobile maturity, or, off by default, send directly from the hub with the person's own Apple and Firebase credentials for a phone app they built ([Building the phone app yourself](mobile-maturity.md#building-the-phone-app-yourself))                                         |
| H8  | Where do the hub's services live?                                           | In the Octant server (`apps/server`). The roster and failover are on with the hub role; the wake service and push sender are each off until turned on                                                                                                                                                            |
| H10 | May a standby add or remove members while standing in?                      | Yes; the hub takes the changes back on return, and removal wins                                                                                                                                                                                                                                                  |
| H11 | How is a standby promoted to hub for good?                                  | A local action on the standby; spokes whose grant covers the standby follow it, and the rest confirm the new hub locally                                                                                                                                                                                         |
| H12 | How long without the hub before members fail over?                          | A setting on the hub, carried in the roster, default five minutes                                                                                                                                                                                                                                                |
| H13 | Does the hub keep running when the desktop app quits, and after a restart?  | Yes, on macOS, Linux, and Windows: the hub runs as a boot service under the person's account (a launch daemon, a lingering systemd user service, a Windows service) and starts unattended after a restart, power cut, or update. The desktop app connects to it                                                  |
| H18 | Where does the hub keep its own keys so it can serve before anyone logs in? | The same way on every platform: a file in the Octant data folder readable only by the person's account, on an encrypted disk (FileVault, LUKS, or BitLocker); setup warns when the disk is not encrypted                                                                                                         |
| H14 | Does a host fetch its own Tailscale certificate for the web app?            | Yes, on the hub and on each spoke a browser reaches directly, through the local Tailscale daemon, off until the person turns it on after the certificate-transparency note                                                                                                                                       |
| H15 | How does a browser guest reach a spoke?                                     | Directly: each spoke serves its own web app at its own Tailscale name, and the hub's web app links to it, so the hub never sees spoke traffic                                                                                                                                                                    |
| H16 | Do spokes honor owner devices by default?                                   | Yes: ticked at join, clearly labeled, and untickable                                                                                                                                                                                                                                                             |
| H17 | How long does one unlock last?                                              | One Face ID, Touch ID, passcode, or passkey check covers five minutes of administration screens; Full access, merge, credential copy, and owner changes each need their own                                                                                                                                      |
| H19 | Which thread moves are in scope?                                            | Planned moves only. A computer that dies without warning hands nothing over; a continuously updated copy on another member is not designed                                                                                                                                                                       |
| H20 | What authorizes a move on the destination?                                  | An owner device's own fresh unlock for every move, and the destination's Move in peer-grant item, which is in the full-member grant. The moved thread is the person's own thread there                                                                                                                           |
| H21 | What happens to the source's copy?                                          | It is erased through the ordinary thread purge once the destination commits, and its tombstone points to the destination                                                                                                                                                                                         |
| H22 | Is a move limited in size?                                                  | No. Attachments, original inputs, captures, owned Canvases, and a Code thread's whole branch and uncommitted work travel whatever their size; ignored files never do                                                                                                                                             |
| H23 | What happens when a move cannot finish?                                     | There is no file export. A Code thread hands over: everything is committed to its branch with a generated note, pushed when there is a remote, and continued from that branch on another computer. Chat and Work threads stay where they are, and every failed move shows an explicit error with its reason      |

On 2026-11-07 the maintainer added messaging between members: an agent on one
computer must be able to message a running thread on another when that thread
is tagged, across providers, using this topology rather than a new host-to-host
channel. The design took its own recommendation for the rest (a per-thread tag
on both ends, the Message peer-grant item, a message waiting on the sender while
the receiver is unreachable); see
[Messaging between members](#messaging-between-members).

The same day the maintainer asked for moving an active thread to another member
before its computer shuts down or restarts, and settled H19 to H23: planned
moves only, every move owner-signed (the person is the same on every member),
the source erased once the destination commits, no size limit, and a handover
through the thread's branch instead of an offline file path; see
[Moving a thread to another member](#moving-a-thread-to-another-member).

Earlier on 2026-10-28 the maintainer settled that a standby hub exists (was
H1), and that no member acts as a relay or introducer except the hub and a
named standby (was H9).

## Delivery plan

Each slice is one reviewable PR and keeps everything off by default. A slice
that ships user-visible behavior updates the user guide in
[octant-site](https://github.com/Ogard-Labs/octant-site/tree/main/docs) through a
companion PR linked in both descriptions; slices 3, 5, and 7 together document every row of
[Recovery and approval scenarios](#recovery-and-approval-scenarios) there. Each
slice says whether an agent can verify it in a Linux container without the
maintainer's hardware, or names the maintainer gate.

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
   Acceptance: the hub comes back by itself after a restart with no one
   logged in; only the member can join, leave, or change its grant; the hub
   principal is refused every route outside its grant; joining refuses any
   path that is not private. Verification: route registration, permission
   negatives, a two-host smoke on loopback. **Yes.**
4. **Guests and client views.** The phone app or a browser joins by QR or
   code as a guest, receives the roster, and reaches each spoke that accepted
   it (H15); the hub can fetch its Tailscale certificate for the web app
   (H14); desktop windows show every member. Acceptance: a spoke that has not accepted a
   guest refuses it; a forged roster refuses. Verification: client-runtime
   tests and a three-host smoke; a phone run is a maintainer gate.

   Built, with these narrower readings for a browser on the hub's page:
   - **The roster already carries the link.** A spoke's web app origin is
     `https://` plus the first `.ts.net` name its signed roster entry lists, and
     its listener port. No roster field was added, the hub signs nothing new, and a
     member with no Tailscale name has no web app to link. The hub never proxies.
   - **The introduction is the roster the spoke holds.** A browser guest asks a
     spoke at that origin to admit it with the same signed request a phone sends
     (`/api/hub/guest`). The spoke admits it only if it accepted the guest when a
     verified roster listed it, and refuses it otherwise, so there is no new
     code or token. A browser that cannot make a passkey stays a plain guest.
   - **The browser reaches only origins it was served from or the roster names.**
     It never relaxes its certificate check and sends no request that asks for a
     pin.
   - **A spoke answers the hub's page cross-origin for three requests.** The
     spoke lets the origin of the hub's own web app, taken from the roster it
     holds, make `POST /api/hub/guest` and read `GET /api/hub/owner/alerts` and
     `GET /api/hub/owner/held-members`. Each stays signed and judged by the
     handler. Every request that changes something stays same-origin, because it
     asks for an unlock and a passkey belongs to one origin. No other origin, and
     no spoke without a roster naming a hub web app, gets any of it.
   - **The owner panel reads, then points.** It reads each spoke's alerts from the
     spoke's origin with the browser's device key and names a spoke that did not
     answer; to confirm, dismiss, or remove, the person opens that spoke's own
     page. A browser that is not an owner on a spoke gets that spoke's refusal.

5. **Owner devices and shared sign-ins.** Owner marking, the Owners hub grant
   item, unlock keys on the phone (Secure Enclave, Android Keystore), the Mac
   (Touch ID or password), and the browser (passkey), unlock verification on
   the host, the owner routes for administration, credentials, and postures,
   and sign-in copy. Acceptance: an owner request without a fresh unlock is
   refused every window power; an agent, routine, hub, or peer request never
   reaches them; a copied key is unreadable by agents on both hosts and never
   journaled; a headless hub is set up end to end from a browser owner; with
   Confirm new members on, a new member stays status-only until a spoke's
   window or an owner's signed unlock confirms it, and the hub cannot; losing
   every owner device is recovered from a spoke's window or the hub's shell.
   Verification: server permission negatives and a two-host smoke with a
   software authenticator; phone and Touch ID runs are maintainer gates.

   The five-minute session, the posture routes, and the API-key copy are built,
   with these narrower readings:
   - **Administration is a short list.** A session covers dismissing or removing
     from an alert, changing the hub grant, Confirm new members, a join code
     without the owner mark, the hub role, Remove, reading a posture, any
     posture change but Full access, and applying or dismissing an offer. Opening a
     session, adding or removing an owner, confirming a member, leaving the hub,
     an owner join code, Full access, and a sign-in copy are the own-unlock
     class, stricter than the decision's list names (confirming and leaving are
     placed there because each is a one-way membership act).
   - **A session is checked against the owner list, not a clock alone.** The host
     compares a counter of owner-list changes (kept in memory, raised on every
     add and remove) with the one the session opened against, so a window that
     removes a device and lists it again ends the session too.
   - **Postures are a Code Project's and a Code thread's.** A Project's posture is
     whether it remembers Full access for its threads. Work threads take the shared
     guardrail levels ([Modes](../architecture.md#modes-chat-work-and-code)), but the
     owner routes read and change only a Code posture; reading a Work thread's level
     is not built. Reading one asks for an unlock or an open session, which is stricter
     than reading an alert. The same read route lists active Code targets by name.
     Every reading carries a digest of the current thread, Project, binding and
     checkout records. The signed change names that digest, the target and the
     requested posture and persistence. The host re-reads these records and
     refuses a changed version or target before calling the synchronous Code or
     Project service transaction. Full access requires this action's own fresh
     unlock; an administration session cannot satisfy it. The services journal
     the actual `owner-unlock` member, including any lowered guardrail, and
     never mint a window or cache a grant. A thread change discards legacy
     session grants everywhere. Settings and the phone show named targets and
     current/requested postures, including an existing automatic reviewer, and discard their reading after any apply;
     retry begins with an authoritative refresh and the required proof. Readings,
     selections and pending UI results belong to the selected member and client
     incarnation. A roster removal or client replacement clears that state before
     display and ignores old completions; it never transfers or retries a signed
     command against the replacement host. A
     running turn keeps the posture it launched with. The Project path changes
     its remembered Full access default; it does not change existing threads.
     Actual signed routes, Code/Project services and SQLite readback/replay are
     proved with deterministic unlocks. Physical-device unlock remains unrun.
   - **A sign-in copy is two unlocks on two hosts.** Each host keeps its own owner
     list, so the owner device unlocks on the receiving host first, which makes
     a one-time ticket (two minutes) naming the sending host and the receiving
     host's own provider row, then on the sending host, which reads the key from
     its own provider row and hands it over the pinned link against that ticket.
     Provider rows get a fresh id on every host, so the owner names the row on
     each side and the ticket, not the sender, decides where the key lands. It
     runs between spokes only: the hub is neither source nor target. Only an API
     key or bearer token on a provider row is copied; the receiving host never
     replaces a key already stored (two copies redeemed together store once, and
     the second is answered `already-stored`), a pool of several keys is refused,
     and a subscription sign-in is refused as `subscription-sign-in`.
     Both hosts journal the names and the owner device, never the value, and the
     key is never returned to the owner device. The hub's view of copies and
     Remove everywhere are not built.
   - **No window for these yet.** The server routes and the client-runtime calls
     (`openSession`, `readPosture`, `changePosture`, `copyApiKeySignIn`) are built;
     the Settings rows and the phone screens that call them are not.
   - **A Mac's unlock key is built and has one door.** The desktop's native
     Keychain helper makes a P-256 key in the Secure Enclave whose access
     control needs the person present (Touch ID, falling back to the account
     password) and keeps only the key's enclave-bound blob in the Keychain. The
     window's bridge has three calls: make the key (the public key comes back),
     sign one owner unlock challenge, and forget the key. `sign` takes the
     host's challenge fields and the desktop builds the unlock text itself; a
     path outside the owner routes, a method other than GET or POST, a field
     with a line break, or any extra field is refused, so the bridge signs no
     other text. A Mac with no Secure Enclave, or with no Touch ID or password
     set, refuses with `unavailable`; it never makes a software key. Joining a
     hub from the desktop makes the key and presents its public half at the end
     of the join, and the hub keeps it only for an owner code; a join that ends
     without joining, and leaving the hub, forget the key. The key is made on
     every desktop join because the joining side cannot tell an owner code from
     another; an unused key of a non-owner join stays until the Mac leaves. The
     Mac's key signs the unlock text only: a new-member confirmation needs a
     phone's or a browser's key, and a Touch ID prompt that is declined reads as
     a cancelled unlock. No desktop screen acts as an owner on another
     computer yet (a desktop window already holds its own host's powers), so
     the signer (`desktopUnlockSigner` in client-runtime) is built and tested
     with a software key but has no caller beyond the join. Not run: the real
     Touch ID prompt and a signed, packaged helper on a real Mac are a
     maintainer gate.

6. **Delegation.** Remote child runs from A to B with the peer grant, `peer:A`
   principal, approvals on B, results as data, and cancel. Acceptance: B
   refuses a request outside the grant or above approval-gated Code; an
   approval on B cannot be answered from A or the hub; the result is recorded
   on A as external content. Verification: server tests and a three-host smoke
   with a fake provider; a real-provider run is a maintainer gate.

   Built, with these narrower readings:
   - A spoke now introduces the other spokes as well as guests (the hub is never
     introduced), so a new spoke holds the full-member peer grant for each.
   - The sender's identity public key travels beside its signature
     (`x-octant-hub-peer-key`); the receiver accepts it only if its fingerprint is
     the one the held roster lists, then checks the signature.
   - The hub and a standby never send delegated work; a guest neither sends nor
     receives it. A request asking for more than the clamp allows is refused with
     the posture it could have had, never run narrower.
   - A remote child has the parent's mode and no more than the parent's posture.
   - Only Work Projects take delegated work. A Code Project reports no delegable
     mode, because a Code thread needs a managed worktree and a delivery target a
     person confirmed. Work asks first and has no read-only posture, so a plan-only
     request is refused; a named provider profile is refused, and the thread runs on
     the default model the Work settings name.
   - Artifact references are empty: a Work turn reports the paths it changed, not
     content digests.
   - An agent's helper request carries an optional target member (a roster member
     id), on the `octant_agents` tool and the native harness `delegate` tool alike.
     It also carries `targetProjectId`, required with a member: Projects get their
     own ids on each host, so the parent's Project id on A means nothing on B and is
     never sent. A cannot list B's Projects (the grant naming them is held on B),
     so the agent is given the id by the person and B checks it against that grant
     as it does for the loopback routes. A missing one answers
     `remote-delegation-project-required`; one B does not have or the grant does not
     cover answers as the member's refusal.
     It reaches the same delegating service the loopback routes use, so the parent
     check, the peer-grant clamp, `peer:A` on B, approvals on B, the framed and
     tainting result, and the cancel on a stopped turn are one set of rules. The
     request takes a task only: a model, `after`, or the parent's conversation is
     refused. The posture is always Work's approval-gated, clamped by the parent
     and the grant, never chosen by the agent. Only a Work thread in a Work Project
     may name a member; a Chat or Code parent, a Project that is not a Work Project,
     Work turned off, no hub membership, an unknown member, a paused parent, and a
     member that refuses (no grant for this host, or a grant that does not cover the
     request) each answer as a refusal value, and the target's own words are not
     repeated to the model. Capabilities report `remoteDelegation` honestly. The
     agent receives the request id; reading the result and cancelling a single
     request stay on the loopback routes (a stopped parent turn still cancels them),
     and a driver whose tool surface is not one of these two has no way to name a
     member.

7. **Failover.** Standby order, roster and wake-time copies, stand-in and
   step-down. Acceptance: members switch after the set time and return when
   the hub is back; a standby's membership changes merge back with removal
   winning; a spoke not named as
   standby cannot stand in. Verification: a three-host smoke that stops the
   hub. **Yes.**

   Built, with these narrower readings:
   - **Naming is a handshake.** The hub signs a request to each spoke it means to
     name, and the spoke answers only if its person ticked Standby. The hub does
     not learn a grant from anything else, so a spoke that unticks Standby later is
     still named in the roster; it refuses to stand in (a standby needs the item
     on its own grant), and members that did not tick it refuse its rosters.
   - **A standby's key is its host identity key.** It signs rosters with it and
     presents the public key beside its signature; a member accepts the key only if
     its fingerprint is the one the latest hub-signed roster lists for that
     standby. There is no separate standby roster key.
   - **"Cannot reach the hub" is measured by the member.** Every member looks for
     the hub on a timer (a signed heartbeat) and remembers when it last answered. A
     standby-signed roster is accepted only if a fresh heartbeat fails and the
     silence has lasted the failover time; the time comes from the roster
     (default five minutes) and a test may override it. Only a standby that stands
     in tells members, by signing the next roster with its own key and sending it;
     a member that missed that asks the standbys in order.
   - **The standby holds the roster, and the wake times once the wake service
     is on.** What a standby needs to take over is the latest hub-signed roster,
     which names every member's address, pin, and key fingerprint. The wake times
     travel apart from the roster, as slice 8 records; the hand-back's `wakeTimes`
     field carries what spokes reported to the standby while it stood in.
   - **A stand-in adds spokes only, never owners or guests.** A join through a
     stand-in code makes a spoke with no owner mark; guest joins and the owner
     code wait for the hub. A standing-in standby cannot remove the hub or a
     standby, because either would change the standby order or a hub role, which
     every member refuses from a standby. Leave is told to the hub only.
   - **Merge-back is the hub's.** The standby sends its additions and removals
     with the hub-signed sequence it stood in on; the hub keeps a log of its own
     removals by sequence and merges with `mergeStandInMembership`. The hub drops
     an unsigned claim of an owner mark, an unlock key, or a port from an added
     member and records the member with no paired device, so the hub holds no owner
     power for it until a person confirms one. The hub refuses the whole hand-back
     (`handback-invalid`, journaled as `stand-in-refused`) if it removes the hub, a
     standby, or the sender, or adds anything but a spoke: the hub signs the merge,
     so it must not carry a change members refuse from a standby.
   - **Promotion is followed by spokes that ticked Standby, and awaited by the
     rest.** A named standby, on the person's confirmation in its own window or
     `octant hub promote --confirm`, becomes the hub, clears the standby order,
     drops the old hub from the roster, and signs with its own roster key. A
     spoke whose hub grant ticks Standby takes it without a person
     (`decideHubFollow`) only if it also ticks Roster, and only on its own failover look: the old hub must have
     been silent for the whole failover time (so a promotion while the old hub is
     reachable waits for the person, as a standby-signed roster does), the signer
     must be a standby the last hub-signed roster named, with the key that roster
     fingerprints, answering as hub with a signature that verifies against its
     roster key, and the roster must list the spoke and move the sequence
     forward. The spoke's grant, peer grants, and owners carry over untouched, and
     the journal records `new-hub-accepted` under the new hub with the reason
     `standby-granted-hub-silent`. A refusal changes nothing. Every other spoke
     accepts the new hub in its own window (`octant hub accept-hub`); none shows a
     pending notice, and a spoke that is off or asleep during the look follows or
     waits on a later one. A standby that is itself standing in when another is
     promoted does not follow. The new hub trusts
     the key a member presents when its fingerprint matches the roster. Guests the
     standby admitted as a spoke are revoked, and guests join the new hub again.
   - **Where the person reaches it.** The hub's Settings section sets the
     order; a standby's Settings shows that it is standing in and carries the
     promotion. Stand-in join codes, stand-in removal, and accepting a promoted hub
     are `octant hub` commands and loopback routes only.

8. **Wake service.** Spokes report wake times; the hub sends Wake-on-LAN or a
   nudge; the spoke fires its own timer. Acceptance: the hub never learns a
   routine's prompt or Project; a nudge for an unknown routine does nothing.
   Verification: server tests; a real Wake-on-LAN wake of a sleeping Mac is a
   maintainer gate (hardware).

   Built, with these narrower readings:
   - **A report replaces what the hub held.** A spoke sends every enabled
     routine's next occurrence in one list, under a random id it made for each
     routine and keeps only in its own hub-link state (dropped when it leaves).
     A routine that is removed or disabled drops out of the list, which withdraws
     it, and loses its id. The body carries no member id: the hub files it under
     the member whose key signed it, and refuses a guest or the hub itself.
   - **Reports are numbered and sent one at a time.** Every way into a report
     (the timer, a new hardware address, a grant change, a new hub wake
     generation) goes through one path on the spoke: a change asked for while a
     report is in flight is sent once when it completes, never in parallel. Each
     report carries a sequence the spoke keeps in its hub-link state, above its
     last and never below the clock in milliseconds, so it survives a restart. The
     hub (or a standing-in standby) applies a report only when its sequence is
     above the last it applied for that spoke, counting a withdrawal's, and
     answers `stale-report` otherwise; the spoke counts that as done. Without
     this a withdrawal that outran an older report was undone by it, and later
     looks never withdrew again. Hand-backs still use `reportedAt` and the
     withdrawal record.
   - **Wake is its own switch on the hub, window only.** `octant hub wake on|off`
     and Settings › Hub reach the loopback administration route; a remote client
     never does. Turning it off forgets every held time and tells the standbys to
     do the same. While it is off the hub refuses reports.
   - **A spoke reports only while its grant ticks Wake.** Unticking withdraws the
     list and the hardware address. The spoke keeps, in its hub state, that it
     has shared wake state not yet withdrawn, and clears that only after the hub
     confirms, so a restart before its next look still withdraws. The hub also
     drops a spoke's held times and address when that spoke leaves or is removed.
     The hub cannot know a spoke's grant, so the spoke is the only check:
     it also refuses a nudge once Wake is unticked, so stale hub-held times cost
     nothing.
   - **The hardware address is the spoke's, entered in its own window or never.**
     It travels inside the report, only while Wake is ticked, and is stored with
     that spoke's times, copied to standbys with them, and forgotten with them.
     The packet is six `0xFF` bytes then the address sixteen times, broadcast on
     the LAN (`255.255.255.255:9`) through a port tests replace.
   - **A packet alone is not a wake.** Wake-on-LAN cannot be confirmed, so the
     hub sends the packet once per occurrence, then repeats the signed nudge on
     each look (every 15 seconds) from the lead time (default two minutes) until
     the spoke answers or the occurrence arrives. If no nudge was answered by
     then the occurrence is recorded unreachable, even when a packet went out.
   - **The spoke believes a nudge only if** the id maps to an enabled routine it
     has, the time is within a minute of that routine's own next occurrence, the
     occurrence is within ten minutes, and its grant ticks Wake. Believing it
     pokes the host's scheduler, which claims only what its own clock says is
     due; nothing in the nudge path can start a run. Anything else is answered as
     ignored, with the reason, and journaled.
   - **A standby's nudge needs more.** The spoke must also have ticked Standby,
     and must itself be unable to reach the hub for the failover time, the test
     it applies to a standby's roster. The hub's own nudge needs neither.
   - **Standbys hold a copy.** The hub hands every named standby the times it
     holds (also on a timer, and when the switch changes). Only a spoke that
     ticked Standby takes one. While a standby stands in, spokes that follow its
     roster report to it, it wakes from the copy overlaid with those reports, and
     on step-down it hands the reports back with the membership changes. The hub
     takes them only for spokes it still lists, only while its wake service is
     on, and a report replaces what it held for that spoke.
   - **Copies are numbered, and the routes are sized for the largest.** The hub
     sends copies without waiting for each other, so each carries a revision the
     hub keeps rising; a standby keeps a copy only if its revision is newer than
     the one it holds, and answers an older or equal one `stale-copy` (409). The
     copy and hand-back routes accept a body of every allowed spoke at the
     allowed number of times (about 8 MiB, plus 1 MiB for the membership changes
     in a hand-back). If a gateway still answers a hand-back 413, the standby
     journals `wake-times-dropped` and hands back the membership without wake
     times; spokes report them again.
   - **Results.** The last result per spoke (nudged, ignored, refused,
     unreachable) is kept on the hub for Settings and `octant hub status`; a
     standing-in standby journals its results and does not keep them.
   - **The journal** records reports, merges, nudges sent, refused, and
     unreachable occurrences, each with its principal, a count, and a reason
     word. Routine ids, names, and times are not journaled.
   - **The hub's own routines are not reported.** It is awake, runs its own
     scheduler, and has no hub to tell.
   - **The window bridge.** The desktop's allow-list of hub operations gained
     `wake` and `wake-hardware-address`, each decoded against its contract before
     it is forwarded.

9. **Push through the hub.** Spokes hand sealed envelopes to the hub, which
   forwards per H7. Depends on the push gateway slices in Mobile maturity.
   Verification: transport tests against a local gateway; a device delivery
   is a maintainer gate.

   Built, with these narrower readings:
   - **The capability names no gateway, so the request may.** A capability is
     opaque (`v1.<key id>.<sealed>`), so nothing in it says where to send. The
     hand-off carries the spoke's own gateway address only when its Notifications
     setting names one other than the default. The hub forwards to the gateway its
     own Notifications setting names, when the request names none or names that
     same one, and refuses any other (`gateway-mismatch`): a spoke cannot aim the
     hub's forward at an address the hub's person never chose. The spoke then
     falls back to its own gateway.
   - **The hub forwards only if its own Notifications setting is on.** That
     switch is what lets a host contact a gateway at all, so push through the hub
     adds no external call the person did not allow on that host. The push
     sender is a second switch on top of it, off by default, window only
     (`octant hub push on|off`, Settings › Hub). A standing-in standby uses its
     own Notifications setting the same way.
   - **The hub asks the spoke; it never assumes a grant.** Only the spoke knows
     its grant, so before each forward the hub (or a standing-in standby) sends the
     spoke a signed question over the pinned link and forwards only on `granted`.
     A spoke it cannot reach, or one that says no, gets no forward
     (`grant-unconfirmed`, `push-not-granted`). No answer is cached, so unticking
     Push takes effect on the next notification.
   - **A standby needs more, and the spoke checks it twice.** A standby forwards
     only while it stands in, only if the hub's switch was on when the hub last
     told it (a signed copy of the switch, taken only by a spoke that ticked
     Standby), and only for a spoke that ticked Push and Standby and cannot reach
     the hub for the failover time. The spoke applies the last rule when it hands
     over and again when the standby asks.
   - **A spoke hands over to one place.** The hub, or the standby whose
     roster it follows because it could not reach the hub; it does not try other
     standbys. A standing-in standby sends its own notifications itself.
   - **The hub's switch is not the spoke's.** A spoke that ticked Push uses the
     hub even when its own Notifications setting is off, and reports delivery
     available. If the hub cannot or will not forward, it sends to the gateway
     itself only when its own setting is on; otherwise the delivery is not sent,
     as a failure categorized `hub-unreachable` (retryable) or `hub-refused`
     (retryable only for a busy hub or a gateway it could not reach). A gateway
     that answered is relayed as data and is never followed by a second send.
   - **Bounds.** A hand-off body is at most 16 KiB and must decode as a delivery
     request (a capability and one sealed envelope); the hub reads no field of the
     envelope. One spoke may ask 60 times a minute, counted in memory.
   - **What the hub keeps.** Counts of forwards and refusals per spoke and the
     last result, which a switch-off forgets. The journal records the spoke, the
     size, and a reason word; rate-limit refusals once a minute per spoke. A
     standing-in standby journals and keeps no counts.
   - **The window bridge.** The desktop's allow-list of hub operations gained
     `push`, decoded against its contract before it is forwarded.
   - **Direct sending is the hub's own gateway.** A hub whose person turned on
     Send notifications directly serves the gateway's two routes
     (`/v1/capabilities`, `/v1/deliveries`) on its private listener, with the
     rules, bounds, and status codes of Mobile maturity's Gateway rules, and
     sends to Apple and Google itself with credentials the person stored. The
     switch is a second one on the hub, off by default, window only, and it
     needs the hub role on. A forward then goes to the hub's own gateway in
     the same process, not over the network, and the Notifications setting, which
     names a gateway to contact, is not consulted: a hub that sends directly
     contacts no gateway. A request that names another gateway is answered by
     the hub's own, which refuses a capability it did not issue (`421`, reported
     to the spoke as `gateway-mismatch`).
   - **Only a hub sends directly.** A standing-in standby holds no credentials and
     forwards to its configured gateway as before. Turning off the hub role turns
     direct sending off. Removing a platform's credential leaves the sealing key,
     so capabilities already given to phones keep opening; the platform answers
     `503 unavailable` until a credential is stored again.
   - **Credentials stay out of the journal.** The Apple `.p8` key with its key ID,
     team ID, and bundle ID, the Google service account (reduced to its client
     email, project, and signing key), and the key that seals capabilities live in
     a credential namespace of their own. They are never journaled, logged, or
     returned: status says `stored` or `not-stored`, and the journal records the
     platform that changed. Only the loopback window route changes any of this
     (`/api/desktop/hub/direct-push` and its environment and credential routes); a
     peer, guest, device, agent, or routine cannot. No command-line switch exists.
   - **The Apple environment is the person's word.** Production or development,
     picked in Settings; the sandbox host is used only for development.
   - **Not built.** Any delivery to a real phone, with either path: a maintainer
     check that needs a phone app built with the person's own accounts.

10. **Provisioning.** Update-feed mirror, catalog offers, profiles, and routine
    offers as proposals, with per-kind auto-apply per H5. Acceptance: nothing
    offered installs trusted, enables, or carries a secret. **Yes.**

    Built, with these narrower readings:
    - **Offers are data with closed fields.** An offer is one of five strict
      shapes. An endpoint row has no key field and takes an https address with no
      user, password, query, or fragment; no free-text field may look like a
      credential. Anything else fails the schema, on the hub when it is made and on
      the spoke when it arrives.
    - **Hub switch, window only.** Offers are the hub's own switch, off by default
      (`octant hub provision on|off`, Settings › Hub). Turning it off forgets the
      offers and stops serving any mirror. Only a window on the hub makes or
      withdraws an offer. A spoke whose person did not tick Provision refuses with
      `provision-not-granted` and the hub keeps only that word.
    - **Only the hub offers.** A spoke accepts an offer only from the key it joined
      the hub with. A standing-in standby sends none: offers are not copied to a
      standby, so the "or a standing-in standby" case of the grant is not
      expressed, and a peer, a guest, or a stranger is refused as not the hub.
    - **The spoke refuses what it cannot apply.** A kind with no service behind it
      on that host is refused on arrival (`kind-unsupported`). Proposals lapse after
      a week and a spoke holds at most 32; unticking Provision drops them.
    - **Applying is the window's, or an owner device's after an unlock.** Apply and
      Dismiss are loopback administration routes, so a remote device, the hub, and
      a peer never apply. An owner device on this spoke's owner list does, with a
      fresh unlock or an open administration session, through the same apply path
      and journaled with `owner-unlock` as the principal; it has no Settings row
      or phone screen yet. Each kind goes through the service a
      person would use: the plugin service's inspect then install (nothing trusts
      or enables it), the profile service, the provider service (the row is made
      switched off, with authentication that wants a key the person adds), and the
      shell settings for the release channel. Applying a plugin checks the digest
      the offer named against the catalog's.
    - **Narrower than the grant text.** A profile that asks for Full access or a
      remembered permission is refused, because only a person on the spoke chooses
      those. The candidate channel is followed on an offer only by a spoke already
      on it. The update-feed mirror's signature is checked with the release public
      keys; a host with none refuses a mirrored offer. The server reads them from
      `@octant/host-runtime`, the same check the desktop updater runs, so a headless
      hub verifies a mirrored feed too, and a feed whose signature fails is refused.
      The desktop keeps its own copy of the key literals because the release
      tooling rewrites them there; a desktop test requires the two lists to agree.
      The verified feed is kept as the document the hub served; the desktop updater
      does not read it.
    - **Endpoint rows ask (the H5 reading).** H5 lists three kinds that may apply
      on arrival: an update channel, an untrusted plugin install, and a profile
      without secrets. An endpoint row is not among them, so it always asks, as a
      routine does; the request that sets applying on arrival names only the three.
    - **A routine needs a Project.** A routine offer names no Project, host,
      profile, or authority. The person binds it to a Project when applying it
      (`octant hub apply <id> --project <id>`; Settings points to that). The server
      builds the definition itself and creates it through the Automation command
      service a window uses. It reads narrowly: only an active Work Project binds
      (a Code routine needs a checkout only a window prepares, so it is refused as
      `kind-unsupported`); the profile is the first approval-gated one compatible
      with Work, and the model is Work's own default, so a host with neither refuses
      (`apply-failed`) rather than widen anything; authority is Work's, with no
      shell or Git; and the routine is journaled paused from its first event (one create
      command with a paused initial state, never a create then a pause), so it runs
      only after the person resumes it in Automation Center. It is recorded under the host's own
      scope, never the hub's. The receipt derivations repeat the editor's.
    - **Journal.** Offers made and withdrawn, proposals received, applied (the
      principal and whether a person or the standing choice did it), dismissed, and
      refused, each with a reason word and never an offer's text. Applying on arrival
      is journaled with the window as principal and `auto` as the mode.
    - **Window bridge and Settings.** The desktop's allow-list of hub operations
      gained the six provisioning operations, each decoded against its contract.
      Settings makes only stable and preview channel offers; the other kinds are
      offered with `octant hub offer`.

**Hub-started sign-in** closes the gap [decision H6](#decisions) left. It is not
a numbered slice. Built, with these narrower readings:

- **The sign-in runs outside Octant.** A host has no server-run Claude or Codex
  login today; Settings shows the provider's own command and the person runs it
  in a terminal. So accepting shows that command on the spoke, built as
  Provider Settings builds it from the first enabled row for the kind: that
  row's binary and, for an isolated account, its account directory. The spoke
  records it when the request arrives. It reads only whether the provider's own
  app is now signed in (the same probe as Check the connection), and only a
  subscription account counts: a ready Codex on an API key or with no OpenAI
  login is signed-out, and a probe that names no account kind is unavailable.
  It never runs a login and never reads a token. Because
  of that, a request is ended by the person choosing **Check sign-in** (or by
  the ten minutes passing), not by the server watching the terminal.
- **Closed kinds.** A request names `claude-subscription` or `codex-subscription`
  and nothing else; the delivery reads the kind as text, so a spoke refuses an
  unknown one by name (`unknown-kind`). A spoke with no enabled provider row for
  the kind refuses the same way, and a Claude API-key row never counts as a
  subscription sign-in.
- **The requester is the hub's key.** A spoke can verify only the hub that
  relayed a request, not the window or owner device behind it, so the hourly
  limit counts requests from the hub's key. Refusals after the grant check count
  toward it, so asking cannot be used to probe whether an account is signed in.
  Admission is checked again after the provider is read, with no wait before the
  save, so requests that arrive together cannot both pass. A full list (eight)
  refuses the new request as `rate-limited`; an open request is never dropped.
- **The ten minutes cover the whole request.** A request lapses ten minutes after
  it arrives, accepted or not, and the spoke reports `expired`. Lapses are
  settled by a thirty-second tick and whenever the spoke's Settings is read; an
  outcome word the hub could not take is kept and sent again on the next tick.
- **A sibling of the alert list, not a new-member alert.** The existing alerts
  are about new members and offer Remove, Confirm, and Dismiss. A sign-in request
  has its own list in the same Settings view, with Accept and Decline, and its own
  owner-device routes (list, accept, decline, check). An owner device acts on a
  spoke only after an administration unlock, and the hub itself is refused there.
- **No phone screen, no `octant hub` command, no notification yet.** The hub's
  window and owner-device routes can ask, and Settings shows the request on the
  spoke, but the phone app has no screen for it, the CLI has no command, and no
  system notification is raised.
- **What is journaled.** On the hub: the request, a refusal's reason word, and
  the outcome word received. On the spoke: the request, a refusal, the decision,
  and how it ended with the outcome word. Only the request id, the kind, and the
  words are written; the schema has no field for a token, a code, an address, or
  an account name.

11. **Messaging between members.** The Reachable tag and its event, the
    Message peer-grant item (in the full-member grant, and a Message-only
    grant for the hub), remote references, `list` with a `member`, the
    threads, messages, receipts, and withdraw member routes, sending with retry and
    the 24-hour deadline, delivery on the receiver, waking an idle thread,
    and receipts back.
    Acceptance: an untagged thread is never listed and refuses a message in
    the same words as an unknown one; a sender thread without the tag cannot
    send to a member; a member without Message gets an empty list and
    `unauthorized`; a message sent while the receiver is down arrives once
    after it returns and expires after 24 hours; a message to an idle thread
    with the wake switch on starts one `agent`-initiated turn, a busy or
    waiting thread is not interrupted, and the hourly and hop bounds stop a
    reply loop after three rounds; nothing that arrives reaches an approval on
    the receiver; untagging or revoking refuses
    waiting messages; closing or untagging the sender withdraws what B still
    holds; a Claude thread on one host and a Codex thread on another
    exchange a message and a reply. Verification: server tests and a
    three-host loopback smoke with fake providers; a run between two real
    computers and real providers is a maintainer gate. **Linux container:
    yes, except that gate.**
12. **Moving a thread to another member.** The Move in peer-grant item, the
    own-unlock challenge for a move, the offer, chunk, finish, commit, and
    cancel member routes, the freeze, arriving, committed, and moved-out
    events, the source erase and its tombstone, recovery on both ends, Prepare
    to shut down, the handover (note, commit, push, notice, continued report,
    and Continue handover), and the screens: Environment's Computer card, the
    move and handover sheets, the frozen bar, the tombstone, the Arriving
    pill, and This thread can't move.
    Acceptance: a move without an own fresh unlock, or to a member without
    Move in or with Owners unticked, is refused before any part is sent; at no
    point can both copies start a turn unless the person chose Take back here
    or Activate anyway; a transfer cut at any chunk resumes and arrives once; a
    lost commit answer neither duplicates nor loses the thread; the source
    erases only after `committed`, and its tombstone opens the destination; a
    Code thread arrives with its branch, its commits, its staged and unstaged
    versions of a file edited both ways, and its uncommitted and
    untracked work identical to the source, and with no ignored file; a file
    the Secret guard refuses stays behind and is listed, and the source keeps
    a worktree that still holds a refused or ignored file; no credential,
    provider session, grant, or Full access arrives; a Code thread whose
    destination lacks its repository falls back to a handover whose commit
    holds every change and whose message is the note; a handover never forces
    a push or pushes to the default branch; continuing a handover marks the
    thread with outside content and erases the frozen source; every move that
    cannot finish journals `thread.move-failed@1` with one listed reason,
    unfreezes the thread, and shows This thread can't move in the move sheet,
    on the thread, and in Prepare to shut down, which then never says Safe to
    shut down; no header menu, row menu, or palette entry starts a move;
    Prepare to shut down moves nothing before the person presses its primary
    action, starts each row on the choice above, never preselects a handover
    or Stop and move, and needs one unlock per destination for the batch.
    Verification: the closest web component tests, rendered QA of each screen
    state at a wide window and at 390px,
    contract and domain tests, server tests, and a two-host loopback smoke with
    fake providers covering a large worktree and a cut transfer; a move between
    two real computers with a real Touch ID unlock before a real shutdown is a
    maintainer gate. **Linux container: yes, except that gate.**

    Slice 12 lands in parts. The first part is the contracts (the move offer,
    manifest, answers and destination state, the handover notice, the move
    events, the failure reasons, and the Move in item on the peer grant, in
    the full-member grant for new members) and the pure policy (eligibility,
    the destination's Move in check, Prepare to shut down's starting choices
    and destination, recovery, Activate anyway, keeping a worktree that holds
    unmoved files, and the handover branch). A grant stored before Move in
    existed read as off until the fifth part, which reads it as described
    under [Every move is an owner act](#moving-a-thread-to-another-member).

    The second part is the move itself for Chat threads between spokes: the
    owner route that issues the one-use ticket (own-class unlock, every
    time), the six member routes (`/api/hub/peer/thread-moves` for the offer,
    and `chunk`, `finish`, `commit`, `status`, and `discard` under it, each
    `POST` with the move id in the body), the move state each host keeps so a
    restart resumes, the freeze as a hold every Chat command checks, the
    Chat conversation carried as real turns the way a branch carries them,
    the erase through the ordinary purge, the journal events, and recovery at
    startup. A two-host loopback smoke moves a thread with a real owner
    unlock.

    The third part moves Code threads between spokes: the Git bundle with
    the index and working-tree snapshot commits under a move ref, fetched
    into a destination clone whose remote names the same repository (a
    local path or `file://` remote by its path), the managed thread started
    from them under the host's own scope, the moved transcript as a
    per-thread history its first turn carries once, the freeze on Code
    commands and turn starts, the provider of the same kind, and the
    erase-time check that moves a worktree out of the managed folder when it
    holds anything the move did not carry.

    The fourth part moves Work threads between spokes: the conversation as
    a moved transcript into a Work Project the person picks on the
    destination (the folder's files stay where they are), the thread opened
    under the host's own scope on a provider of the same kind, the freeze
    on Work commands and turn admission, and a delegated Work thread read
    as one that cannot move. What it does not do yet: accept moves on the
    hub (which keeps no peer grants and needs its own Accept moved threads
    setting), offer a window route to start a move, or show any screen.

    The fifth part lets a person start a move from the thread's Environment.
    The window route, under `/api/desktop/hub/thread-moves/`, is
    loopback-only behind the desktop secret and a window capability, and
    acts only on a thread the window shows. It lists the member computers
    and their Projects (through the new `projects` member route), fetches
    the destination's owner challenge for this Mac's Touch ID, redeems the
    signature for the ticket and starts the move now or after the running
    turn, and reads where the thread stands: sending with its progress,
    waiting for its turn, arriving with Activate anyway after five minutes
    of silence, its This thread can't move notice until dismissed, and the
    "Moved to" record with any kept worktree. Cancel, Take back here, and
    Activate anyway go through it too. The notices and the last 500 records
    are kept beside the move state, so a restart keeps them, and a move
    refused before anything froze (the unlock declined or expired, the
    destination unreachable, a busy or delegated thread) journals its
    reason the same way. The desktop forwards each as a hub administration
    operation. Environment's Computer card lists the computers with their
    pills, picks the one fitting Project, opens the move sheet (what moves,
    what stays, the erase sentence, Move with Touch ID, or Move after this
    turn for a busy thread), and shows the progress line with Cancel move,
    Take back here, the This thread can't move notice with Choose another
    computer and Dismiss, the Arriving notice with Activate anyway, and the
    Moved notice. What it does not do yet: replace the composer with the
    frozen bar (the held thread still refuses every command with the
    moving reason), the pane tombstone with Open there and Remove worktree,
    sizes and an estimate in the sheet, Stop and move, Hand over instead,
    an unlock other than this Mac's Touch ID, accept moves on the hub, or
    Prepare to shut down.

    The sixth part lets the hub take moved threads: its Accept moved
    threads setting (on by default, a window on the hub only, journaled),
    the hub checking a move's sender against the key that member joined
    with, the hub's own owner list for the unlock, and the hub listed in the
    Computer card like any member. What it does not do yet: Prepare to shut
    down.

    The seventh part is Prepare to shut down. The window route lists every
    thread on this host with its last journaled activity: a busy one (a turn
    runs or it waits on the person), an open one active in the last 14
    days, and older open threads folded closed. It asks each member once per
    mode and repository which Projects fit. The dialog starts on the
    destination the domain policy picks, puts each row on its starting
    choice, re-reads untouched rows when the destination changes, and moves
    every chosen row with one Touch ID through the batch ticket. One unlock
    moves at most 64 threads, because the batch's thread list rides inside
    the destination's owner challenge, whose body the owner routes cap at
    16 KiB. When more are set to move, the dialog says so before the press,
    counts the rest as staying here, and offers to move them next with one
    more Touch ID. It then follows each row to Moved or Can't move and ends
    on Safe to shut down, or on how many threads stay here. A row the
    person sets themselves keeps its choice through destination changes.
    Each thread's status says when the last move or wait a window started
    for it ended, never dismissed and kept until it starts another move, so
    a row that ended without moving (Don't move pressed, or its failure
    notice already put away) counts as staying rather than waiting forever.
    Hiding the dialog leaves its batch moving, and opening it again shows
    that batch. **Prepare to Shut Down…** sits in the application menu above
    Quit. The quit confirmation gains **Move threads
    first…** while the window last saw this host in a hub with another
    member, and the dialog then ends with Quit Octant through the guarded
    quit. What it does not do yet: Hand over and Stop and move as row
    choices, a row moving to a member other than the head's, sizes and an
    estimate, the menu bar entry and progress, and more than one
    destination's unlock in turn.

    The eighth part is the handover's source side. **Hand over instead**, in
    the move sheet and in This thread can't move for a Code thread, opens
    the handover sheet with the branch, the remote, and a preview of the
    note. A thread a move or another handover holds, or one another window
    is handing over at that moment, is refused as busy. The thread is frozen
    before the plan reads whether a turn runs, so no turn starts while the
    checkout is inspected, and Take back here is refused while its handover
    is still committing or pushing. **Commit and push** (or **Commit**,
    without a remote) then journals the freeze, freezes the thread, and
    saves it as held (handed over, not pushed) before anything is committed
    or pushed, so a stop midway restarts with the thread still held until
    Take back here. The commit is built from a throwaway index, so the
    checkout is never switched: it lands on the thread's branch (the index
    follows; the files stay as they are), or on a new `octant/handover/…`
    branch for the default branch or a detached head, taking the next free
    name when an earlier handover's branch is still there. The default
    branch is the one the push remote names, not origin's. The commit takes
    every change Git does not ignore except files the Secret guard refuses,
    and its message is the note with the `Octant-Handover` and
    `Octant-Origin` trailers; a branch that already holds the work and has
    nothing left to commit still gets a commit carrying the note, because
    the destination reads the note only from a tip naming this handover. The
    branch is then pushed to the remote the preview named (the one the
    checkout's branch tracks, or `origin`), never worked out again for a new
    handover branch, never forced, and never to the default branch. The note
    comes from the thread's title, its latest instruction and answer, the
    changed files, and what stays behind. It is redacted, names no folder on
    this computer, and is at most 32 KiB. The thread stays frozen, marked
    Handed over with the branch and whether it was pushed (`push-failed` and
    `no-remote` say the work is on no other computer yet), held across a
    restart, until **Take back here**. While it is held, no move of the
    thread can start: the move service refuses any frozen thread as busy
    before touching it, and the Computer card offers no destination. What it
    does not do yet: the agent's own summary turn, the notice to a chosen
    destination, Handovers on the destination's start screen, Continue
    handover, and the erase once a destination continues it.

    The ninth part is the handover's destination side. A handover started
    with a chosen member sends it a signed notice (`POST
/api/hub/peer/handovers`, any member), carrying the remote, the branch,
    and the provider kind and model, which the destination keeps for its
    **Handovers** start-screen card. **Continue handover** there picks the
    one Code Project bound to the same repository (or offers the ones that
    are). It fetches the branch with the destination's own Git identity,
    through whichever remote the clone names that repository by (the notice
    names the push URL, which a separate `pushurl` makes different from the
    fetch URL), reads the note only from a tip whose `Octant-Handover`
    trailer names this handover, and opens a managed Code thread started
    from that very commit, named by its id so a later push to the branch
    cannot change where it starts, on the destination's own provider of that
    kind with the same model. When the clone already has a local branch of
    that name, the thread's own branch takes a `-handover-` suffix, as a
    moved thread's does. The thread starts marked under the source label
    `handover-note`, and its first turn reads the note framed as outside
    content. The destination then reports (`POST
/api/hub/peer/handovers/continued`, the handover and the new thread in
    the body). Continue handover makes one thread per handover: a second
    press, from any window, gets the first one's answer. The source erases
    its frozen copy the way a moved thread is erased, claiming the thread
    first so Take back here is refused until the erase ends, keeping a
    worktree that holds anything the handover did not carry, and records
    "Moved to" for old links. The destination keeps the continued report and
    sends it again at startup and every minute until the source answers that
    it erased its copy or no longer holds the handover, so a source that was
    offline still lets its frozen copy go. A branch found by fetching
    without a notice is offered too, after the clone's next fetch, as the
    handover rules above describe; the continued report names the commit
    continued, and the source erases only for its own. What it does not do
    yet: the agent's own summary turn.

    A further part carries each thread's bulk parts with every move, in all
    three modes, as described under **What moves**. The source packs a Chat
    thread's sent and unsent attachments and the inputs its turns admitted
    from another Chat thread, and in every mode the thread's completed
    generated images, its retained Browser captures (oldest first, so the
    newest stay newest), and every version of each Canvas whose provenance
    names it. Each becomes a manifest part beside the conversation, which
    lists them, and crosses the existing chunked transfer. A part it cannot
    read, or whose bytes no longer match the digest a turn admitted, is kept
    on the sent move and named on the "Moved to" record and its notice. The
    destination opens a Chat thread with each attachment on its turn in the
    same journal unit, then records the images, captures, and Canvases under
    ids derived from the move and the part, so a finish asked again records
    each once; a part it cannot record answers `transfer-failed`. The move
    sheet lists these parts under What moves, without their sizes yet.

Any slice that would deploy an Octant-operated service, create an account, or
spend money stops for a separate maintainer action.

## Verification

This change is design only; the format, path, and decision-archive checks cover
it. The invariants every slice must keep testable: the spoke is the only
authority over its threads; the hub principal is refused outside its grant;
no approval, credential, or sandbox change can come from the hub, a standby,
or a peer; owner powers need a fresh unlock and never reach an agent or
routine; results from another spoke are data; a moved thread takes turns on one host at
a time unless the person chooses otherwise, needs an owner's own fresh unlock,
and leaves the source only after the destination commits; joining happens only
over a private network; the hub runs and serves the web app with no desktop window; and every hub service is off until the person turns it on.
