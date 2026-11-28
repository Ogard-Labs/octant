import { Schema } from "effect";
import { PushMessageV2, RemotePushPlatform, RemotePushToken } from "./remotePushNotifications";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The most a spoke may hand the hub for one notification. A v2 handoff holds a
 * platform, a push token, and one checked push message (alert or live status),
 * well below this bound.
 */
export const HUB_PUSH_BODY_MAX_BYTES = 16_384;

/**
 * Direct-push handoff from a spoke to its hub (v2). The spoke sends the phone's
 * platform, token, and checked push message; the hub repeats the secret check
 * against its own held secrets and sends directly to Apple (APNs) or Google
 * (FCM) with its own credentials.
 */
export const HubPushHandoffV2 = Schema.Struct({
  version: Schema.Literal(2),
  platform: RemotePushPlatform,
  token: RemotePushToken,
  message: PushMessageV2,
}).annotations(strict);
export type HubPushHandoffV2 = typeof HubPushHandoffV2.Type;
export const decodeHubPushHandoffV2 = Schema.decodeUnknownSync(HubPushHandoffV2);

/** Outcome returned by the hub after sending directly to APNs or FCM. */
export const HubPushDeliveryOutcome = Schema.Literal(
  "accepted",
  "destination-gone",
  "failed",
  "unavailable",
);
export type HubPushDeliveryOutcome = typeof HubPushDeliveryOutcome.Type;

/** The hub's delivery answer, relayed to the spoke as data. */
export const HubPushAnswer = Schema.Struct({
  status: Schema.Literal("forwarded"),
  outcome: HubPushDeliveryOutcome,
}).annotations(strict);
export type HubPushAnswer = typeof HubPushAnswer.Type;
export const decodeHubPushAnswer = Schema.decodeUnknownSync(HubPushAnswer);

/**
 * Why a push forward or a grant check came to nothing. The journal keeps this
 * word and a size, never a token, payload, or platform error message.
 * Legacy gateway reasons stay in the schema so existing journal entries still
 * replay cleanly.
 */
export const HubPushReason = Schema.Literal(
  "push-service-off",
  "not-a-spoke",
  "not-coordinating",
  "handing-back",
  "malformed",
  "too-large",
  "rate-limited",
  "update-member",
  "sender-off",
  "gateway-off",
  "gateway-mismatch",
  "gateway-unreachable",
  "grant-unconfirmed",
  "push-not-granted",
  "standby-not-granted",
  "hub-reachable",
);
export type HubPushReason = typeof HubPushReason.Type;

/** What a spoke answers when the hub, or a standby, asks whether its grant ticks Push. */
export const HubPushGrantAnswer = Schema.Struct({ status: Schema.Literal("granted") }).annotations(
  strict,
);
export type HubPushGrantAnswer = typeof HubPushGrantAnswer.Type;
export const decodeHubPushGrantAnswer = Schema.decodeUnknownSync(HubPushGrantAnswer);

/** The hub tells a standby whether its push switch is on, so the standby sends only when it is. */
export const HubPushCopy = Schema.Struct({ enabled: Schema.Boolean }).annotations(strict);
export type HubPushCopy = typeof HubPushCopy.Type;
export const decodeHubPushCopy = Schema.decodeUnknownSync(HubPushCopy);

/** The person turning the hub's push switch on or off in a window. */
export const HubPushSwitchRequest = Schema.Struct({ enabled: Schema.Boolean }).annotations(strict);
export type HubPushSwitchRequest = typeof HubPushSwitchRequest.Type;
export const decodeHubPushSwitchRequest = Schema.decodeUnknownSync(HubPushSwitchRequest);

/** How the last forward for one spoke ended, for Settings and `octant hub status`. */
export const HubPushResult = Schema.Literal("forwarded", "refused", "failed");
export type HubPushResult = typeof HubPushResult.Type;
