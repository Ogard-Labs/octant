# 0139. A Code turn records what changed in its checkout

**Status:** Accepted

## Context

A Work turn records what changed in its folder (0083), so a Work transcript can
show files as files. A Code transcript could not. Its reply narrated the files
in prose or not at all, and the only change facts Code kept were per thread: the
checkout's running totals on the board and in the strip under the composer. The
question a person asks after a turn, "what did that just touch", had no answer
short of opening Review and reading the whole working tree, which also holds
every earlier turn's changes.

Work answers the question by watching its folder for the length of the turn,
because it has nothing else to compare. Code has something better. It already
captures the checkout as Git tree objects before every turn that may write
(0020), so the state a turn started from is on record and exact.

## Decision

- **When a Code turn settles, the host captures the checkout again and compares
  the two trees.** The comparison is tree to tree, so it does not move while it
  is read, and it covers a file Git was not tracking when the turn started.
- **The record is an observation, never an attribution**, in 0083's words and
  for 0083's reason. The host compares two states of a folder and cannot know
  who wrote what. Contracts, projections, and surfaces say "changed while this
  ran", never "created" or "the assistant wrote".
- **The record carries identity and size only:** a checkout-relative path, lines
  added, lines removed, and whether Git counted the file as binary. It reads no
  file content and widens nothing a client may fetch. Renames are the path that
  went and the path that came; a rename score is a guess about intent.
- **Names out of a tree are untrusted.** A path the confined relative-path
  contract refuses is dropped and marks the record `truncated`, never normalized
  into a path a later read would resolve elsewhere.
- **The record is bounded at 32 paths and incompleteness is always stated.**
  `total` is what Git reported; `truncated` is authoritative. A transcript is
  not a file manager, and a turn that rewrote a tree points at Review.
- **It is journaled on every settled outcome, before the terminal state.** A
  failed or interrupted turn may still have changed files. Journaling it ahead
  of the terminal state means a client following the turn has the list by the
  time the turn reads as settled. A turn waiting on the person has not settled.
- **No starting capture, no record.** A Plan turn takes no capture because it
  may not write, and a checkout the host could not read yields none. Absence
  means "not observed". A turn that changed nothing also records nothing, so a
  turn that only answered a question journals nothing extra.
- **The comparison capture is released at once.** A turn's own checkpoint stays
  anchored for as long as the turn can be restored (0020); the settle capture
  exists only to be compared, so its anchor is dropped as soon as it is read.
- **Recording never fails a turn.** The change list is evidence about the turn,
  not part of it. The turn's abort signal is not passed to the capture, because
  an interrupted turn is exactly one whose changes a person needs to see.
- **The transcript shows it as the one card in a reply.** Replies are bare
  prose; a work product is a card. The list folds after five rows and states a
  truncated record in words rather than summing rows it never saw.

## Consequences

- `CodeConversationTurn` and the operation journal carry an optional bounded
  `changedFiles`, so replay reconstructs what each turn changed. The page
  version is unchanged: a page without the field reads as before, and adding an
  optional field follows `restoreUndo` and `limits`.
- Settling costs one more capture of the working tree, the same work the turn's
  start already does, queued with the checkout's other Git operations.
- The window is the turn, not the provider. Anything that changed the checkout
  between the two captures is listed, including a person's own edits.
- Rows do not yet open a file or a diff. Both are follow-ups and neither needs a
  new authority: they would re-read through the file listing and Review, which
  apply their own confinement.

## Related

- 0020 Checkpoints and restore by forking
- 0083 A Work turn records what changed in its folder
- 0003 Product modes: Chat, Work, and Code authority
