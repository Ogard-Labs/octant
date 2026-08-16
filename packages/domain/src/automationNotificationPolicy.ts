import type {
  AutomationNotificationDeliveryOutcome,
  AutomationNotificationKind,
  AutomationNotificationPreferences,
  AutomationRunId,
} from "@octant/contracts";
import { isAutomationNotificationKindEnabled } from "./pushNotificationPolicy";

/** Maximum provider send attempts per (run, kind) before exhausting. */
export const AUTOMATION_NOTIFICATION_MAX_ATTEMPTS = 5;

/** Base backoff in ms; doubles each attempt (1s, 2s, 4s, 8s, …) capped below. */
export const AUTOMATION_NOTIFICATION_BACKOFF_BASE_MS = 1_000;
export const AUTOMATION_NOTIFICATION_BACKOFF_CAP_MS = 60_000;

export function automationNotificationDedupeKey(
  runId: AutomationRunId,
  kind: AutomationNotificationKind,
): string {
  return `${runId}:${kind}`;
}

export function automationNotificationBackoffMs(attemptCount: number): number {
  const safeAttempt = Math.max(0, Math.min(attemptCount, 16));
  const delay = AUTOMATION_NOTIFICATION_BACKOFF_BASE_MS * 2 ** safeAttempt;
  return Math.min(delay, AUTOMATION_NOTIFICATION_BACKOFF_CAP_MS);
}

export function shouldRetryAutomationNotification(input: {
  readonly attemptCount: number;
  readonly retryable: boolean;
}): boolean {
  return input.retryable && input.attemptCount < AUTOMATION_NOTIFICATION_MAX_ATTEMPTS;
}

export type AutomationNotificationAdmission =
  | { readonly kind: "admit" }
  | {
      readonly kind: "skip";
      readonly outcome: Extract<
        AutomationNotificationDeliveryOutcome,
        "skipped-preference" | "skipped-no-destination" | "skipped-duplicate"
      >;
    };

/**
 * Pure admission gate before enqueueing a delivery attempt. Preference and
 * destination checks happen here so the delivery service never invents a
 * second redaction or preference model.
 */
export function admitAutomationNotification(input: {
  readonly preferences: AutomationNotificationPreferences;
  readonly notificationKind: AutomationNotificationKind;
  readonly destinationCount: number;
  readonly alreadyRecorded: boolean;
}): AutomationNotificationAdmission {
  if (input.alreadyRecorded) {
    return { kind: "skip", outcome: "skipped-duplicate" };
  }
  if (!isAutomationNotificationKindEnabled(input.preferences, input.notificationKind)) {
    return { kind: "skip", outcome: "skipped-preference" };
  }
  if (input.destinationCount <= 0) {
    return { kind: "skip", outcome: "skipped-no-destination" };
  }
  return { kind: "admit" };
}

export function nextAutomationNotificationOutcome(input: {
  readonly cancelled: boolean;
  readonly attemptCount: number;
  readonly send: "delivered" | { readonly kind: "failed"; readonly retryable: boolean };
}): {
  readonly outcome: AutomationNotificationDeliveryOutcome;
  readonly retryAtOffsetMs?: number;
} {
  if (input.cancelled) {
    return { outcome: "cancelled" };
  }
  if (input.send === "delivered") {
    return { outcome: "delivered" };
  }
  if (
    shouldRetryAutomationNotification({
      attemptCount: input.attemptCount,
      retryable: input.send.retryable,
    })
  ) {
    return {
      outcome: "queued",
      retryAtOffsetMs: automationNotificationBackoffMs(input.attemptCount),
    };
  }
  return { outcome: input.send.retryable ? "exhausted" : "failed" };
}
