# 0130. Usage opens at its last completed reading

**Status:** Accepted

## Context

Local provider history is imported in bounded, resumable passes, and the window
a surface asks for is anchored at "now", so it is never the same request twice.
Every open therefore began with the reading state and repainted its totals as
the import advanced: on a real 30-day view, 737,58 $ rose to 802,97 $ over
4,25 s with the surface still reading. The page never opened at the totals it
had already computed, and the checkpoint cache of 0102 only removed the work of
re-reading unchanged files, not the work of summarizing them again.

## Decision

The host may keep its last completed reading of a local provider history view in
the rebuildable accounting cache beside the reader's checkpoint, and answer a
caller that asks for it first.

- The request says so explicitly. A caller that does not ask receives a reading
  of its own request, so no single call silently returns an earlier answer.
- The answer names itself and carries the range, coverage, and read time of the
  reading it came from. The surface paints those totals and reads again
  immediately: the last reading is a first paint, not an answer.
- Only a reading that finished is kept. A scan that still has more to do leaves
  the earlier completed reading in place rather than publishing a subtotal as a
  total, and the surface keeps the completed reading until this read finishes.
- A view is keyed by the sources it covers, the viewing timezone, and the length
  of the window. The window's instants are deliberately not part of the key: a
  surface asking for "the last 30 days" a minute later means that view, and the
  answer states which instants it actually covered.
- The cache is display-only and rebuildable. Losing it, or finding a stored
  document that no longer decodes, costs one full read and never an answer.

## Consequences

A repeated open paints its last totals at once and replaces them when the
current read completes, instead of repainting every total while the import runs.
The read time stays visible, so a total from an earlier opening is never
presented as the current one. A first-ever read is unchanged in cost.

## Related

- [0102 Local provider usage history](0102-local-provider-usage-history.md)
