import { requireOptionalNativeModule } from "expo";
import {
  createExchangeListenerFetch,
  createRelayedExchangePort,
  type PinnedListenerTransportPort,
} from "@octant/client-runtime";
import type { RelayedListenerTransportPort } from "./mobileListenerFetch";
import {
  nativePinnedTlsExchangePort,
  nativePinnedTlsStreamPort,
  type OctantPinnedTlsNativeModule,
} from "./pinnedTlsExchangePort";

const native = requireOptionalNativeModule<OctantPinnedTlsNativeModule>("OctantPinnedTls");

/**
 * The phone's transport to a listener held to its pin: the in-tree native
 * module checks the served key during the TLS handshake. A build without the
 * module (Expo Go) reports unavailable, so a pinned origin is refused rather
 * than reached through the platform `fetch`.
 */
export const mobilePinnedListenerTransport: PinnedListenerTransportPort = ({
  origin,
  trust,
  hostId,
  onTrust,
}) =>
  native === null
    ? { status: "unavailable" }
    : {
        status: "available",
        fetch: createExchangeListenerFetch({
          origin,
          trust,
          ...(hostId === undefined ? {} : { hostId }),
          ...(onTrust === undefined ? {} : { onTrust }),
          port: nativePinnedTlsExchangePort(native),
        }),
      };

/**
 * The same pinned transport through the hub's relay: the module runs the TLS
 * over bytes the relay tunnel carries, so the pin is checked inside the
 * tunnel exactly as at home. A build whose module has no stream never relays.
 */
export const mobileRelayedListenerTransport: RelayedListenerTransportPort = ({
  origin,
  trust,
  hostId,
  onTrust,
  route,
}) => {
  const stream = native === null ? undefined : nativePinnedTlsStreamPort(native);
  if (stream === undefined) return { status: "unavailable" };
  return {
    status: "available",
    fetch: createExchangeListenerFetch({
      origin,
      trust,
      hostId,
      onTrust,
      throughRelay: true,
      port: createRelayedExchangePort({ stream, route }),
    }),
  };
};
