// A paired device's tunnel through its hub's device relay (decision H36),
// with no platform transport of its own: a WebSocket to the hub's public
// relay route, the hub's challenge signed with the device key, and then the
// bytes of the device's own TLS to its host. The hub admits the device only
// when its host listed the key; it reads none of the bytes that follow.
// Desktop main runs it under Node, the phone under React Native.

import {
  RELAY_OPENED_MESSAGE,
  decodeRelayChallenge,
  relayAdmissionPayload,
} from "@octant/contracts";

/**
 * How a paired device reaches its host away from the private network: the
 * hub's public relay route, the host's member id, and the device key it
 * paired with, which signs the hub's challenge (decision H36).
 */
export interface ListenerRelayRoute {
  /** `wss://<front>/relay/v1`; `ws:` only for a test on loopback. */
  readonly url: string;
  readonly targetMemberId: string;
  /**
   * The hub the device expects to relay through, from what its host told it.
   * A challenge naming another hub is refused, so the signature is never
   * spent on one.
   */
  readonly hubMemberId?: string;
  /**
   * Signs the hub's admission text with the device key (P-256, IEEE-P1363,
   * base64url) and names that key's DER SubjectPublicKeyInfo, base64url. The
   * desktop asks its window, which holds the key, for both at once.
   */
  readonly admit: (payload: string) => Promise<RelayAdmissionSignature>;
  readonly timeoutMs?: number;
}

export interface RelayAdmissionSignature {
  readonly signature: string;
  readonly deviceSpki: string;
}

/** An admitted tunnel: bytes written go to the host, bytes the host sends arrive at `data`. */
export interface RelayTunnel {
  readonly send: (bytes: Uint8Array<ArrayBuffer>) => void;
  readonly close: () => void;
}

export interface RelayTunnelEvents {
  readonly data: (bytes: Uint8Array) => void;
  /** The tunnel ended, from either side. Called once. */
  readonly end: () => void;
}

/** The `WebSocket` both Node and React Native provide; only tests replace it. */
export type RelayWebSocketConstructor = new (url: string) => WebSocket;

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Opens a relay through the hub and resolves once the hub admitted the device
 * key; undefined when the hub refused, could not reach the host, or did not
 * answer in time. Nothing the caller sends crosses before that.
 */
export async function openRelayTunnel(
  route: ListenerRelayRoute,
  events: RelayTunnelEvents,
  WebSocketImpl: RelayWebSocketConstructor = globalThis.WebSocket,
): Promise<RelayTunnel | undefined> {
  const socket = new WebSocketImpl(route.url);
  socket.binaryType = "arraybuffer";
  let stage: "challenge" | "opening" | "carrying" | "ended" = "challenge";
  const tunnel: RelayTunnel = {
    send: (bytes) => {
      if (stage === "carrying" && socket.readyState === socket.OPEN) socket.send(bytes);
    },
    close: () => {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
        socket.close(1000);
      }
      finish();
    },
  };
  let settle: ((value: RelayTunnel | undefined) => void) | undefined;
  const finish = (): void => {
    if (stage === "ended") return;
    const wasCarrying = stage === "carrying";
    stage = "ended";
    clearTimeout(timer);
    settle?.(undefined);
    settle = undefined;
    if (wasCarrying) events.end();
  };
  const fail = (): void => {
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
      socket.close();
    }
    finish();
  };
  const timer = setTimeout(fail, route.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return await new Promise<RelayTunnel | undefined>((resolve) => {
    settle = resolve;
    socket.addEventListener("error", fail);
    socket.addEventListener("close", finish);
    socket.addEventListener("message", (event: MessageEvent) => {
      const data: unknown = event.data;
      if (stage === "carrying") {
        if (data instanceof ArrayBuffer) events.data(new Uint8Array(data));
        return;
      }
      if (typeof data !== "string") return fail();
      if (stage === "opening") {
        if (data !== RELAY_OPENED_MESSAGE) return fail();
        stage = "carrying";
        clearTimeout(timer);
        settle = undefined;
        resolve(tunnel);
        return;
      }
      if (stage !== "challenge") return;
      stage = "opening";
      void (async () => {
        const challenge = decodeRelayChallenge(JSON.parse(data));
        if (
          route.hubMemberId !== undefined &&
          String(challenge.hubMemberId) !== route.hubMemberId
        ) {
          fail();
          return;
        }
        const admitted = await route.admit(
          relayAdmissionPayload({
            challenge: challenge.challenge,
            targetMemberId: route.targetMemberId,
            hubMemberId: String(challenge.hubMemberId),
          }),
        );
        if (stage !== "opening") return;
        socket.send(
          JSON.stringify({
            targetMemberId: route.targetMemberId,
            deviceSpki: admitted.deviceSpki,
            signature: admitted.signature,
          }),
        );
      })().catch(fail);
    });
  });
}

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const MEMBER_ID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Reads text a process asks the device key to sign for a relay, and gives
 * back its parts only when it is exactly
 * `octant/relay/v1|<challenge>|<host>|<hub>`: a 43-character base64url
 * challenge and two lowercase member ids. Anything else, however close, is
 * undefined, so a signer that holds the device key never signs a request
 * proof, a pairing claim, or any other text through this door.
 */
export function parseRelayAdmissionPayload(
  text: unknown,
):
  | { readonly challenge: string; readonly targetMemberId: string; readonly hubMemberId: string }
  | undefined {
  if (typeof text !== "string" || text.length > 200) return undefined;
  const parts = text.split("|");
  if (parts.length !== 4 || parts[0] !== "octant/relay/v1") return undefined;
  const [, challenge, targetMemberId, hubMemberId] = parts;
  if (challenge === undefined || targetMemberId === undefined || hubMemberId === undefined) {
    return undefined;
  }
  if (!CHALLENGE.test(challenge) || !MEMBER_ID.test(targetMemberId) || !MEMBER_ID.test(hubMemberId))
    return undefined;
  // Built back from its parts and compared, so no byte of the text is unchecked.
  if (relayAdmissionPayload({ challenge, targetMemberId, hubMemberId }) !== text) return undefined;
  return { challenge, targetMemberId, hubMemberId };
}
