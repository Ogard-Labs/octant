# 0040. Collaboration: share a host or a git remote

**Status:** Proposed

## Context

Octant is used by one person on one Mac, and by small teams who need to share
work without giving a vendor their data. An Octant account, a hosted relay, or
hosts that trust each other would each create a cloud Octant does not operate,
a processor it is not, and a trust surface 0013 already refused. The current
release boundary forbids hosted relay; this record does not open that door. The
audience is prosumers and small teams, under GDPR: sharing stays on
infrastructure they control, in a region they choose, with a named controller
when more than one person is on the same store.

The pieces already exist. 0028 and 0029 made a journal-derived bundle the unit
that can leave a host, and recorded import, foreign provenance, and conflict
shape as open questions. 0013 paired devices as distinct principals onto one
host, kept approvals single-winner, and forbade hosts from trusting each
other. 0002 journals every mutation with a structured actor. This record
answers those open questions. It does not rewrite the accepted records that
asked them.

## Decision

People share a host they control, or a git remote they control. They never
share by teaching two hosts to trust each other. There is no Octant account,
no Octant-operated store, and no relay.

Three layers, independently shippable, cheapest first. A later layer is not a
prerequisite of an earlier one. None of them changes 0003's modes or 0009's
confinement.

### 1. Git-mediated async sharing

- The 0029 export bundle is the share format. Plans (0027) and templates
  travel as the same kind of bundle: identity beside definition, diff-friendly.
  A template is a journaled reusable document someone originated. Curated
  scaffolds (0024) are not templates, and a thread bundle (0036) is not this
  layer.
- **Secret boundary.** Before a bundle is written for share or accepted on
  import, the host refuses or redacts credentials, secret-shaped values, and
  absolute filesystem paths in free-form text (titles, rationales, block
  content, claimed provenance). Schema fields that accept arbitrary text are
  not a boundary. A bundle that still contains them is refused.
- **Git transport stays outside Octant.** Two Octants pointed at one user- or
  team-owned git remote exchange bundles because the user commits, pushes, and
  pulls with their own git. Octant never pushes, at any setting (0029).
  Auto-push stays off. The first implementation is the mirrored files the user
  already commits. An Octant-operated push would have to supersede 0029 first;
  this record does not.
- Import is a journaled command on this host. This host's journal remains the
  source of truth. It never adopts the other host's journal, never merges two
  documents into one aggregate, and never grants the origin's filesystem,
  shell, or Project authority.
- **Bind to a compatible thread, not merely a Project.** A first import of a
  foreign origin identity selects or creates a compatible thread in a Project
  the importer already has, then creates the local counterpart on that thread
  (0028 originating thread; 0027 one plan per thread). A later import of that
  same origin appends a version. A plan import targeting a thread that already
  has a live plan is refused unless the importer explicitly applies it as a
  new proposed revision of that plan. A bundle that names an artifact this
  host already originated, or a different artifact than the counterpart it is
  being applied to, is refused (0029).
- **Imported plans start proposed.** The share format does not carry plan
  `status` or `approvedRevisionId`. Source-side approval does not travel.
  Ordinary local approval naming the exact imported revision is required
  before its steps can run (0027).
- **Imported bundles are untrusted external content (0009).** Every foreign
  import enters through the existing external-content ingestion: provenance-
  tagged as untrusted data, framed as data in context, and tainting the
  receiving thread for its lifetime so irreversible approval classes require
  fresh confirmation. Claimed origin (host, identity, sequence, display name)
  is recorded and is not a verified identity; this layer has none.

### 2. Shared team host

- A team runs one headless host on infrastructure it controls. Teammates
  pair as distinct principals with their own device keys (0013 pairing). The
  current single-user host is the degenerate case: one principal, the host
  owner, whose local windows and paired devices all belong to them.
- **Headless owner bootstrap.** Pairing cannot assume a GUI owner is present.
  0013 still requires equivalently authenticated local confirmation to enable
  the listener and host-side approval to pair, with the same facts (address,
  port, origin, certificate identity, exposure class). On a headless host
  those gestures happen through the local-control channel the CLI already
  uses (loopback full API; never the remote listener; never a browser
  origin). The first owner enrolls there before any teammate can pair. This
  layer does not ship until that channel exists; it does not weaken 0013.
