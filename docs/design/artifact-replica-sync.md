# Artifact replica sync

This topic specification owns how artifact replicas are written, read, and
reconciled: the entry format, the store contract, membership derivation,
publish, pull, restore, comment sync, the synced library, binding, and store
selection. Architecture owns what a replica is and its boundaries
([Architecture: persistence](../architecture.md#persistence)) and the membership
and store-endpoint security rules
([Architecture: security and authority](../architecture.md#security-and-authority)).

## Entries

A store a person sets aside for sync holds one
write-once JSON entry per committed artifact version or deletion, at
`<instanceId>/<sequence>.json`, with a detached signature beside it at
`<instanceId>/<sequence>.sig`. The payload is the artifact bundle from
[0029](../decisions/0029-artifact-storage-mirror.md) (`octant.artifact-bundle/1`),
not a second document. Reconciling an artifact entry appends a version, keeps both
heads when two computers revise the same parent, or records a tombstone. It
cannot overwrite. An unknown or revoked instance, a bad or missing
signature, a content-hash mismatch, or an entry that names a local artifact
as foreign is refused. Artifact entries share each instance's sequence with
its membership records, and a writer skips a slot someone else's file
took, so a sequence has gaps by design: an artifact entry waits as
`sequence-gap` only while an earlier slot of its writer that the store
lists has no lasting verdict on this host - a membership record held, an
artifact entry applied or refused for its own content, or a file found not
to be a valid record. A slot the store does not list never holds it back.
An unknown entry format fails closed. A later version after a tombstone appends; the
tombstone stays in the history. A restore is the one exception to waiting
on a gap, and only for versions and tombstones: see artifact sync below.
A `canvas-comment` entry carries one change to a Canvas's comment
threads - a comment, a reply, a resolve, or a `tombstone` deleting a
comment and its replies - with the artifact origin, a content hash over
the canonical change, and `after`: for each other computer, the newest
comment entry on that Canvas its writer held when the change was made. A
comment carries its author, text, anchor, and time; the device it came
through stays on its computer. A comment entry waits as `sequence-gap`
until its writer's earlier listed slots are settled and every slot its
`after` names is applied or settled here, so each computer applies
comment changes in an order its writers saw. Its other rules are a
version's: signed, write-once, refused when its writer is not admitted,
its hash does not match, it names a local artifact as foreign, or its
text fails the share filter.
The detached signature covers an entry's encoded bytes whole - origin, kind,
parents, the claimed content hash, and the bundle - so a rewrite of any of
those is a different signature, not the same one the log recorded. The log
also carries membership records, in entry format `octant.replica-entry/2`:
every entry's origin carries its writer's public key, and an instance id is
derived from that key, so whether a record is valid depends on its own file
alone. Who counts as a member is described under artifact replica
membership below.

## Store

A replica-store contribution offers list, get, and
put-if-absent. put-if-absent returns already-exists and leaves the existing
bytes unchanged. The store's status is ready, not-connected, or refused. A
disabled or uninstalled store is not offered and is not called. The in-tree
folder store writes only under `<folder>/Octant Sync/`. A write lands in a
temporary file in that same directory, then an exclusive hard link onto the
key only when that key is absent, so a published key is never replaced or
half-written. A half-written temporary file is not an entry. A
file the sync client has not downloaded, and a conflict copy the sync client
left behind, are reported instead of being treated as entries. A folder
outside the user's home is refused unless the standing access-outside-project
approval exists — the same rule as the artifact mirror's global folder. Its
Test connection writes one empty probe under `Octant Sync/.octant-probe/`
through the same confined write-once path, deletes nothing, and `list` skips
that directory. The
in-tree S3-compatible store sends every request to the configured endpoint and
only while sync is on. Its settings are the endpoint URL, region, bucket,
optional key prefix, and path-style or virtual-host addressing. The access key
and secret live in the host credential store — macOS Keychain or freedesktop
Secret Service — in the bucket-key namespace described under replica store
selection, and are never journaled. A plaintext endpoint is refused and
no credential is sent on it. A publish uses a conditional create
(`If-None-Match: *`); a provider that does not enforce it is configured to
fall back to HEAD-then-PUT, where a key is already unique to one host's
instance and sequence so a lost race cannot overwrite another host's entry. A
failure is a typed outcome — unauthorized, not-found, throttled, unreachable;
a throttled or unreachable answer is retried a bounded number of times with
backoff, while a rejected credential or a missing object is not. A Test
connection action writes one probe object in a reserved key namespace and
deletes nothing; `list` skips that namespace. Publish and pull are not this
store; they call it.

## Membership, as wired today

Membership is a pure
function of two inputs: the founder this computer pinned, and the set of
valid membership records it holds. Two computers that hold the same records
derive the same members, keys, parents, and cuts, whatever order they read
them in.

- **Records.** Every record is a write-once file at
  `<instanceId>/<sequence>.json` with a detached Ed25519 signature beside it,
  and its origin names the writer's id, name, sequence, and public key. The
  instance id is the first 16 bytes of SHA-256 over the key's SPKI bytes,
  written as a UUIDv8. A record is valid when its body decodes, its origin is
  the path it is filed under, its id is its key's id, and the signature
  verifies under that key; an approval is valid only when its subject is
  its subject key's id. Nothing else is consulted, so every reader reaches
  the same verdict, a key once admitted cannot be replaced, and an old key
  is always the old identity. The kinds are `replica-founded` (the
  founder's sequence 1), `join-request` (a joiner's sequence 1, with the
  time it was written), `join-approved` (subject, key, and name),
  `join-accepted` (signed by the joiner, naming the one approval it
  accepted by writer, sequence, and SHA-256 of the approval file's bytes,
  and the founder it pinned), `revocation` (subject and cut, the last of
  the subject's sequences that still counts; 0 means none), and
  `replica-left` (signed by a member leaving, at a sequence after its first,
  naming the founder it pinned). Version 1 entries fail closed.
- **Derivation.** Two different records in one slot can only both be signed
  by the key holder, so a second one is evidence the key was stolen: that
  computer is capped just before the slot, and records at or after it do
  not count. Each computer's parent comes from its own lowest-sequence
  `join-accepted`, and only when the approval it names is held, approves
  that computer, and is not past such a cap. The parents form a tree from
  the founder; nothing reaches a computer that is not in it. Standing is
  then weighed top-down in one pass: a computer is admitted when its parent
  is admitted and signed the approval at or before the parent's cut, and
  its cut is the lowest cut named by a revocation that a strict ancestor
  signed while admitted and at or before its own cut. An admitted computer
  whose lowest `replica-left` record names the pinned founder and sits at
  or before that cut left: its cut is then just before that record, and it
  shows as left rather than revoked. A revocation that cut it before the
  record came first, so it stays revoked; a left record naming another
  founder is a copy from another replica and is inert. An entry counts when
  its writer is admitted and it sits at or before the writer's cut, so a
  computer approved after its approver's cut is not admitted, and nothing
  below it is either. Leaving cuts nobody below: computers a leaver approved
  before it left stay admitted, and only its ancestors can revoke them. Records the pass does not use - an approval nobody
  accepted, a descendant's revocation of an ancestor, a ghost's records -
  are inert. The founder cannot be revoked; losing its key means moving to
  a new store.
- **Reading.** A pull lists the store and reads every slot this computer
  holds no record in, from any instance, member or not, and keeps every
  valid membership record it reads. It refuses nothing on the way in and
  does not stop at a gap, so a record from a computer that is not a member
  yet still counts once the approval admitting it arrives. A pull never
  reads a slot again once it holds a record there, so a computer keeps the
  first version of a slot it read; it detects a rewrite of that slot (two
  records in one slot) only if it also came to hold the other version, as
  the limits below say. A file that is not a valid record is reported
  and journaled once. Valid artifact entries from the same read are then
  reconciled, as artifact sync below describes.
- **Journal.** The `replica.*@2` events are inputs only: this computer's
  identity and role, the founder it pinned (a founding identity pins
  itself, so a host that stops right after creating it is still pinned), each valid record it holds
  (bytes and signature, keyed by slot and hash), a signed local entry
  whose publish has not landed, and diagnostics - unreadable files,
  refused commands, and store failures. Members, keys, the tree, cuts, and
  which entries count are derived on every read and never journaled as
  facts. The projection is held in memory and rebuilt from the journal on
  every start. Earlier `replica.*@1` membership names decode to nothing, so a journal
  that holds them starts with no replica identity.
- **Commands.** The host serves create a replica, write a join request,
  approve a join, confirm a join, preview a revoke, revoke, pull, and leave
  on the host-only `/api/replica-membership/commands` route. Creating a
  replica or asking to join creates a new device key, and the id comes from
  it, so asking again - after a request went stale, a revocation, a cut that
  removed this computer's approval, or leaving - is always a new identity. Approving
  needs a member in good standing - admitted with no cut - and only the
  store's own signed copy of a fresh request from a computer that is not
  in the tree can be approved. Confirming reads the store, finds the
  approver's approval of this computer, and walks parent edges up from the
  approver to the one founder they reach; each edge is a record its child
  signed, so the walk is unique. It checks the matching code against the
  approver's key and that founder, checks that an acceptance would admit
  this computer, and only then pins the founder and signs `join-accepted`;
  an identity has one parent forever. Confirming's read follows the
  restore's progress model: it lists the store once and reads every slot
  this computer holds nothing in and did not already read, newest first,
  in batches of 25, inside the command line. The journal holds
  `replica.join-read-started@2` (the identity and the unread total),
  `replica.join-read-progress@2` after each batch with the slots it read
  and holds no record for (artifact entries and files that are not
  records), and `replica.join-read-stopped@2`, `replica.join-read-resumed@2`,
  and `replica.join-read-finished@2`. The read is marked running before
  the listing, so `stop-join-read` on the same route also ends it there;
  otherwise it stops after the current batch, without queueing behind
  the confirmation, and the
  confirmation is refused as `join-stopped`; confirming again, also after
  a restart, re-lists and carries on at the next unread slot, adding what
  the store gained to the total. A read the journal says is running while
  no confirmation in this process reads shows as stopped. Its state and
  counts are `joinRead` in the sync status until it finishes. Artifact
  entries count only once this computer is a member, so the restore after
  the join reads them again. Revoking needs good standing and a
  subject this computer brought in, directly or through others; a sibling
  or cousin is revoked from a shared ancestor, the founder at worst.
  Revoke reads the store first, then cuts at the highest sequence of the
  subject's valid signed entries this computer holds or just read,
  artifact entries included, so what the subject already signed keeps
  counting; a store that cannot be read leaves that cut at the membership
  records this computer already holds, and the result says so. A revoke
  preview returns that cut, the computers the subject brought in that are
  not revoked yet, each with its parent and the parent's sequence of its
  approval, and the revocations the subject itself already wrote, each at
  its sequence. A revoke can name some of the computers it brought in to
  revoke in the same step, and can move the subject's cut earlier - before
  one of its revocations, say - but never later. Each revocation is its own
  publish; when the subject's lands and a later one stops, the result is
  revoked-in-part and names the computers that were not revoked. Pull is
  allowed to any computer with an identity. Settings › Sync reads a
  membership view from the journal alone, on the same host-only route
  family (`/api/replica-membership/state`): this computer's standing, the
  admitted computers with their approver, whether each is revoked and
  whether this computer may revoke it, fresh join requests with their
  matching codes, and, on a joining computer, each member in good standing
  of a replica it read with the code that member will show. A read-only
  status view without codes, requests, ids, or revocability
  (`/api/replica-sync/status`) is on the shared product dispatch, so a
  paired device of this host can read it under `project.overview.read`;
  the paired-browser shell shows it read-only. Each listed computer says
  whether it was revoked or left; never both.
- **Leaving.** A host person leaves from Settings › Sync after a
  confirmation that says what follows. A member in good standing first
  finishes a stopped publish, then publishes a `replica-left` record at its
  next slot through the ordinary write path; a record that already landed
  is not written again. Only then is `replica.left@2` journaled (the
  identity, and whether the record is in the store). The projection drops
  the identity, its pinned founder, the membership records it held, its
  stopped publish, and its last store failure; artifact sync drops its
  queue, so nothing queued under the identity that left publishes, there or
  under a later identity in another store. Versions, tombstones, comments,
  and settled slots stay, so the library and every Canvas's history are
  unchanged. Then Settings › Sync's switch turns off and the device key is
  deleted from the credential store; each step is journaled once it
  happened (`replica.left-cleanup@2`), and a step not journaled yet is
  retried on host start and before every membership command, so a host
  that stops right after leaving, or a locked credential store, does not
  leave the key or the switch behind. With no identity, pull, publish,
  restore, and every membership command but create and join answer before
  any store call. Joining again, in this store or another, is a new
  identity with a new key. What the computer published before it left stays
  in the store and keeps counting, as a revoked computer's entries up to
  its cut do. A joining computer, a revoked one, or one cut out above it
  writes nothing when it leaves: no record of it would count. The founder
  may leave too; the computers it approved stay, and none of them can then
  be revoked, the same as when the founder is lost.
- **Leaving with the store out of reach.** When the record cannot be
  published - sync is off (`not-configured`), the store does not take it,
  or the key cannot sign - leaving is refused and nothing changes: the
  identity, key, queue, and switch stay as they were, and leaving again
  finishes the same signed record. It is not kept to publish later: that
  would need the old store's location and credentials after the person
  chose another store, a store call this computer promised to stop making,
  and a write into a store the person may be leaving because they no
  longer trust it. For a store that is gone for good, the person can
  leave `withoutStore` after a second confirmation; nothing is written, and
  the other computers keep listing this one until an ancestor revokes it.
  Its key is deleted either way, so nothing new can be signed with it here.
- **Writing.** A command that publishes journals the signed entry before
  either file is written, writes the signature and then the entry, and
  journals the record as held once both landed. If a publish stops
  part-way, the next command finishes it first with the same bytes and the
  same deterministic Ed25519 signature; a finished identity's stopped
  publish is dropped. A slot that already holds bytes this computer did
  not write is journaled as slot-occupied and skipped, up to 32 slots in a
  row; then the publish stops with a visible error. A person recovers from
  that flood by deleting the files with the storage provider's own tools,
  rotating the store credentials, or moving to a new store.
- **Limits.** A stolen founder key can revoke anyone and cannot itself be
  revoked; recovery is a new store. A store, or a sync client that lags,
  can show a computer fewer files, and a computer that has not read a
  revocation keeps counting the revoked computer's later entries until it
  does; records it already holds are never lost. A rewrite of a slot is
  detected only by a computer that holds both versions; since a pull never
  re-reads a held slot, a computer that read only the later version keeps
  it, and computers that read different versions may differ until one of
  them holds the other's. Anyone who can
  write the store can mint valid records under fresh keys; they are inert
  and cost only disk and time, within the listing bounds. A pull whose
  listing does not end inside its bound is refused rather than read in
  part. Approvals a stolen key made before the revoker read the store
  still count under the default cut, which is why the revoke preview lists
  them.
- **Keys.** Device signing keys live per instance in their own namespace of
  the host credential store - a separate macOS Keychain service,
  `app.octant.replica-device-keys.v1`, or a separate Secret Service
  attribute - keyed by the derived id and reached through the credential
  broker's device-key routes. The provider credential routes reach a
  different namespace, so a provider instance created with the same UUID
  cannot read, replace, or delete a device key. The private half never
  leaves the host.
- **Store.** The membership service asks Settings › Sync's store selection
  for its store on every command; with sync off or no store chosen, every
  command that needs the store answers a typed `not-configured` refusal and
  makes no store call. Settings › Sync sets up a replica, joins, approves,
  revokes, and leaves through these commands. A computer changes its store
  by leaving its replica first.

## Artifact sync: publish and pull

`ReplicaArtifactSyncService` and
`ReplicaArtifactImport` in `apps/server/src/replica/`.

- **Publish.** The Canvas service's committed-version hook - the seam the
  0029 mirror listens on - hands every committed version to artifact sync,
  whichever surface made it; a deletion is queued through the same service
  as a tombstone over every version head this host knows. Nothing is
  queued while sync is off or this host has no replica identity, nor for a
  Code thread under Plan mode, so neither calls the store. Before queuing,
  the title, every string a block carries, and each source's display name
  pass the share filter; a version that fails, or exceeds the bundle size
  bound, is journaled as a refused publish and never queued. A queued
  entry is journaled first (`replica.artifact-queued@2`) with its kind,
  artifact origin, parents (the previous local version), and the 0029
  bundle whose header names the artifact's replica origin - the instance
  that first published it, since every host calls itself `local` - plus
  the Project name it is filed under. Drains run oldest first through the
  membership service's single command line, at the identity's next free
  slot, after finishing any stopped membership publish; only a member in
  good standing drains. The entry is built for the slot it is about to
  take, so a retry at that slot is the same bytes and the same signature,
  and a publish that landed before the host stopped is found already
  there. A landed slot is journaled inside that line
  (`replica.artifact-published@2`), so a membership entry never takes it.
  A publish that does not land stays queued, in order, across restarts, and
  is journaled as a receipt once per reason
  (`replica.artifact-publish-failed@2`); the local version is never
  unwound. An imported entry is never published again.
- **Pull.** On host start, every five minutes, and on the membership pull
  command, the read described above holds membership records and then
  hands each valid artifact entry, in instance and sequence order, to the
  import. The import refuses an entry whose text fails the share filter
  (`unsafe-content`), runs the rest through `reconcileReplicaEntry` with
  standing from the derived membership, and journals each outcome
  (`replica.artifact-reconciled@2`): imported, already present, concurrent
  head, or tombstone with the entry's exact text, or refused with its
  reason and no content. A refusal is journaled once per slot and reason.
  Refusals that depend only on the entry's bytes - content-hash mismatch,
  a local artifact named as foreign, unsafe content - settle the slot; a
  refusal that standing or another slot could change is read again by a
  later pull. A store failure is the membership read's own receipt. An
  entry reaches the import only after its signature verified under the key
  it names, and only an admitted computer's entry within its cut is
  imported, so imports from this person's own computers are not tainted as
  untrusted; they enter no thread until bound.
- **Restore.** A computer whose identity is a member in good standing
  restores the whole library on its first sync: a fresh or wiped
  computer that joins gets every live artifact and its full version
  history. The restore lists the store once and reads every slot this
  computer holds nothing in, each computer's slots newest first, taking
  one from each computer in turn, in batches of 25. Each batch takes the
  membership command line once, so publishes and commands run between
  batches; it holds membership records, then reconciles its entries with
  `restoring` set, which lets a version or tombstone apply ahead of its
  writer's earlier slots. Heads are derived from the whole set of
  versions and tombstones, so the library a restore ends with does not
  depend on the order it read them in, and every listed slot is read
  before it finishes; a version id already held keeps the body it was
  first held with. Comment entries still wait on their writer's earlier
  slots. Entries that wait on another slot are tried again within the
  same read while others keep applying. After the last batch, one pull in
  writer order takes in what still waited, then the restore is finished.
  The journal holds `replica.restore-started@2` (the identity and the
  unread total), `replica.restore-progress@2` after each batch once its
  entries are journaled, and `replica.restore-stopped@2`,
  `replica.restore-resumed@2`, and `replica.restore-finished@2`. A restart
  lists the store again and resumes at the next unread slot; slots read
  before it are held, so nothing applies twice, and what the store gained
  meanwhile is added to the total. A batch holds only the membership
  records it read, so a revocation written after this computer confirmed
  its join and read in a later batch does not undo entries an earlier
  batch already imported - the lag limit membership already states,
  narrowed by the join having held every record in the store when it
  was confirmed. Until it finishes, the restore reads in
  place of the interval pull. A person can stop it from Settings › Sync on
  the host; a stopped restore stays stopped across restarts, and
  nothing reads the store until the person resumes it: background sync
  skips its pull, and the membership commands that read the store - pull
  (Check the store), approve a join, preview a revoke, and revoke - are
  refused as `restore-stopped` before any store call, and a restore
  listing or batch that waited in the command line finds the Stop and
  reads nothing. Settings › Sync
  turns those controls off and says why. Publishing continues; it only
  writes, and reads back a slot it writes only when that slot is taken.
  Stop and Resume ride the host-only membership commands route
  (`stop-restore`, `resume-restore`); the restore's state, read count, and
  total are in the sync status, which a paired device reads without the
  controls.
- **Comments.** The Canvas comment service tells artifact sync about each
  comment change a person makes on this host. Only a Canvas the replica
  carries - one this host published or imported - has its comments
  published; a Canvas that never left this host keeps them here, as does
  Plan mode and sync off. A change is queued in the same queue as versions
  (`replica.comment-queued@2`) with `after` taken at that moment, and a
  comment or reply whose text fails the share filter is journaled as a
  refused publish and never queued. A pulled comment entry is first taken
  into the Canvas's `canvas-comments` aggregate - as a comment or reply
  whose origin names the writing computer (`replica`, with its instance id
  and name), a resolve, or a deletion - and then journaled as kept, so a
  host that stops in between reads the slot again and the second take
  changes nothing. A change about a comment no longer held here changes
  nothing, and so does one past this computer's per-Canvas comment or
  reply budget: its slot settles, so a full thread does not hold the
  writer's later entries behind it, and that change is not taken in later. Taken-in changes are never announced again, so they are not
  published under this host's sequence. Comments land on the aggregate
  whether or not the Canvas is open here, and show once it is. A purge
  or Project erase drops queued comment changes and rewrites kept ones to
  content-free erased slots, as for versions.
- **Library.** Imported versions and tombstones live in the in-memory
  `ReplicaArtifactProjection`, rebuilt from those events on every start;
  a restart part-way through a pull resumes from what was journaled and
  reaches the same state. Heads are versions no version or tombstone names
  as a parent, plus every tombstone. `replicaArtifactStanding` (domain)
  derives what the person sees, counting this host's still-queued versions
  as written here: `current`, `two-versions` (two or more version heads to
  choose between), or `deleted` (every head is a tombstone). For a Canvas
  held here, the version standing here is a candidate unless a version from
  another computer revises it, and a head already in its own history is not
  one; a single version from elsewhere that revises it is `ahead`. The
  host-wide library lists, for a local window only, each synced artifact
  this host holds no Canvas for, under the Project name it was filed under
  and the name of the computer that wrote the version shown, with its
  standing; a deleted one shows the version its tombstone named and the
  computer that deleted it. A paired device sees none. Each held Canvas's
  card carries the computer that wrote its current version once this host
  has a replica identity, and its standing when it is not current. The
  library query applies to synced entries: mode, kind, and text match (text
  also matches the computer's name), and a Project filter or the Shared tab
  matches none, since they have no Project or share here.
- **Binding (0040).** `SyncedArtifactService` serves the host-only
  `POST /api/artifacts/synced` route; a paired device is refused before the
  command is decoded. Opening a synced artifact binds it to a thread the
  person chooses among those `decideReplicaArtifactBinding` finds
  compatible from the thread's durable state: same mode, active thread,
  active Project of that mode, a workspace the host resolves now, and not
  Plan mode. It is checked again at the commit. The content first enters
  the thread through thread external-content ingestion
  (`replica-artifact:<canvas>:<version>`, labelled with the writer's name),
  which taints it, then becomes the Canvas's first version there through
  `CanvasService.adoptVersion`, which takes the thread, Project, and mode
  from the authorized context and never from the bundle. The version keeps
  its id, so the publish hook, which skips a version the replica already
  holds, does not publish it again. Each source keeps the origin's replica
  host id, so a refresh or Open here fails closed rather than resolving
  another computer's references. With nothing compatible the command is
  refused as `no-compatible-thread`, and the library names the mode to start
  a thread in (offering to start one only for Chat, the kind it starts) or
  leaves it unbound. Keep, Merge, and Restore refuse as `sync-off` before
  committing anything when this computer cannot publish, re-check the bound
  thread before recording ingestion on it, and report a version the share
  filter or size bound kept here as refused rather than published. After each pull the sync service makes, a
  bound Canvas takes in an `ahead` version the same way.
- **Resolving.** Keep this one publishes a version with the chosen content
  whose parents are every candidate; Restore publishes one whose parents
  are the tombstones' parents. Unbound, it is queued directly; bound, it is
  the thread's next version through `adoptVersion`, with the parents handed
  to the publish hook just before the commit. Merge needs a thread:
  unbound, it binds the newest candidate first, then commits a version
  through `CanvasService.revise` whose blocks are every candidate's
  (`mergeReplicaArtifactBlocks`: both sides of a block changed differently
  are kept, and a block naming a source the merged manifest lacks is left
  out and counted), with every candidate as parents. None of these
  overwrites a version or removes a tombstone. Keep and Restore of an
  unbound artifact need sync on and a replica identity (`sync-off`
  otherwise).
- **Erase.** A thread purge or Project erase also erases artifact sync's
  copies of the Canvases it takes: a queued publish is dropped, and a kept
  entry's event is rewritten to a content-free
  `replica.artifact-slot-erased@2` that keeps its slot settled, so a later
  pull does not import the erased content again. Published slots keep
  their content-free record. Copies already in the store are not deleted.
- **Not built yet.** While a computer waits to be approved, the interval
  pull and Check the store read its unread slots, artifact entries
  included, in one pass without progress. Binding selects
  an existing compatible thread; it
  does not create one. Keep and Merge resolve version heads only: a
  tombstone beside a revision stays a head, and the artifact stays
  visible. A pull through the membership route rather than the sync
  service takes `ahead` versions into bound Canvases on the next interval.
  No product surface deletes an artifact today; a local erase or purge
  stays local and publishes nothing. Versions committed before this host
  had a replica identity are not published, and neither is the library a
  computer kept when it left one replica and joined another.

## Store selection

Settings › Sync chooses this host's
store: a synced folder, an S3-compatible bucket, or none, with a sync switch
that starts off. It is served on the host-only `/api/replica-store` routes,
which answer only a loopback host name and a local window, sit on the
loopback chain outside the shared product dispatch, and are a remote
local-only prefix, so a paired client can neither read nor change them. A
folder arrives as a candidate from the host's folder browser, which the host
resolves and judges inside home, never as a path. A bucket's settings carry
no secret: the access key and secret travel once, in the command that saves
them, into the host credential store, and the settings hold only an opaque
reference to that entry, which is removed when another store is chosen. The
key pair lives in a namespace of its own, keyed by that reference — a
separate macOS Keychain service, `app.octant.replica-store-credentials.v1`,
or a separate Secret Service attribute, `octant.replica-store-credentials.v1`
— reached only through the credential broker's bucket-key routes. Neither the
provider credential routes nor the device-key routes reach it, so a provider
instance or device key with the same UUID cannot read, replace, or delete a
key pair. Unlike a device key, a key pair is replaced when the person enters
a new one: the new pair is written to a fresh entry, the settings are
journaled to point at it, and only then is the old entry deleted; if the
journal write fails, the new entry is deleted and the old one stays in use.
A saved key pair is reused only for the same endpoint, bucket, and
addressing, the three that decide which server receives the signed
requests; changing any of them without a new key pair is refused as
`credentials-required`, so a key pair is never sent to a server it was not
entered for. A host with no credential broker cannot keep one, so saving a
bucket there is refused as `credential-store-unavailable` and only a folder
can be chosen. The choice is journaled whole as one host settings
aggregate, rebuilt on every start, and versioned, so two windows cannot
overwrite each other. Replay keeps the journal's head version even when the
newest frame does not decode: the last choice that does decode is kept with
sync off, so the next change is accepted and no store is called until the
person turns sync on again. Choosing or changing the store turns sync off, so the
person reads Settings' statement that the provider can read the files again
before turning it back on; saving a bucket with identical settings, such as
a new key pair alone, keeps sync as it was. Choosing no store asks for
confirmation in the page first, naming that sync stops and that a bucket's
key pair is removed from this computer. With sync off or no store, the selection is
`not-configured` and no store is opened or called; with sync on, the in-tree
folder or bucket store is opened as installed and enabled by the switch.
The store handed to a membership command re-reads the settings before every
store call and answers `not-connected` once sync is off or the settings it
was opened under have changed, so turning sync off mid-command stops further
calls. Test connection writes one probe file only while sync is on; with
sync on and a store that cannot be opened, it answers
`credential-store-unavailable` or `not-connected`.
While this computer belongs to a replica — it has a founder or joiner
identity in the membership projection — every command that would change the
store's kind or location (choosing a folder, a bucket's endpoint, bucket,
addressing, or prefix, or no store) is refused on the server as
`member-of-replica` before any side effect, and Settings › Sync says so,
points at leaving, and disables those controls. Turning sync on or off, and
a new key pair for the same bucket, stay allowed. Leaving the replica turns
sync off and lifts the lock, so the person can choose another store.

## Verification

Tests beside the implementation in `apps/server/src/replica/`:
`replicaMembershipService.test.ts`, `replicaMembershipConvergence.test.ts`,
`replicaMembershipRoutes.test.ts`, `replicaArtifactSync.test.ts`,
`replicaDeviceKeyService.test.ts`, `replicaStoreSettingsService.test.ts`,
`replicaStoreSettingsRoutes.test.ts`, `syncedFolderReplicaStore.test.ts`,
`s3ReplicaStore.test.ts`, and `syncedArtifactRoutes.test.ts`.
