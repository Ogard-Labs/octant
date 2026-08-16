import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { HostId } from "./host";
import {
  AutomationId,
  AutomationOpaqueReference,
  AutomationRunId,
  AutomationThreadId,
} from "./automation";
import { RemotePushNotificationKind } from "./remotePushNotifications";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedText = (maximumBytes: number) =>
  Schema.String.pipe(Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes));
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

/**
 * Automation push kinds reuse the Mobile C redacted kind vocabulary. Approval
 * maps to `approval-needed`; waiting / failure / completion keep the same
 * lock-screen labels as ordinary-thread awareness.
 */
export const AutomationNotificationKind = RemotePushNotificationKind;
export type AutomationNotificationKind = typeof AutomationNotificationKind.Type;

export const AutomationNotificationMode = Schema.Literal("work", "code");
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
}).annotations(strict);
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
}).annotations(strict);
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
}).annotations(strict);
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
}).annotations(strict);
export type UpdateAutomationNotificationPreferences =
  typeof UpdateAutomationNotificationPreferences.Type;

/**
 * Honest delivery availability for local/browser settings and remote clients.
 * Never includes tokens, provider credentials, or host-only secrets.
 */
export const AutomationNotificationProviderDelivery = Schema.Literal("available", "unavailable");
export type AutomationNotificationProviderDelivery =
  typeof AutomationNotificationProviderDelivery.Type;

export const AutomationNotificationDeliveryStatus = Schema.Struct({
  preferences: AutomationNotificationPreferences,
  providerDelivery: AutomationNotificationProviderDelivery,
  registeredDestinationCount: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
  deliveryEnabled: Schema.Boolean,
}).annotations(strict);
export type AutomationNotificationDeliveryStatus = typeof AutomationNotificationDeliveryStatus.Type;

export const AutomationNotificationDeliveryOutcome = Schema.Literal(
  "queued",
  "delivered",
  "failed",
  "cancelled",
  "skipped-preference",
  "skipped-no-destination",
  "skipped-duplicate",
  "exhausted",
);
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
  attemptCount: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(32)),
  destinationCount: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
  failureCategory: Schema.optional(boundedNonEmptyText(64)),
  recordedAt: UtcTimestamp,
}).annotations(strict);
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
  receipts: Schema.Array(AutomationNotificationDeliveryReceipt).pipe(
    Schema.maxItems(MAX_AUTOMATION_NOTIFICATION_DELIVERY_QUERY),
  ),
}).annotations(strict);
export type AutomationNotificationDeliveryQueryResponse =
  typeof AutomationNotificationDeliveryQueryResponse.Type;

export const AutomationNotificationDeliveryRecorded = Schema.Struct({
  receipt: AutomationNotificationDeliveryReceipt,
}).annotations(strict);
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
);
export const decodeAutomationNotificationPreferences = Schema.decodeUnknownSync(
  AutomationNotificationPreferences,
);
export const decodeUpdateAutomationNotificationPreferences = Schema.decodeUnknownSync(
  UpdateAutomationNotificationPreferences,
);
export const decodeAutomationNotificationDeliveryStatus = Schema.decodeUnknownSync(
  AutomationNotificationDeliveryStatus,
);
export const decodeAutomationNotificationDeliveryQueryResponse = Schema.decodeUnknownSync(
  AutomationNotificationDeliveryQueryResponse,
);
export const decodeAutomationNotificationDeliveryReceipt = Schema.decodeUnknownSync(
  AutomationNotificationDeliveryReceipt,
);
export const decodeAutomationNotificationDeliveryRecorded = Schema.decodeUnknownSync(
  AutomationNotificationDeliveryRecorded,
);
