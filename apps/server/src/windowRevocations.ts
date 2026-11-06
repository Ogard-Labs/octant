import type { WindowId } from "@octant/contracts";

/** One failing owner must not prevent the other owners from losing authority. */
export function notifyWindowRevocations(
  windowId: WindowId,
  owners: ReadonlyArray<(windowId: WindowId) => void>,
): { readonly kind: "notified" } | { readonly kind: "failed"; readonly count: number } {
  let count = 0;
  for (const revoke of owners) {
    try {
      revoke(windowId);
    } catch {
      count += 1;
    }
  }
  return count === 0 ? { kind: "notified" } : { kind: "failed", count };
}
