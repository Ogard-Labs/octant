# 0163. Artifact replicas in storage the user owns

**Status:** Accepted

## Context

0029 kept the journal as the only source of truth and the mirror as a one-way
copy. A synced folder was how an artifact reached another computer, and only
because the person synced that folder themselves. 0029 left open a store the
user owns that Octant would write to and read from. 0040 layer 1 answered
sharing with a git remote the person pushes, and kept Octant from pushing.

Two computers revising one artifact need a rule that does not let a sync
client pick a winner, and does not stand up storage Octant operates. 0040
already refuses a hosted relay. This record is that rule. It extends 0029
and amends 0040 layer 1. It does not change what an artifact is.

## Decision

For a store the person explicitly set up for sync, Octant writes to it and
reads from it. The mirror and the export are unchanged, and still never push
to git. That is what changes from 0029: a synced mirror folder is no longer
the only way an artifact reaches another computer.

- **A replica is an append-only log in the user's store.** Each host writes
  only its own write-once entries, one per committed artifact version or
  deletion, named by host id and sequence. No file is written by two
  computers, so a sync client's conflict copies and lost updates cannot
  happen.
- **Each host's own journal stays the source of truth.** A pull imports other
  hosts' entries as appended versions with provenance: the computer's name,
  the host id, and the origin sequence. It never adopts another journal and
  never overwrites a version.
- **Concurrent edits keep both versions.** If two computers revise the same
  artifact from the same parent, the library shows both heads. The person
  picks one or merges them, which is a new version. Nothing is silently
  chosen.
- **Deletion is a tombstone entry.** Other computers hide the artifact and
  offer to undo. Each host's own erase and purge rules still apply locally.
- **Plain, readable files, signed.** Entries are readable JSON bundles in the
  0029 format, so they work across computers and with other tools. Each entry
  carries a detached signature from the writing host's device key. An entry
  from an unknown or revoked host, or one that fails verification, is refused
  and journaled. A new computer joins by writing a join request into the
  store; a computer that is already a member approves it by name. A short
  matching code shown on both screens guards against a stranger's request.
  Revoke writes a signed revocation. There is no replica key. The storage
  provider can read the content. Settings and the user guide say so plainly
  before sync is turned on. Opt-in encryption may come later — turned down
  for now, because readable files work across computers and tools.
- **The mirror and export stay separate.** The replica is an append-only
  history of versions. The existing mirror and export still write plain files
  for people and other tools. Sync is Octant to Octant. Mirror and export
  still never push to git.
- **Backup falls out of the model.** The store holds every version, so a new
  or wiped computer that joins restores the whole artifact library.
- **Plugin-shaped.** A replica-store contribution offers list, get, and
  put-if-absent. A folder store and an S3-compatible store ship in-tree on
  that seam. Direct cloud APIs, for a host with no desktop sync client, come
  later as plugins.
- **Authority.** Store setup, joining, and revoking happen on the host, never
  from a paired phone. Credentials live in the host credential store — macOS
  Keychain or freedesktop Secret Service. Plan mode, and a host with sync
  off, make no store calls. Every publish, pull, refusal, and failure is
  journaled. A failed upload never unwinds a local version.

Scope is artifacts and Canvases: versions and tombstones first. Canvas
comments are a follow-up. Whole-host backup — threads and settings — is out
of scope.

Turned down:

- **Shared mutable files.** A sync client makes conflict copies, and neither
  side knows what the other meant.
- **A hosted relay, or storage Octant operates.** The release boundary
  forbids it. The store is one the user already owns, or sync does not
  happen.
- **Encrypted replicas, for now.** Readable files work across computers and
  tools. Opt-in encryption is a possible later addition, not this rule.

## Consequences

- A person who turns sync on sends readable artifact versions to a provider
  that can read them. Saying so before the switch is the cost of files other
  tools can open.
- Two computers can both be right. The library shows both heads until the
  person chooses. That is slower than a silent pick, and it is the point.
- The mirror folder remains a copy for people and other tools. It is not the
  replica, and pointing a sync client at it is not this rule.
- A host with sync off, and Plan mode, never call the store. A failed upload
  is a journaled receipt, not a rolled-back version.
- This amends 0040 layer 1 only for that store. Git transport for the mirror
  and the export stays outside Octant. There is still no relay and no store
  Octant operates.

## Related

- 0029 The artifact storage mirror (extended: a store set up for sync is
  written and read; the mirror still never pushes to git)
- 0040 Collaboration: share a host or a git remote (amended: layer 1)
- 0002 Durable event journal and rebuildable projections
- 0013 Remote access: single host, paired devices, and mobile
- 0054 The credential broker is a host capability, not a desktop one
