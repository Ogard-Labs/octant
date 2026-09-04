# 0083. A Work turn records what changed in its folder

**Status:** Accepted

## Context

Work binds one OS-confined folder and runs the provider inside it under a
`project-root-confined` posture (0003). The provider writes with its own tools:
it never calls Octant's mutation service, and `WorkTurnState` carried no
artifact facts. The host therefore could not say what any turn produced.

Every Work surface that should answer "what came out of this" was blocked on
that gap. The thread transcript narrated a file in prose or not at all. The
folder listing (0044's Files tool, made real for Work) could group files the
mutation service recorded, but a provider's real output listed as a file the
folder merely happened to hold — which is most output in practice, because the
mutation service is only on the composer's no-provider fallback path.

Routing provider writes through the mutation service is not available: the
provider is an external agent writing to disk, and Octant cannot interpose on
those writes without becoming its filesystem. Observation is the only mechanism
left. Code already observes its checkout this way (`CodeFileWatchService`), but
for a different purpose: a transient "something changed, refetch" signal that is
never journaled and never attributed to a turn.

## Decision

- **A Work turn observes its bound folder for the length of the turn.** The
  observation starts before the provider does and finishes when the turn
  settles. It is scoped to one turn; there is no standing Work watch.
- **The record is an observation, never an attribution.** The host watches a
  folder and cannot know who wrote what, so a file another process touched
  during the turn is recorded identically to one the provider wrote. The
  contract, the projection, and every surface use the vocabulary "changed while
  this ran" and never "created" or "the assistant wrote".
- **The record carries identity only.** Paths are relative to the bound folder.
  Nothing in this path reads a file, resolves a name to a host absolute path, or
  widens what a client may fetch. Surfaces act on the record by re-reading
  through the folder listing, which applies its own confinement every time.
- **Names from the filesystem are untrusted.** A name containing a traversal
  segment, or one the confined relative-path contract refuses, is dropped and
  marks the record truncated rather than being normalized into a path a later
  read would resolve elsewhere. Traversal is refused before hidden-name
  filtering, so an escape attempt can never be discarded as ordinary platform
  churn.
- **Incompleteness is always stated.** A record is `truncated` when the host
  reported a change it could not name, when a name was refused, when the path
  bound was reached, or when the watcher was dropped mid-turn. A dropped watcher
  is the important case: the changes made while nothing was watching are already
  lost, so reporting what was seen before the drop as though it were everything
  would be undetectable to the surface.
- **The record is journaled on every settled outcome**, not only a completed
  one. A turn that failed or was interrupted may still have written a file, and
  omitting that would tell a person the folder is untouched when it is not.
- **The folder listing treats an observed path as the work's own output**,
  alongside the mutation service's artifacts. An observed path carries no
  artifact facts — watching sees a path change, never a format or a version — so
  the listing shows it without the format and version it shows for a recorded
  artifact.
- **A host that cannot watch records nothing.** The observer is optional; its
  absence means no written files, never a guess.

## Consequences

- `WorkTurnState` and `work.turn-updated@1` carry an optional bounded
  `wroteFiles`, so replay reconstructs what each turn changed.
- The thread transcript can show files as files, and the Files tool's grouping
  reflects what a provider actually produced rather than only what the mutation
  service happened to record.
- Attribution is per turn, and per Project when aggregated for the listing. It
  is never per author: the record cannot distinguish the provider's write from a
  person saving a file in another application during the same turn.
- The bound on recorded paths means a turn that rewrites a large tree reports
  `truncated` and points at the folder itself. This is deliberate: a transcript
  is not a file manager.

## Related

- 0003 Product modes: Chat, Work, and Code authority
- 0028 The artifact library
- 0044 The dock hosts live thread-owned tools
