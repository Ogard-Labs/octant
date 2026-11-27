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
import {
  parseRelayAdmissionPayload,
  type ListenerRelayRoute,
  type RelayAdmissionSignature,
} from "./relayTunnel";
import type { RemoteDeviceKeyStore } from "./remotePairingClient";
import type { HostFederationTransports } from "./hostFederationTransports";
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

/**
 * Asks every connected paired host where its hub's relay is, and hands each
 * answer to `remember`. A host reached through the relay refuses the route,
 * which leaves what was kept unchanged, so the address is learned only at
 * home. One host failing never stops the others.
 */
export async function learnRelayAddresses(input: {
  readonly transports: Pick<HostFederationTransports, "list" | "remoteTransportFor">;
  readonly remember: (origin: string, address: RelayAddress | undefined) => void | Promise<void>;
}): Promise<void> {
  await Promise.allSettled(
    input.transports.list().map(async (slot) => {
      const origin = slot.origin;
      const transport = input.transports.remoteTransportFor(slot.hostId);
      if (origin === undefined || transport === undefined) return;
      const learned = await relayAddressFromResponse(
        await transport.authenticatedFetch({ method: "GET", path: REMOTE_RELAY_ADDRESS_PATH }),
      );
      if (learned !== "unchanged") await input.remember(origin, learned);
    }),
  );
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** How long a device that found its host unreachable goes to the relay first before trying home again. */
export const RELAY_AWAY_MS = 60_000;

/**
 * What a device remembers about one host between requests: until when it goes
 * to the relay first. A caller that builds a fetch per request keeps one of
 * these per host and drops it when the pairing, the choice, or the stored
 * relay address changes.
 */
export interface RelayAwayMemory {
  until: number;
}

export function createRelayAwayMemory(): RelayAwayMemory {
  return { until: 0 };
}

/**
 * A `fetch` to one paired host that tries the private network and, only when
 * that failed before sending anything, the hub's relay. `relayed` is asked at
 * each failure, so a choice turned off takes effect at once. Once the direct
 * path failed and the relay answered, requests go to the relay first for a
 * minute, so a device away from home does not wait out a dial each time; the
 * relay failing sends them home again. A request that may have left through
 * the relay fails rather than being sent a second time.
 */
export function createRelayFallbackFetch(input: {
  readonly direct: Fetch;
  readonly relayed: () => Fetch | undefined;
  readonly now?: () => number;
  /** Shared by every fetch built for the same host; absent, this fetch keeps its own. */
  readonly away?: RelayAwayMemory;
}): Fetch {
  const now = input.now ?? Date.now;
  const away = input.away ?? createRelayAwayMemory();
  return async (request, init) => {
    const relayed = now() < away.until ? input.relayed() : undefined;
    if (relayed !== undefined) {
      try {
        return await relayed(request, init);
      } catch (error) {
        // A request the caller gave up on says nothing about the relay.
        if (init?.signal?.aborted !== true) away.until = 0;
        if (!(error instanceof ListenerUnreachable)) throw error;
      }
    }
    try {
      return await input.direct(request, init);
    } catch (error) {
      if (!(error instanceof ListenerUnreachable)) throw error;
      const relay = input.relayed();
      if (relay === undefined) throw error;
      const response = await relay(request, init);
      away.until = now() + RELAY_AWAY_MS;
      return response;
    }
  };
}

/**
 * The device key's side of a relay admission, for the process that holds the
 * key (the desktop window, the phone). It signs only text that reads exactly
 * as `octant/relay/v1|<challenge>|<host>|<hub>`, only for the origin it is
 * asked about, and only when that origin's pairing is with the host the text
 * names; anything else is undefined and nothing is signed. The key never
 * leaves: the answer is the signature and the key's public SPKI.
 */
export function createRelayAdmissionSigner(
  store: Pick<RemoteDeviceKeyStore, "findByOrigin" | "get">,
): (request: {
  readonly origin: unknown;
  readonly payload: unknown;
}) => Promise<RelayAdmissionSignature | undefined> {
  return async (request) => {
    const parsed = parseRelayAdmissionPayload(request.payload);
    if (parsed === undefined || typeof request.origin !== "string") return undefined;
    const record = await store.findByOrigin(request.origin);
    if (record === undefined || String(record.hostId) !== parsed.targetMemberId) return undefined;
    const keyPair = await store.get(record.keyId);
    if (keyPair === undefined) return undefined;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      new TextEncoder().encode(request.payload as string),
    );
    const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    return {
      signature: base64Url(new Uint8Array(signature)),
      deviceSpki: base64Url(new Uint8Array(spki)),
    };
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
