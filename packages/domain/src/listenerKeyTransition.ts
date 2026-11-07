import type { ListenerKeyTransition } from "@octant/contracts";

export const LISTENER_KEY_TRANSITION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const LISTENER_KEY_TRANSITION_HEADER = "x-octant-listener-transition";

/** Domain separation and ordered fields keep signatures independent of JSON property order. */
export function listenerKeyTransitionPayload(
  transition: Omit<ListenerKeyTransition, "signature">,
): string {
  return JSON.stringify([
    "octant-listener-key-transition-v1",
    transition.hostId,
    transition.origin,
    transition.oldPin,
    transition.newPin,
    transition.oldPublicKey,
    transition.preparedAt,
    transition.expiresAt,
  ]);
}