- Identity is a principal: one or more device keys plus a display name
  (0019, 0033). Display names authenticate nothing. Org SSO arrives later as
  a plugin (0001 integration), never a core dependency: it may assert a name
  or group to a host that already admitted the principal; it cannot mint
  authority, cannot be required to pair, and pairing still uses device keys.
- **Device-to-principal enrollment is authenticated and journaled.** Binding
  a device key to a principal is a server-side assignment: owner-side
  assignment, or proof from an already-enrolled device of that principal. A
  client-selected display name cannot attach a device to the owner or to
  another teammate, and a colliding display name creates nothing.
- **Principal-to-Project grants exist before roles.** Every Project and
  thread is granted to named principals, or to none. The server enforces
  those grants before every read, approval, and side effect. An ungranted
  Project or its artifacts are absent, not shown as unavailable. Roles are
  host-local, journaled, and fail-closed; they only further clamp granted
  0003 actions and cannot express membership by themselves. They cannot
  grant Chat filesystem, skip Plan-mode read-only, or remember Full access
  for a Project the principal does not own. Missing or unknown grants or
  roles admit nothing. Local-host-required actions in 0013 stay with the
  host owner unless a later record names a subset to delegate.
- Approvals stay single-winner on the host (0013). Concurrent answers race;
  the first committed decision wins; there is no vote.
- The host is the data boundary. Team data lives in that host's journal. A
  disconnected client is stale and read-only. Revoking a principal drops its
  sessions and streams before the response completes.
- **Credential bytes on the server are not a use grant.** Credentials stay
  in that host's OS secret store and are never sent to a teammate's device.
  Invoking a provider consumes a credential only when the acting principal
  holds a server-enforced use grant for it. Another principal on the same
  host cannot use those bytes by sharing a thread or a provider instance.
- Journaled mutations with a principal-bearing actor are the audit log.
  **GDPR controllership is recorded independently of host ownership.** The
  named controller is a journaled fact, not derived from who owns or
  administers the machine. Controller/processor and joint-controller
  relationships are representable. Teammates are distinct data subjects.
  Per-principal export, and controller-confirmed erasure of that principal's
  bulk content with a tombstone that the removal happened, are required
  before this layer ships as a product. Legal documents belong to the
  compliance package; this record does not certify them.

### 3. Live co-presence

- Last, and only on demand evidence.
- Presence is opt-in per person per host. Disconnected is absent, not
  stale-present. Seeing someone grants no authority. Fine-grained real-time
  editing and CRDTs are not this layer. Presence is personal data on the
  shared host; it does not travel in layer-1 bundles.
- **Presence is not journaled.** Connection and presence changes must not
  enter the append-only 0002 journal: projecting a disconnected person as
  absent would not remove their historical presence, and 0035's erasure
  covers bulk content, not these events. Presence lives in a **host-scoped
  ephemeral aggregate** keyed by host, not by space or window, with bounded
  retention; disconnect deletes membership rather than appending history.
  That aggregate is the single authoritative membership for every client of
  the host.

## Consequences

- Collaboration work that needs an Octant account, a relay, host-to-host
  trust, or a core identity provider is out of shape even while this record
  is Proposed.
- Layer 1 is cheap because it adds no trust surface: the git remote is
  already the user's, and Octant does not push. The cost is honest
  provenance without verified authors, sequential versions instead of a
  merged document, and a refusal/redaction pass before any bundle leaves.
- Layer 2 is the real unlock for a small team and the GDPR one: one store,
  many principals, recorded grants, and a named controller. Actor envelopes
  that today distinguish `local-user` from `remote-device` will need a
  principal those devices belong to, or two teammates remain
  indistinguishable in the audit log.
- Layer 3 waits. Building presence before a shared host would put
  co-presence on a single-user product that does not need it. Thread-bundle
  import remains undefined (0036): whole-thread sharing carries
  authority-adjacent content and needs its own design.

## Related

- 0001 Plugin architecture
- 0002 Durable event journal and rebuildable projections
- 0003 Product modes and authority
- 0009 Sandbox confinement, approvals, and Plan mode
- 0013 Remote access: single host, paired devices, and mobile
- 0027 Plans as journaled artifacts
- 0028 The artifact library
- 0029 The artifact storage mirror
- 0031 Hosts as environments
- 0035 Thread retention and explicit purge
- 0036 Thread export
