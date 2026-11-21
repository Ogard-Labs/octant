import { Schema } from "effect";
import { LocalServerPort, LocalServerRequestId } from "./localServers";
import { DeviceId } from "./remoteAccess";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * One port on a paired computer's own loopback that a device the computer's
 * person paired may reach as raw TCP for an hour, through its proxy session
 * (slice 10 of hub and spokes). Unlike a server grant it names no thread: the
 * person picks the port, so a database or any other TCP service can be reached.
 */
export const RemotePortForwardId = Schema.String.pipe(
  Schema.pattern(/^rpf_[a-f0-9]{64}$/),
  Schema.brand("RemotePortForwardId"),
);
export type RemotePortForwardId = typeof RemotePortForwardId.Type;

export const RemotePortForwardRequest = Schema.Struct({
  kind: Schema.Literal("open-remote-port-forward"),
  requestId: LocalServerRequestId,
  port: LocalServerPort,
}).annotations(strict);
export type RemotePortForwardRequest = typeof RemotePortForwardRequest.Type;

/** How long a forward lasts; it also ends with its proxy session or device. */
export const REMOTE_PORT_FORWARD_LIFETIME_MS = 60 * 60 * 1000;
/** How many forwards one device may hold open, and the host across every device. */
export const REMOTE_PORT_FORWARDS_PER_DEVICE = 4;
export const REMOTE_PORT_FORWARDS_PER_HOST = 16;
/** How many connections one forward carries at once. */
export const REMOTE_PORT_FORWARD_CONNECTIONS = 8;

export const RemotePortForward = Schema.Struct({
  forwardId: RemotePortForwardId,
  port: LocalServerPort,
  expiresAt: Schema.Number,
}).annotations(strict);
export type RemotePortForward = typeof RemotePortForward.Type;

/**
 * - `not-the-person`: only a device the computer's own person paired forwards a
 *   port; a hub-introduced device, a restricted device and an agent grant do not.
 * - `forward-limit`: the device or the host already holds as many as allowed.
 */
export const RemotePortForwardResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("remote-port-forward-opened"),
    requestId: LocalServerRequestId,
    forward: RemotePortForward,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remote-port-forward-refused"),
    requestId: LocalServerRequestId,
    reason: Schema.Literal("not-the-person", "forward-limit"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type RemotePortForwardResult = typeof RemotePortForwardResult.Type;

export const REMOTE_PORT_FORWARD_OPENED = "remote-server.forward-opened@1" as const;
export const REMOTE_PORT_FORWARD_CLOSED = "remote-server.forward-closed@1" as const;

/** Journaled with the device and the port, never an address or what travels. */
export const RemotePortForwardOpenedPayload = Schema.Struct({
  forwardId: RemotePortForwardId,
  deviceId: DeviceId,
  port: LocalServerPort,
}).annotations(strict);
export type RemotePortForwardOpenedPayload = typeof RemotePortForwardOpenedPayload.Type;

export const RemotePortForwardCloseReason = Schema.Literal(
  "expired",
  "proxy-session-ended",
  "device-revoked",
  "host-stopped",
);
export type RemotePortForwardCloseReason = typeof RemotePortForwardCloseReason.Type;

export const RemotePortForwardClosedPayload = Schema.Struct({
  forwardId: RemotePortForwardId,
  deviceId: DeviceId,
  port: LocalServerPort,
  reason: RemotePortForwardCloseReason,
}).annotations(strict);
export type RemotePortForwardClosedPayload = typeof RemotePortForwardClosedPayload.Type;

export const decodeRemotePortForwardRequest = Schema.decodeUnknownSync(RemotePortForwardRequest);
export const decodeRemotePortForwardResult = Schema.decodeUnknownSync(RemotePortForwardResult);
export const encodeRemotePortForwardResult = Schema.encodeSync(RemotePortForwardResult);
export const decodeRemotePortForwardId = Schema.decodeUnknownSync(RemotePortForwardId);
export const decodeRemotePortForwardOpenedPayload = Schema.decodeUnknownSync(
  RemotePortForwardOpenedPayload,
);
