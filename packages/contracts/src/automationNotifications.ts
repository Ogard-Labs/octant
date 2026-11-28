import { Schema } from "effect";
import { NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateVersion, UtcTimestamp } from "./events";
import { HostId } from "./host";
import {
  AutomationId,
  AutomationOpaqueReference,
  AutomationRunId,
  AutomationThreadId,
} from "./automation";
import { RemotePushNotificationKind } from "./remotePushNotifications";

const encoder = new TextEncoder();
const boundedText = (maximumBytes: number) =>
  Schema.String.check(
    Schema.makeFilter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.makeFilter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

/**
 * Automation push kinds reuse the Mobile C redacted kind vocabulary. Approval
 * maps to `approval-needed`; waiting / failure / completion keep the same
 * lock-screen labels as ordinary-thread awareness.
 */
export const AutomationNotificationKind = RemotePushNotificationKind;
export type AutomationNotificationKind = typeof AutomationNotificationKind.Type;

export const AutomationNotificationMode = Schema.Literals(["work", "code"]);
export type AutomationNotificationMode = typeof AutomationNotificationMode.Type;

/**
 * Deep-link target for Automation Center. Pre-dispatch failures stay
 * actionable without inventing a thread id; post-creation states may also
 * carry an ordinary thread id on the payload.
 */
export const AutomationNotificationNavigationTarget = Schema.Struct({
  surface: Schema.Literal("automation-center"),
  automationId: AutomationId,
  runId: AutomationRunId,
});
export type AutomationNotificationNavigationTarget =
  typeof AutomationNotificationNavigationTarget.Type;

/**
 * Redacted Automation lock-screen payload. Hosts must build this via domain
 * policy — never paste prompts, diffs, paths, credentials, provider payloads,
 * or authority receipts into title/body.
 */
export const AutomationNotificationPayloadV1 = Schema.Struct({
  kind: AutomationNotificationKind,
  hostId: HostId,
  automationId: AutomationId,
  automationRunId: AutomationRunId,
  mode: Schema.optional(AutomationNotificationMode),
  threadId: Schema.optional(AutomationThreadId),
  title: boundedNonEmptyText(80),
  body: boundedText(120),
  navigation: AutomationNotificationNavigationTarget,
});
export type AutomationNotificationPayloadV1 = typeof AutomationNotificationPayloadV1.Type;

/** Host-scoped opt-in preferences. Default is fully disabled (privacy-preserving). */
export const AutomationNotificationPreferences = Schema.Struct({
  enabled: Schema.Boolean,
  waiting: Schema.Boolean,
  approvalNeeded: Schema.Boolean,
  failure: Schema.Boolean,
  completion: Schema.Boolean,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
});
export type AutomationNotificationPreferences = typeof AutomationNotificationPreferences.Type;

export const DEFAULT_AUTOMATION_NOTIFICATION_PREFERENCES: Omit<
  AutomationNotificationPreferences,
  "updatedAt"
> = {
  enabled: false,
  waiting: true,
  approvalNeeded: true,
  failure: true,
  completion: true,
  version: 0 as AggregateVersion,
};

export const UpdateAutomationNotificationPreferences = Schema.Struct({
  enabled: Schema.Boolean,
  waiting: Schema.Boolean,
  approvalNeeded: Schema.Boolean,
  failure: Schema.Boolean,
  completion: Schema.Boolean,
  expectedVersion: AggregateVersion,
});
export type UpdateAutomationNotificationPreferences =
  typeof UpdateAutomationNotificationPreferences.Type;

/**
 * Honest delivery availability for local/browser settings and remote clients.
 * Never includes tokens, provider credentials, or host-only secrets.
 */
export const AutomationNotificationProviderDelivery = Schema.Literals(["available", "unavailable"]);
export type AutomationNotificationProviderDelivery =
  typeof AutomationNotificationProviderDelivery.Type;

export const AutomationNotificationDeliveryStatus = Schema.Struct({
  preferences: AutomationNotificationPreferences,
  providerDelivery: AutomationNotificationProviderDelivery,
  registeredDestinationCount: NonNegativeInt,
  deliveryEnabled: Schema.Boolean,
});
export type AutomationNotificationDeliveryStatus = typeof AutomationNotificationDeliveryStatus.Type;

export const AutomationNotificationDeliveryOutcome = Schema.Literals([
  "queued",
  "delivered",
  "failed",
  "cancelled",
  "skipped-preference",
  "skipped-no-destination",
  "skipped-duplicate",
  "exhausted",
]);
export type AutomationNotificationDeliveryOutcome =
  typeof AutomationNotificationDeliveryOutcome.Type;

/**
 * Durable delivery receipt. Opaque refs only — never tokens, prompts, diffs,
 * paths, credentials, provider payloads, or authority receipts.
 */
export const AutomationNotificationDeliveryReceipt = Schema.Struct({
  receiptId: AutomationOpaqueReference,
  automationId: AutomationId,
  runId: AutomationRunId,
  kind: AutomationNotificationKind,
  dedupeKey: boundedNonEmptyText(256),
  outcome: AutomationNotificationDeliveryOutcome,
  attemptCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(32)),
  destinationCount: NonNegativeInt,
  failureCategory: Schema.optional(boundedNonEmptyText(64)),
  recordedAt: UtcTimestamp,
});
export type AutomationNotificationDeliveryReceipt =
  typeof AutomationNotificationDeliveryReceipt.Type;

