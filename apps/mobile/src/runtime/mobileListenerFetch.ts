import {
  NO_PINNED_TRANSPORT_COPY,
  createRelayFallbackFetch,
  relayRouteFor,
  type ListenerOriginTrust,
  type ListenerRelayRoute,
  type PairedHostRelayChoice,
  type PinnedListenerTransportPort,
  type RelayAdmissionSignature,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime";

/** The phone's pinned transport through the hub's relay; unavailable where the module has no stream. */
export type RelayedListenerTransportPort = (input: {
  readonly origin: string;
  readonly trust: ListenerOriginTrust;
  readonly hostId: string;
  readonly onTrust: (previous: ListenerOriginTrust, next: ListenerOriginTrust) => Promise<void>;
  readonly route: ListenerRelayRoute;
}) =>
  | { readonly status: "available"; readonly fetch: typeof globalThis.fetch }
  | { readonly status: "unavailable" };

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
  /**
   * Reaching a paired computer through its hub when away, by this phone's
   * own choice for that computer (decision H36). Absent, nothing relays.
   */
  readonly relay?: {
    readonly choiceFor: (origin: string) => Promise<PairedHostRelayChoice | undefined>;
    readonly transport: RelayedListenerTransportPort;
    /** Signs the hub's admission with this phone's key for that computer, and only that text. */
    readonly admit: (
      origin: string,
      payload: string,
    ) => Promise<RelayAdmissionSignature | undefined>;
  };
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
    if (record === undefined || trust === undefined || !pinned)
      return input.platformFetch(request, init);
    const onTrust = async (previous: ListenerOriginTrust, next: ListenerOriginTrust) => {
      const current = await input.deviceKeyStore.findByOrigin(origin);
      if (current?.keyId !== record.keyId) {
        throw new TypeError("The computer's pairing changed.");
      }
      if (JSON.stringify(current.listenerTrust) === JSON.stringify(next)) return;
      if (JSON.stringify(current.listenerTrust) !== JSON.stringify(previous))
        throw new TypeError("The computer's pairing changed.");
      if (!(await input.deviceKeyStore.updateListenerTrust?.(current.keyId, previous, next)))
        throw new TypeError("The computer's pairing changed.");
    };
    const transport = input.pinnedTransport({
      origin,
      trust,
      hostId: record.hostId,
      onTrust,
    });
    if (transport.status === "unavailable") throw new TypeError(NO_PINNED_TRANSPORT_COPY);
    const relay = input.relay;
    if (relay === undefined) return transport.fetch(request, init);
    const choice = await relay.choiceFor(origin);
    return createRelayFallbackFetch({
      direct: transport.fetch,
      relayed: () => {
        const route = relayRouteFor({
          choice,
          signer: {
            targetMemberId: String(record.hostId),
            admit: async (payload) => {
              const signed = await relay.admit(origin, payload);
              if (signed === undefined) throw new Error("The device key did not sign the relay.");
              return signed;
            },
          },
        });
        if (route === undefined) return undefined;
        const relayed = relay.transport({
          origin,
          trust,
          hostId: String(record.hostId),
          onTrust,
          route,
        });
        return relayed.status === "available" ? relayed.fetch : undefined;
      },
    })(request, init);
  };
}
