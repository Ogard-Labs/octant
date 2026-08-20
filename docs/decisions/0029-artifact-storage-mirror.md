# 0029. The artifact storage mirror

**Status:** Accepted

## Context

0028 made every artifact on a host findable. It deliberately said nothing about
files: an artifact lived only inside Octant's database, so nothing else a person
owns could open one. That is a real cost — a diagram you cannot put in a
repository or hand to another tool is a diagram that only exists while Octant
does.

The tempting fix is to treat a folder as the artifact. Once a file can write
back, two writers own one document, the journal becomes a cache of the disk, and
the first conflict is unresolvable because neither side knows what the other
meant.

This record extends 0010 and sits beside 0028. Nothing here changes what an
artifact is.

## Decision

- **The journal remains the only source of truth.** Every mirrored file is
  derived. Viewing an artifact never depends on a storage choice, and a storage
  choice never changes what the library shows.
- **Three tiers, and writing nothing is the default.** `internal-only` keeps
  artifacts versioned and readable with no files at all; a **global folder** the
  user picks is organized by Project subfolder; a **per-Project override** writes
  into that Project's bound repository. A Project's own choice wins over the
  host-wide one. The setting is versioned and journaled, and a change computed
  against a stale view is refused.
- **The mirror is one-way. Files are output.** After each committed version —
  from any surface, including creation, because they all go through the same
  commands — the exporter re-materializes that artifact.
- **The export is diff-friendly on purpose.** A bundle carries the artifact's
  identity (`canvasId`, version, sequence, mode, Project, host) beside its
  definition, written with a fixed key order and stable indentation so a
  revision that changed one sentence shows one changed line. Rendered sidecars
  travel with it so the files are useful to a person outside Octant, drawn by
  the same renderer the gallery uses rather than a second one that would drift.
- **A destination is rewritten in place.** History lives in the journal, not in
  a folder of dated copies. A renamed artifact is written under its new name and
  its old files are removed, rather than leaving a second stale copy of the same
  document.
- **A repository destination is written to the working tree only.** Committing
  is a separate act. Auto-commit is **off by default**, and when it is on the
  host commits the artifact files it just wrote and nothing else: anything else
  already staged refuses the commit rather than being swept into a commit its
  author never wrote. The commit is authorized against the index as it stands
  at that moment, so a checkout that changed underneath refuses rather than
  races. **Nothing is ever pushed, at any setting** — reaching a remote stays an
  act the user takes. Auto-commit needs somewhere to commit: asking for it
  without a repository destination is refused, and taking the last repository
  away turns it off rather than leaving a setting that quietly does nothing.
- **An externally edited file is never absorbed silently.** The host offers
  re-import, which **appends a version** carrying where it came from. The
  decision function that governs this cannot express "overwrite" — a function
  that cannot return the dangerous outcome cannot be talked into it. A bundle
  naming another artifact is refused however it got there.
- **Authority.** A folder the user picked can be anywhere, so it is governed by
  the standing access-outside-project approval; until that surface exists the
  host accepts only a folder inside the user's own home and refuses the rest. A
  repository destination sits inside a root the Project already bound and needs
  no second grant. Plan mode refuses, because read-only is a promise about the
  disk as well as the journal.
- **Mirroring is settled on the host.** A paired device cannot name a folder on
  this machine, and cannot re-import a file only the host can see. Both are
  refused at the route rather than at the service.
- **Every outcome is journaled**, including the ones where nothing was written,
  so "why is there no file" is answerable after the fact rather than something
  to reproduce.
- A **synced folder is how artifacts reach another device.** That is the user's
  own sync, chosen by them; Octant adds no cloud of its own.

## Consequences

- Artifacts become openable by everything else a person owns, without the
  journal ceding authorship to a filesystem.
- One-way mirroring will frustrate anyone who edits an exported file expecting
  it to take. Re-import exists precisely so that edit is not lost; it costs a
  version rather than silently winning.
- Files are a copy. Deleting one does not delete the artifact, and someone who
  expects the folder to be authoritative will be surprised once. Saying so where
  the setting is chosen is cheaper than making the folder authoritative.
- A mirror write can fail — a full disk, a folder that moved — and that failure
  must never unwind a version that already happened. It is reported as a receipt
  instead.
- Until the access-outside-project surface exists, a folder outside the user's
  home is refused rather than assumed. That is narrower than the final rule and
  fails in the safe direction.
- Auto-commit refuses whenever the index holds anything else, so a person who
  keeps work staged while artifacts revise will see it decline rather than
  commit. That is the intended trade: a refused commit costs a click, and a
  commit someone did not write costs their trust.
- Re-import goes through the ordinary revise path, so an artifact whose thread
  or Project is gone cannot be re-imported. Its file is still readable; what it
  cannot do is rejoin a document that no longer has a home.

## Future work

Sharing an artifact with another **person** is the same problem one step out,
and the bundle is already the unit that would travel: identity beside
definition, diff-friendly, and refused when it names another artifact. The
direction is a **store the user owns** — a Git remote they control, or a
comparable self-hosted target — that Octant pushes bundles to and reads bundles
from on their instruction, with each side's journal appending versions rather
than adopting the other's.

Nothing here is built, and one thing is settled in advance: **there is no
Octant cloud, ever.** Cross-device and cross-user sharing reach a target the
user already owns, or they do not happen. Whoever builds it owns the questions
this record does not answer — how two people's versions of one artifact
reconcile, and what a bundle proves about who wrote it.

## Related

- 0002 Durable event journal and rebuildable projections
- 0009 Sandbox confinement, approvals, and Plan mode
- 0010 Secure file preview and canvas artifacts
- 0028 The artifact library