/**
 * Authenticated delivery query for Automation Center and settings. Combines
 * honest host delivery status with opaque receipts scoped by automation / run /
 * Project. Never includes tokens, credentials, or raw provider payloads.
 */
export const MAX_AUTOMATION_NOTIFICATION_DELIVERY_QUERY = 100;

export const AutomationNotificationDeliveryQueryResponse = Schema.Struct({
  status: AutomationNotificationDeliveryStatus,
  receipts: Schema.Array(AutomationNotificationDeliveryReceipt).check(
    Schema.isMaxLength(MAX_AUTOMATION_NOTIFICATION_DELIVERY_QUERY),
  ),
});
export type AutomationNotificationDeliveryQueryResponse =
  typeof AutomationNotificationDeliveryQueryResponse.Type;

export const AutomationNotificationDeliveryRecorded = Schema.Struct({
  receipt: AutomationNotificationDeliveryReceipt,
});
export type AutomationNotificationDeliveryRecorded =
  typeof AutomationNotificationDeliveryRecorded.Type;

export const AUTOMATION_NOTIFICATION_PREFERENCES_UPDATED =
  "automation-notification-preferences-updated@1" as const;
export const AUTOMATION_NOTIFICATION_DELIVERY_RECORDED =
  "automation-notification-delivery-recorded@1" as const;

export const AUTOMATION_NOTIFICATION_EVENT_NAMES = [
  AUTOMATION_NOTIFICATION_PREFERENCES_UPDATED,
  AUTOMATION_NOTIFICATION_DELIVERY_RECORDED,
] as const;
export type AutomationNotificationEventName = (typeof AUTOMATION_NOTIFICATION_EVENT_NAMES)[number];

export const decodeAutomationNotificationPayloadV1 = Schema.decodeUnknownSync(
  AutomationNotificationPayloadV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationNotificationPreferences = Schema.decodeUnknownSync(
  AutomationNotificationPreferences,
  STRICT_DECODE_OPTIONS,
);
export const decodeUpdateAutomationNotificationPreferences = Schema.decodeUnknownSync(
  UpdateAutomationNotificationPreferences,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationNotificationDeliveryStatus = Schema.decodeUnknownSync(
  AutomationNotificationDeliveryStatus,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationNotificationDeliveryQueryResponse = Schema.decodeUnknownSync(
  AutomationNotificationDeliveryQueryResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationNotificationDeliveryReceipt = Schema.decodeUnknownSync(
  AutomationNotificationDeliveryReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationNotificationDeliveryRecorded = Schema.decodeUnknownSync(
  AutomationNotificationDeliveryRecorded,
  STRICT_DECODE_OPTIONS,
);
