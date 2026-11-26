import type { CodeCheckoutId, CodeCheckpoint } from "@octant/contracts";

/**
 * A state the thread recorded that a restore may write back: the checkout as it
 * stood before one of its turns, or what one of its restores replaced, with the
 * checkout the journal says it was recorded on. Turns and restores journaled
 * before the host recorded the checkout carry none.
 */
export interface RecordedRestorePoint {
  readonly checkoutId?: CodeCheckoutId;
  readonly checkpoint: CodeCheckpoint;
}

/**
 * Whether every turn the thread recorded ran on `checkoutId`. A turn that
 * recorded no checkout could have run anywhere, so a thread holding one counts
 * as having moved, and so does a thread with no turn at all.
 */
export function threadOnlyRanOn(
  turnCheckouts: ReadonlyArray<CodeCheckoutId | undefined>,
  checkoutId: CodeCheckoutId,
): boolean {
  return (
    turnCheckouts.length > 0 &&
    turnCheckouts.every(
      (turnCheckout) => turnCheckout !== undefined && String(turnCheckout) === String(checkoutId),
    )
  );
}

/**
 * Whether a point may be written back into `checkoutId`. Two worktrees of one
 * repository share Git objects, so a point from another checkout would apply
 * there and overwrite work it never saw. A point that recorded no checkout is
 * trusted only on a thread that has only ever run on this one.
 */
export function restorePointBelongsTo(
  point: { readonly checkoutId?: CodeCheckoutId | undefined },
  checkoutId: CodeCheckoutId,
  onlyRanOnCheckout: boolean,
): boolean {
  return point.checkoutId === undefined
    ? onlyRanOnCheckout
    : String(point.checkoutId) === String(checkoutId);
}

export function sameCheckpoint(left: CodeCheckpoint, right: CodeCheckpoint): boolean {
  return (
    String(left.worktree) === String(right.worktree) &&
    String(left.index) === String(right.index) &&
    String(left.head ?? "") === String(right.head ?? "")
  );
}
