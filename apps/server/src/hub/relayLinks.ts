// The member-to-member requests behind the device relay, each signed with this
// host's identity key over the pinned private transport: a host handing the hub
// the device keys it lets through, and the hub opening one device's tunnel on
// that host as a WebSocket whose upgrade the host checks like any hub request.

import type { HubRelayDevicesUpdate } from "@octant/contracts";
import { WebSocketEndpoint, newWebSocketKey, webSocketAcceptFor } from "../webSocketRelay";
import { listenerPinFromDigest } from "./hubCrypto";
import {
  HUB_LINK_HEADER,
  HUB_PEER_KEY_HEADER,
  sendHubLinkRequest,
  signHubLinkRequest,
} from "./hubLink";
import { HUB_LINK_ROUTES, HUB_RELAY_TUNNEL_PREFIX } from "./hubLinkRoutes";
import type { HubHostIdentity } from "./hubService";
import type { HubStatePort } from "./hubStateStore";
import { memberOrigin } from "./memberOrigin";
import { openPinnedSocket, type HubNetwork, type HubTransport } from "./pinnedHubTransport";
import { RELAY_MAX_MESSAGE_BYTES, type RelayTunnelEnd } from "./hubRelayService";
import type { SpokeRelayHubPort } from "./spokeRelayService";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_BYTES = 8 * 1024;

interface LinkDependencies {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  readonly now: () => number;
}

/** What a host reaches its hub through for the relay; the hub alone, never a standby. */
export function spokeRelayHubPort(deps: LinkDependencies): SpokeRelayHubPort {
  return {
    sendDevices: async (update: HubRelayDevicesUpdate) => {
      const link = deps.state.load().link;
      if (link === undefined || link.removed === true) return false;
      const identity = deps.identity();
      const answer = await sendHubLinkRequest({
        transport: deps.transport,
        target: { origin: link.hubOrigin, pin: listenerPinFromDigest(link.hubListenerPin) },
        signHostPayload: identity.signing.signHostPayload,
        senderMemberId: String(link.selfMemberId),
        recipientMemberId: String(link.hubMemberId),
        method: "POST",
        path: HUB_LINK_ROUTES.publicRelayDevices,
        body: JSON.stringify(update),
        headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
        now: deps.now(),
      });
      return answer.status === "answered" && answer.response.ok;
    },
  };
}

/**
 * Opens one device's tunnel on a roster member: a pinned TLS connection to its
 * listener, a signed WebSocket upgrade naming the device key's fingerprint, and
 * the socket handed over once the member accepted. Undefined for anything else.
 */
export async function openRelayTunnel(
  deps: LinkDependencies & {
    readonly selfMemberId: () => string;
    readonly network?: HubNetwork;
  },
  targetMemberId: string,
  deviceFingerprint: string,
): Promise<RelayTunnelEnd | undefined> {
  const state = deps.state.load();
  // Only the hub's own roster: a relay never runs through a standby.
  const member = state.hub?.roster?.roster.members.find(
    (entry) => String(entry.memberId) === targetMemberId,
  );
  if (member === undefined || member.role === "guest") return undefined;
  const origin =
    state.hub?.members.find((record) => String(record.memberId) === targetMemberId)
      ?.listenerOrigin ?? memberOrigin(member);
  if (origin === undefined) return undefined;
  let socket;
  try {
    socket = await openPinnedSocket(
      { origin, pin: listenerPinFromDigest(member.listenerPin) },
      deps.network,
    );
  } catch {
    return undefined;
  }
  const identity = deps.identity();
  const path = `${HUB_RELAY_TUNNEL_PREFIX}${deviceFingerprint}`;
  const key = newWebSocketKey();
  const header = signHubLinkRequest({
    signHostPayload: identity.signing.signHostPayload,
    senderMemberId: deps.selfMemberId(),
    recipientMemberId: targetMemberId,
    method: "GET",
    path,
    body: "",
    now: deps.now(),
  });
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: ${new URL(origin).host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      `${HUB_LINK_HEADER}: ${header}`,
      `${HUB_PEER_KEY_HEADER}: ${identity.signing.hostPublicKey}`,
      "",
      "",
    ].join("\r\n"),
  );
  const answer = await new Promise<{ readonly head: string; readonly rest: Buffer } | undefined>(
    (resolve) => {
      let received = Buffer.alloc(0);
      const finish = (value: { readonly head: string; readonly rest: Buffer } | undefined) => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("close", onClose);
        resolve(value);
      };
      const onData = (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        const split = received.indexOf("\r\n\r\n");
        if (split >= 0) {
          finish({
            head: received.subarray(0, split).toString("latin1"),
            rest: received.subarray(split + 4),
          });
        } else if (received.byteLength > MAX_HANDSHAKE_BYTES) {
          finish(undefined);
        }
      };
      const onClose = () => finish(undefined);
      const timer = setTimeout(() => finish(undefined), HANDSHAKE_TIMEOUT_MS);
      socket.on("data", onData);
      socket.once("close", onClose);
    },
  );
  const lines = answer?.head.split("\r\n") ?? [];
  const accepted =
    (lines[0] ?? "").startsWith("HTTP/1.1 101 ") &&
    lines.some(
      (line) =>
        line.toLowerCase() === `sec-websocket-accept: ${webSocketAcceptFor(key)}`.toLowerCase(),
    );
  if (answer === undefined || !accepted) {
    socket.destroy();
    return undefined;
  }
  socket.pause();
  return {
    endpoint: new WebSocketEndpoint(socket, "client", RELAY_MAX_MESSAGE_BYTES),
    head: answer.rest,
  };
}
