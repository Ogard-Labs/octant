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
const nonNegativeInt = Schema.Int.pipe(Schema.greaterThanOrEqualTo(0));
const unpaddedBase64Url = (minimum: number, maximum: number) =>
  Schema.String.pipe(
    Schema.pattern(/^[A-Za-z0-9_-]+$/),
    Schema.minLength(minimum),
    Schema.maxLength(maximum),
  );

/** Opaque platform push token (APNs hex or FCM registration token); never logged by Octant hosts. */
export const RemotePushToken = boundedNonEmptyText(4_096);
export type RemotePushToken = typeof RemotePushToken.Type;

export const RemotePushPlatform = Schema.Literal("ios", "android");
export type RemotePushPlatform = typeof RemotePushPlatform.Type;

/**
 * What one phone wants to hear about, per kind, and whether its lock screen may
 * show thread names (thread titles, project names, and automation names). A
 * device sets only its own; names stay off unless the person turns them on.
 */
export const RemotePushPreferencesV1 = Schema.Struct({
  approvalNeeded: Schema.Boolean,
  waiting: Schema.Boolean,
  failure: Schema.Boolean,
  completion: Schema.Boolean,
  threadTitles: Schema.Boolean,
  /**
   * Whether the phone hears that a new device joined the hub or paired with a
   * host. On unless the phone turned it off: a phone from before the setting
   * sends none and is told (maintainer decision, 2026-11-19).
   */
  newDevices: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type RemotePushPreferencesV1 = typeof RemotePushPreferencesV1.Type;

/**
 * Direct-push token registration (v2). The phone sends its platform token
 * directly over its authenticated session; no gateway capability or notification
 * key is involved. An older phone sending v1 (without `version: 2`, or with
 * `notificationPublicKey`) is refused 400 by the strict schema.
 */
export const RemotePushTokenRegistrationV2 = Schema.Struct({
  version: Schema.Literal(2),
  platform: RemotePushPlatform,
  token: RemotePushToken,
  preferences: RemotePushPreferencesV1,
}).annotations(strict);
export type RemotePushTokenRegistrationV2 = typeof RemotePushTokenRegistrationV2.Type;

export const RemotePushTokenClearV1 = Schema.Struct({}).annotations(strict);
export type RemotePushTokenClearV1 = typeof RemotePushTokenClearV1.Type;

export const RemotePushTokenReceiptV1 = Schema.Struct({
  result: Schema.Literal("registered", "already-registered", "cleared", "already-cleared"),
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type RemotePushTokenReceiptV1 = typeof RemotePushTokenReceiptV1.Type;

/** Why a host cannot deliver push notifications right now. */
export const RemotePushUnavailableReason = Schema.Literal("off", "no-credentials");
export type RemotePushUnavailableReason = typeof RemotePushUnavailableReason.Type;

/**
 * Honest push-delivery availability answered by `GET /api/remote/auth/push-token`.
 * A host without credentials or with direct send switched off reports unavailable
 * and never falls back to a gateway or third-party push service.
 */
export const RemotePushStatusV1 = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("available"),
    /**
     * When the host sends directly, which platforms hold a stored credential.
     * Absent when a spoke delegates delivery to its hub (whose credentials live
     * on the hub).
     */
    platforms: Schema.optional(
      Schema.Struct({
        ios: Schema.Boolean,
        android: Schema.Boolean,
      }).annotations(strict),
    ),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: RemotePushUnavailableReason,
  }).annotations(strict),
);
export type RemotePushStatusV1 = typeof RemotePushStatusV1.Type;

/**
 * The journal records that a device's push registration was added, changed,
 * or cleared, and never the token: the token lives only in the host's
 * owner-only registration file.
 */
export const REMOTE_PUSH_REGISTRATION_EVENT_NAMES = {
  recorded: "remote.push-registration-recorded@1",
  cleared: "remote.push-registration-cleared@1",
} as const;

export const RemotePushRegistrationRecordedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  platform: RemotePushPlatform,
  change: Schema.Literal("added", "changed"),
  recordedAt: UtcTimestamp,
}).annotations(strict);
export type RemotePushRegistrationRecordedV1 = typeof RemotePushRegistrationRecordedV1.Type;

/**
 * Why a registration went: the phone cleared it, its session signed out, the
 * device lost its standing (revoked by the host or by itself, abandoned
 * mid-pairing, expired, or found without an active device record at startup),
 * or the delivery path refused the destination as gone (including legacy v1
 * registrations cleared on upgrade).
 */
export const RemotePushRegistrationClearReason = Schema.Literal(
  "device-cleared",
  "signed-out",
  "self-revoked",
  "device-revoked",
  "pairing-abandoned",
  "credential-expired",
  "device-without-standing",
  "destination-gone",
);
export type RemotePushRegistrationClearReason = typeof RemotePushRegistrationClearReason.Type;

export const RemotePushRegistrationClearedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  reason: RemotePushRegistrationClearReason,
  clearedAt: UtcTimestamp,
}).annotations(strict);
export type RemotePushRegistrationClearedV1 = typeof RemotePushRegistrationClearedV1.Type;

