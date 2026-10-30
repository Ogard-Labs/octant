import { Schema } from "effect";
import { RemotePushPlatform } from "./remotePushNotifications";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

// A hub that sends notifications directly is the push gateway for a phone app
// its person built with their own Apple and Firebase credentials. The wire
// shapes it serves are the push gateway's (`remotePushNotifications.ts`); these
// are the person's acts in a window on the hub.

/** Which Apple push service a build talks to: App Store and TestFlight builds use production. */
export const HubDirectPushEnvironment = Schema.Literal("production", "development");
export type HubDirectPushEnvironment = typeof HubDirectPushEnvironment.Type;

/** Whether the hub holds a platform's credential. The credential itself is never returned. */
export const HubDirectPushCredentialState = Schema.Literal("stored", "not-stored");
export type HubDirectPushCredentialState = typeof HubDirectPushCredentialState.Type;

export const HubDirectPushSwitchRequest = Schema.Struct({ enabled: Schema.Boolean }).annotations(
  strict,
);
export type HubDirectPushSwitchRequest = typeof HubDirectPushSwitchRequest.Type;
export const decodeHubDirectPushSwitchRequest = Schema.decodeUnknownSync(
  HubDirectPushSwitchRequest,
);

export const HubDirectPushEnvironmentRequest = Schema.Struct({
  environment: HubDirectPushEnvironment,
}).annotations(strict);
export type HubDirectPushEnvironmentRequest = typeof HubDirectPushEnvironmentRequest.Type;
export const decodeHubDirectPushEnvironmentRequest = Schema.decodeUnknownSync(
  HubDirectPushEnvironmentRequest,
);

/** The most a credential may weigh: a `.p8` key or a service-account file is a few KiB. */
export const HUB_DIRECT_PUSH_CREDENTIAL_MAX_BYTES = 8_192;

const credentialText = Schema.String.pipe(
  Schema.filter(
    (value) => new TextEncoder().encode(value).byteLength <= HUB_DIRECT_PUSH_CREDENTIAL_MAX_BYTES,
  ),
);

/**
 * Store a platform's credential. Apple: the `.p8` key's text with its key id,
 * team id and the app's bundle id. Google: the service-account JSON file's text.
 * Entering one replaces the stored one.
 */
export const HubDirectPushCredentialRequest = Schema.Union(
  Schema.Struct({
    platform: Schema.Literal("ios"),
    keyId: Schema.String.pipe(Schema.pattern(/^[A-Z0-9]{10}$/)),
    teamId: Schema.String.pipe(Schema.pattern(/^[A-Z0-9]{10}$/)),
    bundleId: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/)),
    privateKey: credentialText,
  }).annotations(strict),
  Schema.Struct({
    platform: Schema.Literal("android"),
    serviceAccount: credentialText,
  }).annotations(strict),
);
export type HubDirectPushCredentialRequest = typeof HubDirectPushCredentialRequest.Type;
export const decodeHubDirectPushCredentialRequest = Schema.decodeUnknownSync(
  HubDirectPushCredentialRequest,
);

export const HubDirectPushCredentialRemoveRequest = Schema.Struct({
  platform: RemotePushPlatform,
}).annotations(strict);
export type HubDirectPushCredentialRemoveRequest = typeof HubDirectPushCredentialRemoveRequest.Type;
export const decodeHubDirectPushCredentialRemoveRequest = Schema.decodeUnknownSync(
  HubDirectPushCredentialRemoveRequest,
);

/** What Settings and `octant hub status` show: the switch, the environment, and two words. */
export const HubDirectPushStatus = Schema.Struct({
  enabled: Schema.Boolean,
  environment: HubDirectPushEnvironment,
  ios: HubDirectPushCredentialState,
  android: HubDirectPushCredentialState,
}).annotations(strict);
export type HubDirectPushStatus = typeof HubDirectPushStatus.Type;
