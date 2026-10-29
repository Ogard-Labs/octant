import { Schema } from "effect";
import { RemotePushGatewayRefusalCode, RemotePushGatewayUrl } from "./remotePushNotifications";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const base64Url = (maximum: number) =>
  Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]+$/), Schema.maxLength(maximum));

/**
 * The most a spoke may hand the hub for one notification. A delivery request is
 * a capability and one sealed envelope, both bounded well below this, so a
 * larger body is not a delivery request at all.
 */
export const HUB_PUSH_BODY_MAX_BYTES = 16_384;

/**
 * One sealed delivery, exactly as the spoke would have sent it to the push
 * gateway: the request body it signed and the three headers the gateway
 * checks. The hub forwards `body` byte for byte with these headers. It never
 * re-signs, because the gateway accepts only the key whose fingerprint the
 * phone sealed into the capability, which is the spoke's.
 *
 * `gatewayUrl` is present only when the spoke's own Notifications setting names
 * a gateway other than the default. The hub forwards to its own configured
 * gateway when it is absent and refuses a name that is not its own.
 */
export const HubPushHandoff = Schema.Struct({
  body: Schema.String.pipe(
    Schema.filter(
      (value) => new TextEncoder().encode(value).byteLength <= HUB_PUSH_BODY_MAX_BYTES,
      {
        message: () => "A sealed delivery request is small.",
      },
    ),
  ),
  hostKey: base64Url(512),
  timestamp: Schema.String.pipe(Schema.maxLength(40)),
  signature: base64Url(256),
  gatewayUrl: Schema.optional(RemotePushGatewayUrl),
}).annotations(strict);
export type HubPushHandoff = typeof HubPushHandoff.Type;
export const decodeHubPushHandoff = Schema.decodeUnknownSync(HubPushHandoff);

/**
 * The gateway's answer, relayed to the spoke as data. The spoke classifies it
 * the way it classifies a gateway answer it received itself.
 */
export const HubPushAnswer = Schema.Struct({
  status: Schema.Literal("forwarded"),
  gatewayStatus: Schema.Int.pipe(Schema.between(100, 599)),
  code: Schema.optional(RemotePushGatewayRefusalCode),
}).annotations(strict);
export type HubPushAnswer = typeof HubPushAnswer.Type;
export const decodeHubPushAnswer = Schema.decodeUnknownSync(HubPushAnswer);

/**
 * Why a push forward or a grant check came to nothing. The journal keeps this
 * word and a size, never a capability, an envelope, or a gateway's message.
 */
export const HubPushReason = Schema.Literal(
  "push-service-off",
  "not-a-spoke",
  "not-coordinating",
  "handing-back",
  "malformed",
  "too-large",
  "rate-limited",
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

/** The hub tells a standby whether its push switch is on, so the standby forwards only when it is. */
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
