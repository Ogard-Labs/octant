import { Schema } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeThreadId } from "./code";
import { LocalServerPort, LocalServerRequestId } from "./localServers";
import { ProjectId } from "./projects";
import { DeviceId } from "./remoteAccess";
import { RemoteServerGrantSource } from "./remoteServerGrants";

/**
 * One port on a paired computer's own loopback that a device may reach as raw
 * TCP for an hour, through its proxy session (slice 10 of hub and spokes). A
 * device the computer's person paired may name any port, so a database or any
 * other TCP service can be reached. A device only the hub introduced names a
 * thread's listed server instead, and the computer takes the port from it.
 */
export const RemotePortForwardId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^rpf_[a-f0-9]{64}$/)),
  Schema.brand("RemotePortForwardId"),
);
export type RemotePortForwardId = typeof RemotePortForwardId.Type;

/**
 * Either a port the person picks, or a thread's listed server named as a grant
 * names it (a thread's Local servers row or a Running services row). A request
 * naming a server carries no port: the computer re-observes the listing and
 * forwards the port its server holds, never one the client sent.
 */
export const RemotePortForwardRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("open-remote-port-forward"),
    requestId: LocalServerRequestId,
    port: LocalServerPort,
  }),
  Schema.Struct({
    kind: Schema.Literal("open-remote-port-forward"),
    requestId: LocalServerRequestId,
    source: RemoteServerGrantSource,
  }),
]);
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
});
export type RemotePortForward = typeof RemotePortForward.Type;

/**
 * - `not-the-person`: an agent grant forwards no port.
 * - `source-required`: a device only the hub introduced named a port rather than
 *   a thread's listed server.
 * - `outside-act`: the member's Act item does not let such a device act in the
 *   server's Project, or this computer is in no hub.
 * - `thread-unreadable`, `not-found`, `not-octant-owned`, `not-in-thread`,
 *   `not-listening`, `open-denied`: the named server cannot leave the computer,
 *   by the same rules a server grant follows.
 * - `unavailable`: the computer could not look at its servers; nothing was decided.
 * - `forward-limit`: the device or the host already holds as many as allowed.
 */
export const RemotePortForwardResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("remote-port-forward-opened"),
    requestId: LocalServerRequestId,
    forward: RemotePortForward,
  }),
  Schema.Struct({
    kind: Schema.Literal("remote-port-forward-refused"),
    requestId: LocalServerRequestId,
    reason: Schema.Literals([
      "not-the-person",
      "source-required",
      "outside-act",
      "thread-unreadable",
      "not-found",
      "not-octant-owned",
      "not-in-thread",
      "not-listening",
      "open-denied",
      "unavailable",
      "forward-limit",
    ]),
    message: NonEmptyTrimmedString,
  }),
]);
export type RemotePortForwardResult = typeof RemotePortForwardResult.Type;

export const REMOTE_PORT_FORWARD_OPENED = "remote-server.forward-opened@1" as const;
/** A forward of a thread's listed server, which also names the thread and its Project. */
export const REMOTE_PORT_FORWARD_OPENED_V2 = "remote-server.forward-opened@2" as const;
export const REMOTE_PORT_FORWARD_CLOSED = "remote-server.forward-closed@1" as const;

/** Journaled with the device and the port, never an address or what travels. */
export const RemotePortForwardOpenedPayload = Schema.Struct({
  forwardId: RemotePortForwardId,
  deviceId: DeviceId,
  port: LocalServerPort,
});
export type RemotePortForwardOpenedPayload = typeof RemotePortForwardOpenedPayload.Type;

/** As version 1, plus the thread whose server holds the port and that thread's Project. */
export const RemotePortForwardOpenedPayloadV2 = Schema.Struct({
  forwardId: RemotePortForwardId,
  deviceId: DeviceId,
  port: LocalServerPort,
  threadId: CodeThreadId,
  projectId: ProjectId,
});
export type RemotePortForwardOpenedPayloadV2 = typeof RemotePortForwardOpenedPayloadV2.Type;

/**
 * `outside-act`: the member's Act item stopped naming the server's Project, or
 * was unticked. `server-gone`: the thread's server no longer holds the port, or
 * the device can no longer open servers in that thread. Both are found when the
 * device opens its next connection.
 */
export const RemotePortForwardCloseReason = Schema.Literals([
  "expired",
  "proxy-session-ended",
  "device-revoked",
  "host-stopped",
  "outside-act",
  "server-gone",
]);
export type RemotePortForwardCloseReason = typeof RemotePortForwardCloseReason.Type;

export const RemotePortForwardClosedPayload = Schema.Struct({
  forwardId: RemotePortForwardId,
  deviceId: DeviceId,
  port: LocalServerPort,
  reason: RemotePortForwardCloseReason,
});
export type RemotePortForwardClosedPayload = typeof RemotePortForwardClosedPayload.Type;

export const decodeRemotePortForwardRequest = Schema.decodeUnknownSync(
  RemotePortForwardRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeRemotePortForwardResult = Schema.decodeUnknownSync(
  RemotePortForwardResult,
  STRICT_DECODE_OPTIONS,
);
export const encodeRemotePortForwardResult = Schema.encodeSync(RemotePortForwardResult);
export const decodeRemotePortForwardId = Schema.decodeUnknownSync(
  RemotePortForwardId,
  STRICT_DECODE_OPTIONS,
);
export const decodeRemotePortForwardOpenedPayload = Schema.decodeUnknownSync(
  RemotePortForwardOpenedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeRemotePortForwardOpenedPayloadV2 = Schema.decodeUnknownSync(
  RemotePortForwardOpenedPayloadV2,
  STRICT_DECODE_OPTIONS,
);
