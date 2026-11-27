// A paired device's own choice to reach a host through the hub when it is
// away (decision H36), and the one rule for when it does. The choice is per
// host, off by default, and kept on the device. The device relays only when
// the choice is on, it holds the relay address its host told it on the
// private network, and the direct private connection failed before anything
// was sent. Inside the relay the device runs the same pinned TLS and the same
// signed-hello check as at home; a refusal of the host's key is never retried
// through the hub. A plain browser has no relay: only the desktop app and the
// phone build one.

import {
  REMOTE_RELAY_ADDRESS_PATH,
  decodeRemoteRelayAddressAnswer,
  isRelayUrl,
  type RelayAddress,
} from "@octant/contracts";
import type { ListenerRelayRoute } from "./relayTunnel";
import { ListenerUnreachable } from "./remoteListenerTrust";

export interface PairedHostRelayChoice {
  /** "Reach this computer through the hub when away"; off until the person turns it on. */
  readonly enabled: boolean;
  /** The relay address the host last told this device while on the private network. */
  readonly address?: RelayAddress;
}

/**
 * The route a device relays through, or undefined: the choice off, no stored
 * address, no device key to sign with, or an address that is not a relay
 * route.
 */
export function relayRouteFor(input: {
  readonly choice: PairedHostRelayChoice | undefined;
  readonly signer?: {
    readonly targetMemberId: string;
    readonly admit: ListenerRelayRoute["admit"];
  };
}): ListenerRelayRoute | undefined {
  const address = input.choice?.address;
  if (input.choice?.enabled !== true || address === undefined || input.signer === undefined) {
    return undefined;
  }
  if (!isRelayUrl(address.relayUrl)) return undefined;
  return {
    url: address.relayUrl,
    targetMemberId: input.signer.targetMemberId,
    hubMemberId: String(address.hubMemberId),
    admit: input.signer.admit,
  };
}

/**
 * What the host's private route told this device, as the address to keep:
 * undefined when the host lets no relay through for it, and also when the
 * answer is a refusal (the route was asked through the relay) or does not
 * read, so a device never learns an address anywhere but at home.
 */
export async function relayAddressFromResponse(
  response: Response,
): Promise<RelayAddress | undefined | "unchanged"> {
  if (response.status !== 200) return "unchanged";
  try {
    const answer = decodeRemoteRelayAddressAnswer(await response.json());
    return answer.status === "available"
      ? { hubMemberId: answer.hubMemberId, relayUrl: answer.relayUrl }
      : undefined;
  } catch {
    return "unchanged";
  }
}

export { REMOTE_RELAY_ADDRESS_PATH };

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** How long a device that found its host unreachable goes to the relay first before trying home again. */
export const RELAY_AWAY_MS = 60_000;

/**
 * A `fetch` to one paired host that tries the private network and, only when
 * that failed before sending anything, the hub's relay. `relayed` is asked at
 * each failure, so a choice turned off takes effect at once. Once the direct
 * path failed and the relay answered, requests go to the relay first for a
 * minute, so a device away from home does not wait out a dial each time; the
 * relay failing sends them home again.
 */
export function createRelayFallbackFetch(input: {
  readonly direct: Fetch;
  readonly relayed: () => Fetch | undefined;
  readonly now?: () => number;
}): Fetch {
  const now = input.now ?? Date.now;
  let awayUntil = 0;
  return async (request, init) => {
    const relayed = input.relayed();
    if (relayed !== undefined && now() < awayUntil) {
      try {
        return await relayed(request, init);
      } catch (error) {
        if (!(error instanceof ListenerUnreachable)) throw error;
        awayUntil = 0;
      }
    }
    try {
      return await input.direct(request, init);
    } catch (error) {
      if (!(error instanceof ListenerUnreachable)) throw error;
      const relay = input.relayed();
      if (relay === undefined) throw error;
      const response = await relay(request, init);
      awayUntil = now() + RELAY_AWAY_MS;
      return response;
    }
  };
}
