import { requireOptionalNativeModule } from "expo";
import {
  createExchangeListenerFetch,
  type PinnedListenerTransportPort,
} from "@octant/client-runtime";
import {
  nativePinnedTlsExchangePort,
  type OctantPinnedTlsNativeModule,
} from "./pinnedTlsExchangePort";

const native = requireOptionalNativeModule<OctantPinnedTlsNativeModule>("OctantPinnedTls");

/**
 * The phone's transport to a listener held to its pin: the in-tree native
 * module checks the served key during the TLS handshake. A build without the
 * module (Expo Go) reports unavailable, so a pinned origin is refused rather
 * than reached through the platform `fetch`.
 */
export const mobilePinnedListenerTransport: PinnedListenerTransportPort = ({ origin, trust }) =>
  native === null
    ? { status: "unavailable" }
    : {
        status: "available",
        fetch: createExchangeListenerFetch({
          origin,
          trust,
          port: nativePinnedTlsExchangePort(native),
        }),
      };
