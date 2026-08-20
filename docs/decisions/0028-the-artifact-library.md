# 0028. The artifact library

**Status:** Accepted

## Context

Canvas artifacts are journaled per Project and reachable from the thread that
made them. That is the right authority model and the wrong way to find things: a
person does not remember which Project a diagram was made in, only that they
made it. The per-Project inventory answers "what did this Project make"; nothing
answered "what have I made".

The tempting shortcut is to let the renderer assemble the answer from the
Project reads it already has. That would make the scope of the library a
property of whichever window happened to ask, and would put the decision about
what a caller may see in the place least able to enforce it.

This record extends 0010, which established Canvas artifacts, their versions,
and their provenance. Nothing here changes that model; it adds a way to see
across it.

## Decision

- **The journal remains the only source of truth.** The library is derived, and
  every artifact it lists is the same aggregate the thread tab and the Project
  inventory read. Viewing an artifact never depends on where, or whether, it was
  ever written to a file.
- **The library is host-wide, and the server decides its scope.** It is a
  deliberate, recorded exception to per-window Project read scoping: a person's
  artifacts are theirs, and a library scoped to whichever Project a window
  happens to be looking at would be the per-Project inventory again. It is its
  own sidebar destination whose listing the host assembles; a renderer never
  builds it by making Project reads of its own, and never narrows a wider list
  it was given.
- A **paired device is clamped rather than admitted to that wider scope.** It
  reads the library through the least-authority catalog, and the service decides
  which Projects it may see artifacts from. An artifact whose Project a caller
  may not see is **absent** from the listing rather than shown as unavailable —
  the library must not disclose that it exists — and the Project is absent from
  the filter for the same reason.
- The listing carries **no filesystem path**, ever. Where an artifact lives on
  disk is not part of what it is.
- **An artifact's kind is read, not declared.** A Canvas is a document of
  blocks, so its kind is derived from those blocks to make the gallery
  filterable. A near-tie between two characters reads as `mixed` rather than
  rounding to the larger, and nothing decides authority by any of it.
- **Previews are drawn once, by the host.** The output is a self-contained SVG
  with no script and no external references, which is what lets a card draw it
  inline. One renderer draws them, so a future rendered sidecar is the same
  picture at a different size rather than a second implementation that drifts.
  A preview that cannot be drawn is absent, and the card names the kind instead.
- **Opening an artifact opens the same document by `canvasId`.** The library is
  a way in, not a second viewer.
- **Creation stays thread-scoped.** An artifact carries the thread it was made
  in, and provenance is not optional, so the library's create action starts a
  thread rather than minting an artifact with no origin.
- The listing is **bounded and says when it was cut**, so a page that shows part
  of the answer never reads as the whole one.

## Consequences

- Finding an artifact stops depending on remembering where it was made, and a
  gallery makes the shape of a thing the way you recognise it.
- The host-wide read is a genuine widening of scope, which is why it is a
  recorded exception with its own admission entry and its own clamp for paired
  devices rather than a quiet reuse of an existing Project read.
- Drawing every preview on the host costs work per listing. The page ceiling
  bounds it; a host with thousands of artifacts pays for one page of pictures.
- Deriving kind from blocks means an artifact's kind can change as it is edited.
  That is honest — the document did change — but it means a filter is a view of
  the present, not a label someone assigned.

## Future work

The same journal-derived export that makes a preview could make an **artifact
bundle**: block data plus rendered sidecars in a diff-friendly format.
Publishing bundles to a **user-owned Git remote or comparable self-hosted
store** would let another device — or another person's Octant — pull and import
them as new versions carrying their provenance, which is sharing across devices
and across users with nothing in between. It is recorded here as direction, not
as a decision: the import rules, the identity of a foreign provenance, and the
conflict shape each need their own record. It must never become an
Octant-operated store — the local-first invariant is not negotiable, and a
sharing path that requires our infrastructure is not the one. Those questions
are settled by [0038](0038-share-a-host-or-a-git-remote.md).

## Related

- 0002 Durable event journal and rebuildable projections
- 0010 Secure file preview and canvas artifacts
- 0013 Remote access: single host, paired devices, and mobile
- 0038 Collaboration: share a host or a git remote
