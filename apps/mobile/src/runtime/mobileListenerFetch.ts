import {
  NO_PINNED_TRANSPORT_COPY,
  type PinnedListenerTransportPort,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime";

const ORIGIN_OF_URL = /^(https:\/\/[^/?#]+)/;

/**
 * The `fetch` every session on the phone uses. A request to an origin whose
 * pairing record holds a pin goes through the pinned transport and nowhere
 * else; a request to any other origin uses the platform `fetch`, which never
 * accepts a certificate the host made itself. A record that cannot be read
 * refuses the request rather than falling back.
 */
export function createMobileListenerFetch(input: {
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly pinnedTransport: PinnedListenerTransportPort;
  readonly platformFetch: typeof globalThis.fetch;
}): typeof globalThis.fetch {
  return async (request, init) => {
    const url =
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    const origin = ORIGIN_OF_URL.exec(url)?.[1];
    if (origin === undefined) return input.platformFetch(request, init);
    const record = await input.deviceKeyStore.findByOrigin(origin);
    const trust = record?.listenerTrust;
    const pinned =
      trust !== undefined &&
      (trust.current.kind === "pinned" || trust.staged?.trust.kind === "pinned");
    if (trust === undefined || !pinned) return input.platformFetch(request, init);
    const transport = input.pinnedTransport({ origin, trust });
    if (transport.status === "unavailable") throw new TypeError(NO_PINNED_TRANSPORT_COPY);
    return transport.fetch(request, init);
  };
}
