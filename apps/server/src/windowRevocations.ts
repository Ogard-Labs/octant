import type { WindowId } from "@octant/contracts";

/**
 * What a window's revocation says about who asked and why, when the request
 * itself says. Only the desktop's own revoke route supplies one: a revocation
 * the host starts itself (a lapsed lease or capability) carries none.
 */
export interface WindowRevocation {
  readonly requestedBy: "desktop";
  /**
   * The desktop's app is quitting, so the window is leaving with it rather
   * than being closed by the person. Said per request, never remembered.
   */
  readonly appQuitting: boolean;
}

/** One failing owner must not prevent the other owners from losing authority. */
export function notifyWindowRevocations(
  windowId: WindowId,
  owners: ReadonlyArray<(windowId: WindowId, revocation?: WindowRevocation) => void>,
  revocation?: WindowRevocation,
): { readonly kind: "notified" } | { readonly kind: "failed"; readonly count: number } {
  let count = 0;
  for (const revoke of owners) {
    try {
      revoke(windowId, revocation);
    } catch {
      count += 1;
    }
  }
  return count === 0 ? { kind: "notified" } : { kind: "failed", count };
}
