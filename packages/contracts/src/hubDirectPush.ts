import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { RemotePushPlatform } from "./remotePushNotifications";

// A hub that sends notifications directly is the push gateway for a phone app
// its person built with their own Apple and Firebase credentials. The wire
// shapes it serves are the push gateway's (`remotePushNotifications.ts`); these
// are the person's acts in a window on the hub.

/** Which Apple push service a build talks to: App Store and TestFlight builds use production. */
export const HubDirectPushEnvironment = Schema.Literals(["production", "development"]);
export type HubDirectPushEnvironment = typeof HubDirectPushEnvironment.Type;

/** Whether the hub holds a platform's credential. The credential itself is never returned. */
export const HubDirectPushCredentialState = Schema.Literals(["stored", "not-stored"]);
export type HubDirectPushCredentialState = typeof HubDirectPushCredentialState.Type;

export const HubDirectPushSwitchRequest = Schema.Struct({ enabled: Schema.Boolean });
export type HubDirectPushSwitchRequest = typeof HubDirectPushSwitchRequest.Type;
export const decodeHubDirectPushSwitchRequest = Schema.decodeUnknownSync(
  HubDirectPushSwitchRequest,
  STRICT_DECODE_OPTIONS,
);

export const HubDirectPushEnvironmentRequest = Schema.Struct({
  environment: HubDirectPushEnvironment,
});
export type HubDirectPushEnvironmentRequest = typeof HubDirectPushEnvironmentRequest.Type;
export const decodeHubDirectPushEnvironmentRequest = Schema.decodeUnknownSync(
  HubDirectPushEnvironmentRequest,
  STRICT_DECODE_OPTIONS,
);

/** The most a credential may weigh: a `.p8` key or a service-account file is a few KiB. */
export const HUB_DIRECT_PUSH_CREDENTIAL_MAX_BYTES = 8_192;

const credentialText = Schema.String.check(
  Schema.makeFilter(
    (value) => new TextEncoder().encode(value).byteLength <= HUB_DIRECT_PUSH_CREDENTIAL_MAX_BYTES,
  ),
);

/**
 * Store a platform's credential. Apple: the `.p8` key's text with its key id,
 * team id and the app's bundle id. Google: the service-account JSON file's text.
 * Entering one replaces the stored one.
 */
export const HubDirectPushCredentialRequest = Schema.Union([
  Schema.Struct({
    platform: Schema.Literal("ios"),
    keyId: Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10}$/)),
    teamId: Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10}$/)),
    bundleId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/)),
    privateKey: credentialText,
  }),
  Schema.Struct({
    platform: Schema.Literal("android"),
    serviceAccount: credentialText,
  }),
]);
export type HubDirectPushCredentialRequest = typeof HubDirectPushCredentialRequest.Type;
export const decodeHubDirectPushCredentialRequest = Schema.decodeUnknownSync(
  HubDirectPushCredentialRequest,
  STRICT_DECODE_OPTIONS,
);

export const HubDirectPushCredentialRemoveRequest = Schema.Struct({
  platform: RemotePushPlatform,
});
export type HubDirectPushCredentialRemoveRequest = typeof HubDirectPushCredentialRemoveRequest.Type;
export const decodeHubDirectPushCredentialRemoveRequest = Schema.decodeUnknownSync(
  HubDirectPushCredentialRemoveRequest,
  STRICT_DECODE_OPTIONS,
);

/** What Settings and `octant hub status` show: the switch, the environment, and two words. */
export const HubDirectPushStatus = Schema.Struct({
  enabled: Schema.Boolean,
  environment: HubDirectPushEnvironment,
  ios: HubDirectPushCredentialState,
  android: HubDirectPushCredentialState,
});
export type HubDirectPushStatus = typeof HubDirectPushStatus.Type;
