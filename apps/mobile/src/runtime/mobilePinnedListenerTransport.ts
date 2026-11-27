import type { PinnedListenerTransportPort } from "@octant/client-runtime";
import type { RelayedListenerTransportPort } from "./mobileListenerFetch";

/**
 * The web build of the phone app has no native module that can check a
 * listener's pin, and a browser decides certificate trust itself, so a
 * pinned origin is refused here rather than reached without its pin. The
 * phone build uses the native module (`.native.ts`).
 */
export const mobilePinnedListenerTransport: PinnedListenerTransportPort = () => ({
  status: "unavailable",
});

/** The web build cannot relay either: it has no pinned transport to run inside the relay. */
export const mobileRelayedListenerTransport: RelayedListenerTransportPort = () => ({
  status: "unavailable",
});
