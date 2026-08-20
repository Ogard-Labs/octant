# 0038. Collaboration: share a host or a git remote

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
that can leave a host. 0013 paired devices as distinct principals onto one
host, kept approvals single-winner, and forbade hosts from trusting each
other. 0002 journals every mutation with a structured actor. What is missing
is the sequence, the identity model, and the data boundary for a team.

## Decision

People share a host they control, or a git remote they control. They never
share by teaching two hosts to trust each other. There is no Octant account,
no Octant-operated store, and no relay.

Three layers, independently shippable, cheapest first. A later layer is not a
prerequisite of an earlier one. None of them changes 0003's modes or 0009's
confinement.

### 1. Git-mediated async sharing

- The 0029 export bundle is the share format. Plans (0027) and templates
  travel as the same kind of bundle: identity beside definition, diff-friendly,
  secrets and paths unrepresentable. A template is a journaled reusable
  document someone originated. Curated scaffolds (0024) are not templates, and
  a thread bundle (0036) is not this layer.
- Two Octants pointed at one user- or team-owned git remote exchange bundles.
  The remote is a destination the user already owns; Octant never invents it
  and never becomes it. Push and pull happen on explicit instruction.
  Auto-push stays off (0029). The first implementation may be the mirrored
  files the user already commits with their own git.
- Import is a journaled command on this host. A first import of a foreign
  origin identity creates a local counterpart in a Project the importer
  already has; a later import of that same origin appends a version. This
  host's journal remains the source of truth. It never adopts the other
  host's journal, never merges two documents into one aggregate, and never
  grants the origin's filesystem, shell, or Project authority. Provenance
  records what the bundle claimed (origin host, identity, sequence, display
  name). It is not a verified identity; this layer has none. A bundle that
  names an artifact this host already originated, or a different artifact
  than the counterpart it is being applied to, is refused (0029).

### 2. Shared team host

- A team runs one headless host on infrastructure it controls. Teammates
  pair as distinct principals with their own device keys (0013 pairing). The
  current single-user host is the degenerate case: one principal, the host
  owner, whose local windows and paired devices all belong to them.
- Identity is a principal: one or more device keys plus a display name
  (0019, 0033). Display names authenticate nothing. Org SSO arrives later as
  a plugin (0001 integration), never a core dependency: it may assert a name
  or group to a host that already admitted the principal; it cannot mint
  authority, cannot be required to pair, and pairing still uses device keys.
- Authority clamps become roles. Roles are host-local, journaled, and
  fail-closed. They only further clamp 0003; they cannot grant Chat
  filesystem, skip Plan-mode read-only, or remember Full access for a
  Project they do not own. Missing or unknown roles admit nothing.
  Local-host-required actions in 0013 stay with the host owner unless a
  later record names a subset to delegate.
- Approvals stay single-winner on the host (0013). Concurrent answers race;
  the first committed decision wins; there is no vote.
- The host is the data boundary. Team data lives in that host's journal.
  Credentials stay in that host's OS secret store and are never sent to a
  teammate's device. A disconnected client is stale and read-only. Revoking
  a principal drops its sessions and streams before the response completes.
- Journaled mutations with a principal-bearing actor are the audit log. On a
  shared host the host owner is the GDPR controller. Teammates are distinct
  data subjects. Per-principal export, and owner-confirmed erasure of that
  principal's bulk content with a tombstone that the removal happened, are
  required before this layer ships as a product. Legal documents belong to
  the compliance package; this record does not certify them.

### 3. Live co-presence

- Last, and only on demand evidence. The Zen aggregate is already versioned,
  event-sourced, and optimistically concurrent, so presence can be events on
  an existing aggregate rather than a new store.
- Presence is opt-in per person per host. Disconnected is absent, not
  stale-present. Seeing someone grants no authority. Fine-grained real-time
  editing and CRDTs are not this layer. Presence is personal data on the
  shared host; it does not travel in layer-1 bundles.

## Consequences

- Collaboration work that needs an Octant account, a relay, host-to-host
  trust, or a core identity provider is out of shape even while this record
  is Proposed.
- Layer 1 is cheap because it adds no trust surface: the git remote is
  already the user's. The cost is honest provenance without verified authors,
  and sequential versions instead of a merged document.
- Layer 2 is the real unlock for a small team and the GDPR one: one store,
  one controller, many principals. Actor envelopes that today distinguish
  `local-user` from `remote-device` will need a principal those devices
  belong to, or two teammates remain indistinguishable in the audit log.
- Layer 3 waits. Building presence before a shared host would put
  co-presence on a single-user product that does not need it. Thread-bundle
  import remains undefined (0036): whole-thread sharing carries
  authority-adjacent content and needs its own design.

## Related

- 0001 Plugin architecture
- 0002 Durable event journal and rebuildable projections
- 0003 Product modes and authority
- 0013 Remote access: single host, paired devices, and mobile
- 0028 The artifact library
- 0029 The artifact storage mirror
- 0031 Hosts as environments