export const RemotePushNotificationKind = Schema.Literal(
  "completion",
  "waiting",
  "failure",
  "approval-needed",
);
export type RemotePushNotificationKind = typeof RemotePushNotificationKind.Type;

export const RemotePushNotificationMode = Schema.Literal("chat", "work", "code");
export type RemotePushNotificationMode = typeof RemotePushNotificationMode.Type;

export const RemotePushMoveWaitingKind = Schema.Literal("move-waiting");
export type RemotePushMoveWaitingKind = typeof RemotePushMoveWaitingKind.Type;

export const RemotePushDeviceJoinedKind = Schema.Literal("device-joined");
export type RemotePushDeviceJoinedKind = typeof RemotePushDeviceJoinedKind.Type;

export const RemotePushAlertKind = Schema.Literal(
  "completion",
  "waiting",
  "failure",
  "approval-needed",
  "move-waiting",
  "device-joined",
);
export type RemotePushAlertKind = typeof RemotePushAlertKind.Type;

export const RemotePushUrgency = Schema.Literal("high", "normal");
export type RemotePushUrgency = typeof RemotePushUrgency.Type;

/**
 * Generic fallback alert sent when the host-side secret check cannot run
 * (for example, when the credential store is locked or unreadable), and shown
 * by the phone when an incoming payload fails validation or belongs to a
 * removed computer.
 */
export const REMOTE_PUSH_PLACEHOLDER_ALERT = {
  title: "Octant",
  body: "A paired computer has an update",
} as const;

/**
 * Direct-push alert payload (v2). Every free-text field is built and checked
 * against credential patterns and held host secrets before leaving the host.
 * Carries only fixed status words, checked short labels, routing IDs, and
 * transport metadata: never transcript text, prompts, tool inputs, paths,
 * diffs, error messages, alertIds, or automation/run IDs.
 */
export const PushAlertV2 = Schema.Struct({
  version: Schema.Literal(2),
  kind: RemotePushAlertKind,
  hostId: StableHostId,
  threadId: Schema.optional(boundedNonEmptyText(64)),
  mode: Schema.optional(RemotePushNotificationMode),
  title: boundedNonEmptyText(80),
  body: boundedText(120),
  collapseId: unpaddedBase64Url(22, 22),
  urgency: RemotePushUrgency,
  sequence: nonNegativeInt,
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type PushAlertV2 = typeof PushAlertV2.Type;

/** Fixed status word for one row of live agent status. */
export const LiveStatusRowState = Schema.Literal(
  "needs-input",
  "approval-needed",
  "failed",
  "working",
  "done",
);
export type LiveStatusRowState = typeof LiveStatusRowState.Type;

export const LiveStatusRowV1 = Schema.Struct({
  threadId: boundedNonEmptyText(64),
  mode: RemotePushNotificationMode,
  status: LiveStatusRowState,
  title: Schema.optional(boundedNonEmptyText(80)),
  projectName: Schema.optional(boundedNonEmptyText(60)),
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type LiveStatusRowV1 = typeof LiveStatusRowV1.Type;

export const LiveStatusCountsV1 = Schema.Struct({
  needsYou: nonNegativeInt,
  failed: nonNegativeInt,
  working: nonNegativeInt,
  done: nonNegativeInt,
}).annotations(strict);
export type LiveStatusCountsV1 = typeof LiveStatusCountsV1.Type;

export const LiveStatusEventV1 = Schema.Literal("start", "update", "end");
export type LiveStatusEventV1 = typeof LiveStatusEventV1.Type;

/**
 * Live Activity / Android Live Update payload (v1): at most five rows ordered
 * needs-you, failed, working, done, plus aggregate counts and staleness time.
 * Every free-text field passes the host secret check; thread titles and project
 * names appear only when "Show thread names" is enabled.
 */
export const LiveStatusV1 = Schema.Struct({
  version: Schema.Literal(1),
  hostId: StableHostId,
  computerName: boundedNonEmptyText(80),
  event: LiveStatusEventV1,
  counts: LiveStatusCountsV1,
  rows: Schema.Array(LiveStatusRowV1).pipe(Schema.maxItems(5)),
  sequence: nonNegativeInt,
  occurredAt: UtcTimestamp,
  staleAt: UtcTimestamp,
  urgency: RemotePushUrgency,
}).annotations(strict);
export type LiveStatusV1 = typeof LiveStatusV1.Type;

/**
 * The one wire union every push transport carries: either an alert notification
 * or a live-status update. Host code obtains a branded instance only from the
 * domain push builder after the host-side secret check has run.
 */
export const PushMessageV2 = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("alert"),
    alert: PushAlertV2,
  }).annotations(strict),
  Schema.Struct({
    type: Schema.Literal("live-status"),
    liveStatus: LiveStatusV1,
  }).annotations(strict),
);
export type PushMessageV2 = typeof PushMessageV2.Type;

/**
 * Journal event recorded whenever a person changes this host's direct push
 * sender switch, Apple environment, or stored platform credentials. Never
 * records any credential value.
 */
export const HOST_PUSH_SENDER_EVENT_NAMES = {
  changed: "host.push-sender-changed@1",
} as const;

export const HostPushSenderChangeKind = Schema.Literal(
  "switch-changed",
  "environment-changed",
  "credential-changed",
  "credential-removed",
);
export type HostPushSenderChangeKind = typeof HostPushSenderChangeKind.Type;

export const HostPushSenderChangedV1 = Schema.Struct({
  change: HostPushSenderChangeKind,
  platform: Schema.optional(RemotePushPlatform),
  recordedAt: UtcTimestamp,
}).annotations(strict);
export type HostPushSenderChangedV1 = typeof HostPushSenderChangedV1.Type;

/**
 * One receipt per notification to one device. The journal holds what was
 * tried and how it ended, never the notification text or token.
 */
export const REMOTE_PUSH_DELIVERY_EVENT_NAMES = {
  recorded: "remote.push-delivery-recorded@1",
} as const;

export const RemotePushDeliveryOutcome = Schema.Literal(
  "delivered",
  "failed",
  "rate-limited",
  "destination-gone",
);
export type RemotePushDeliveryOutcome = typeof RemotePushDeliveryOutcome.Type;

export const RemotePushDeliveryRecordedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  threadId: boundedNonEmptyText(64),
  kind: RemotePushNotificationKind,
  outcome: RemotePushDeliveryOutcome,
  /** A bounded slug such as `provider-unavailable`; never a provider's message. */
  failureCategory: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-z0-9-]{1,64}$/))),
  recordedAt: UtcTimestamp,
}).annotations(strict);
export type RemotePushDeliveryRecordedV1 = typeof RemotePushDeliveryRecordedV1.Type;

