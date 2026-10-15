import type { PinnedListenerTransportPort } from "@octant/client-runtime";

/**
 * The phone's transport to a listener held to its pairing code's pin. The
 * app's ordinary `fetch` trusts only the platform's certificate authorities
 * and cannot check a pin, and the native module that will check pins in the
 * platform's TLS trust callback is not built yet, so a code's listener is
 * refused here rather than reached without its pin.
 */
export const mobilePinnedListenerTransport: PinnedListenerTransportPort = () => ({
  status: "unavailable",
});
