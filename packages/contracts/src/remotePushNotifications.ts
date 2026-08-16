import { Schema } from "effect";
import { DeviceId, StableHostId } from "./remoteAccess";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedText = (maximumBytes: number) =>
  Schema.String.pipe(Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes));
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

/** Opaque provider token; never logged by Octant hosts. */
export const RemotePushToken = boundedNonEmptyText(4_096);
export type RemotePushToken = typeof RemotePushToken.Type;

export const RemotePushPlatform = Schema.Literal("ios", "android");
export type RemotePushPlatform = typeof RemotePushPlatform.Type;

export const RemotePushTokenRegistrationV1 = Schema.Struct({
  platform: RemotePushPlatform,
  token: RemotePushToken,
}).annotations(strict);
export type RemotePushTokenRegistrationV1 = typeof RemotePushTokenRegistrationV1.Type;

export const RemotePushTokenClearV1 = Schema.Struct({}).annotations(strict);
export type RemotePushTokenClearV1 = typeof RemotePushTokenClearV1.Type;

export const RemotePushTokenReceiptV1 = Schema.Struct({
  result: Schema.Literal("registered", "already-registered", "cleared", "already-cleared"),
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type RemotePushTokenReceiptV1 = typeof RemotePushTokenReceiptV1.Type;

export const RemotePushNotificationKind = Schema.Literal(
  "completion",
  "waiting",
  "failure",
  "approval-needed",
);
export type RemotePushNotificationKind = typeof RemotePushNotificationKind.Type;

export const RemotePushNotificationMode = Schema.Literal("chat", "work", "code");
export type RemotePushNotificationMode = typeof RemotePushNotificationMode.Type;

/**
 * Redacted lock-screen payload. Hosts must build this via domain policy —
 * never paste prompts, diffs, paths, or secrets into title/body.
 */
export const RemotePushNotificationPayloadV1 = Schema.Struct({
  kind: RemotePushNotificationKind,
  hostId: StableHostId,
  threadId: boundedNonEmptyText(64),
  mode: Schema.optional(RemotePushNotificationMode),
  title: boundedNonEmptyText(80),
  body: boundedText(120),
}).annotations(strict);
export type RemotePushNotificationPayloadV1 = typeof RemotePushNotificationPayloadV1.Type;

export const decodeRemotePushTokenRegistrationV1 = Schema.decodeUnknownSync(
  RemotePushTokenRegistrationV1,
);
export const decodeRemotePushTokenClearV1 = Schema.decodeUnknownSync(RemotePushTokenClearV1);
export const decodeRemotePushTokenReceiptV1 = Schema.decodeUnknownSync(RemotePushTokenReceiptV1);
export const decodeRemotePushNotificationPayloadV1 = Schema.decodeUnknownSync(
  RemotePushNotificationPayloadV1,
);

// Re-export DeviceId usage for registration stores (host-scoped).
export type { DeviceId };