/**
 * One receipt per held-move notification to one device. It names no thread
 * and no move: the move's wait lives in memory only, so its id would point at
 * nothing once the wait ends.
 */
export const REMOTE_PUSH_MOVE_WAITING_DELIVERY_EVENT_NAMES = {
  recorded: "remote.push-move-waiting-delivery-recorded@1",
} as const;

export const RemotePushMoveWaitingDeliveryRecordedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  outcome: RemotePushDeliveryOutcome,
  failureCategory: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-z0-9-]{1,64}$/))),
  recordedAt: UtcTimestamp,
}).annotations(strict);
export type RemotePushMoveWaitingDeliveryRecordedV1 =
  typeof RemotePushMoveWaitingDeliveryRecordedV1.Type;

/**
 * One receipt per new-device notification to one device, keyed by the alert
 * it told of. It names neither the new device nor its address: those live in
 * the alert, never in the journal.
 */
export const REMOTE_PUSH_DEVICE_JOINED_DELIVERY_EVENT_NAMES = {
  recorded: "remote.push-device-joined-delivery-recorded@1",
} as const;

export const RemotePushDeviceJoinedDeliveryRecordedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  alertId: Schema.UUID,
  outcome: RemotePushDeliveryOutcome,
  failureCategory: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-z0-9-]{1,64}$/))),
  recordedAt: UtcTimestamp,
}).annotations(strict);
export type RemotePushDeviceJoinedDeliveryRecordedV1 =
  typeof RemotePushDeviceJoinedDeliveryRecordedV1.Type;

export const decodeRemotePushTokenRegistrationV2 = Schema.decodeUnknownSync(
  RemotePushTokenRegistrationV2,
);
export const decodeRemotePushTokenClearV1 = Schema.decodeUnknownSync(RemotePushTokenClearV1);
export const decodeRemotePushTokenReceiptV1 = Schema.decodeUnknownSync(RemotePushTokenReceiptV1);
export const decodeRemotePushStatusV1 = Schema.decodeUnknownSync(RemotePushStatusV1);
export const decodeRemotePushRegistrationRecordedV1 = Schema.decodeUnknownSync(
  RemotePushRegistrationRecordedV1,
);
export const decodeRemotePushRegistrationClearedV1 = Schema.decodeUnknownSync(
  RemotePushRegistrationClearedV1,
);
export const decodePushAlertV2 = Schema.decodeUnknownSync(PushAlertV2);
export const decodeLiveStatusV1 = Schema.decodeUnknownSync(LiveStatusV1);
export const decodePushMessageV2 = Schema.decodeUnknownSync(PushMessageV2);
export const decodeHostPushSenderChangedV1 = Schema.decodeUnknownSync(HostPushSenderChangedV1);
export const decodeRemotePushDeviceJoinedDeliveryRecordedV1 = Schema.decodeUnknownSync(
  RemotePushDeviceJoinedDeliveryRecordedV1,
);
export const decodeRemotePushMoveWaitingDeliveryRecordedV1 = Schema.decodeUnknownSync(
  RemotePushMoveWaitingDeliveryRecordedV1,
);
export const decodeRemotePushDeliveryRecordedV1 = Schema.decodeUnknownSync(
  RemotePushDeliveryRecordedV1,
);

// Re-export DeviceId usage for registration stores (host-scoped).
export type { DeviceId };
