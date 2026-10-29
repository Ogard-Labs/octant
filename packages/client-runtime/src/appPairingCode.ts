// Pairing from an app pairing code, shared by every Octant app that reads one:
// take the listener origin, ticket, and pin from the code, reach the listener
// only through a transport held to that pin, verify the host hello against a
// client nonce, and claim the ticket. Each platform supplies the pinned
// transport; this module never falls back to the platform's own `fetch`.

import type { HostHelloV1 } from "@octant/contracts/remote-access";
import {
  PAIRING_CODE_REFUSAL_COPY,
  readPairingCode,
  type PairingCodeRefusal,
} from "@octant/domain";
import {
  createRemotePairingClient,
  isRemotePairingFailure,
  type RemoteDeviceKeyStore,
  type RemotePairingClaim,
  type RemotePairingClient,
  type RemotePairingTicket,
} from "./remotePairingClient";
import {
  LISTENER_TRUST_REFUSAL_COPY,
  ListenerTrustRefused,
  type ListenerOriginTrust,
  type ListenerTrust,
  type ListenerTrustRefusal,
} from "./remoteListenerTrust";

export type AppPairingCodeReading =
  | {
      readonly status: "read";
      readonly origin: string;
      readonly ticket: RemotePairingTicket;
      /** Always pinned: a code carries the listener's key pin. */
      readonly listenerTrust: ListenerTrust;
    }
  | { readonly status: "refused"; readonly reason: PairingCodeRefusal; readonly message: string };

/** Reads a pasted or scanned app pairing code into what a client needs to pair. */
export function readAppPairingCode(text: string): AppPairingCodeReading {
  const reading = readPairingCode(text);
  if (reading.status === "refused") {
    return {
      status: "refused",
      reason: reading.reason,
      message: PAIRING_CODE_REFUSAL_COPY[reading.reason],
    };
  }
  const { origin, ticketId, ticketProof, pin } = reading.contents;
  return {
    status: "read",
    origin,
    ticket: { ticketId, ticketProof },
    listenerTrust: { kind: "pinned", pin },
  };
}

/**
 * How a client reaches a pinned origin. Its `fetch` must check the served key
 * against the trust before it sends a byte and throw `ListenerTrustRefused`
 * on a refusal. A client without such a transport says so, and pairing stops.
 */
export type PinnedListenerTransport =
  | { readonly status: "available"; readonly fetch: typeof globalThis.fetch }
  | { readonly status: "unavailable" };

export type PinnedListenerTransportPort = (input: {
  readonly origin: string;
  readonly trust: ListenerOriginTrust;
}) => PinnedListenerTransport;

export type AppPairingCodeRefusal =
  | PairingCodeRefusal
  | ListenerTrustRefusal
  /** This client cannot hold a connection to a pin yet. */
  | "no-pinned-transport";

export const NO_PINNED_TRANSPORT_COPY =
  "This version of the app can't check that computer's own certificate yet, so it stopped before sending anything. Pair from the Octant desktop app, or give that computer's listener a Tailscale certificate or your own and pair with its link.";

type Refused = {
  readonly status: "refused";
  readonly reason: AppPairingCodeRefusal;
  readonly message: string;
};
type Failed = { readonly status: "failed"; readonly message: string };

/** A code whose host proved its identity over a connection that passed the pin. */
export interface OpenedAppPairingCode {
  readonly status: "opened";
  readonly origin: string;
  readonly ticket: RemotePairingTicket;
  readonly listenerTrust: ListenerTrust;
  readonly hostHello: HostHelloV1;
  /** The pairing client over the pinned transport; poll approval with it. */
  readonly client: RemotePairingClient;
  /** Claims the code's ticket with a new device key, through the verified hello. */
  readonly claim: (
    deviceLabel: string,
  ) => Promise<
    { readonly status: "claimed"; readonly claim: RemotePairingClaim } | Refused | Failed
  >;
}

export interface OpenAppPairingCodeOptions {
  readonly code: string;
  readonly transport: PinnedListenerTransportPort;
  readonly webBuildVersion: string;
  readonly deviceKeyStore?: RemoteDeviceKeyStore;
  readonly now?: () => number;
}

/**
 * Reads the code, then asks its host for a hello over the pinned transport
 * and verifies it against a fresh client nonce. Nothing reaches the host
 * before the code reads cleanly and the transport accepts the served key.
 */
export async function openAppPairingCode(
  options: OpenAppPairingCodeOptions,
): Promise<OpenedAppPairingCode | Refused | Failed> {
  const reading = readAppPairingCode(options.code);
  if (reading.status === "refused") return reading;
  return openPairingTicket({ ...options, ...reading });
}

/**
 * Opens a ticket at an origin under a stated trust. A client that holds pins
 * passes the code's pinned trust; a browser, which cannot check a pin, passes
 * the origin that served its page and the platform's own certificate check.
 */
export async function openPairingTicket(
  options: Omit<OpenAppPairingCodeOptions, "code"> & {
    readonly origin: string;
    readonly ticket: RemotePairingTicket;
    readonly listenerTrust: ListenerTrust;
  },
): Promise<OpenedAppPairingCode | Refused | Failed> {
  const reading = options;
  const transport = options.transport({
    origin: reading.origin,
    trust: { current: reading.listenerTrust },
  });
  if (transport.status === "unavailable") {
    return { status: "refused", reason: "no-pinned-transport", message: NO_PINNED_TRANSPORT_COPY };
  }
  // The pairing client reports any transport error as an unreachable host;
  // the refusal is kept here so the person reads why Octant stopped.
  let transportRefusal: ListenerTrustRefusal | undefined;
  const pinnedFetch: typeof globalThis.fetch = async (input, init) => {
    try {
      return await transport.fetch(input, init);
    } catch (error) {
      if (error instanceof ListenerTrustRefused) transportRefusal = error.reason;
      throw error;
    }
  };
  const refusedOrFailed = (error: unknown): Refused | Failed => {
    if (transportRefusal !== undefined) {
      return {
        status: "refused",
        reason: transportRefusal,
        message: LISTENER_TRUST_REFUSAL_COPY[transportRefusal],
      };
    }
    return {
      status: "failed",
      message: isRemotePairingFailure(error) ? error.message : "Octant host is unreachable.",
    };
  };
  const client = createRemotePairingClient({
    baseUrl: `${reading.origin}/`,
    fetch: pinnedFetch,
    webBuildVersion: options.webBuildVersion,
    listenerTrust: reading.listenerTrust,
    ...(options.deviceKeyStore === undefined ? {} : { deviceKeyStore: options.deviceKeyStore }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  let hostHello: HostHelloV1;
  try {
    hostHello = await client.requestHostHello();
  } catch (error) {
    return refusedOrFailed(error);
  }
  return {
    status: "opened",
    origin: reading.origin,
    ticket: reading.ticket,
    listenerTrust: reading.listenerTrust,
    hostHello,
    client,
    claim: async (deviceLabel) => {
      try {
        const claim = await client.claimPairing({
          ticket: reading.ticket,
          deviceLabel,
          hostHello,
        });
        return { status: "claimed", claim };
      } catch (error) {
        return refusedOrFailed(error);
      }
    },
  };
}
