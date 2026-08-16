import { describe, expect, it } from "vitest";
import {
  buildRedactedAutomationPushNotification,
  buildRedactedPushNotification,
  automationNotificationKindForLifecycle,
  isAutomationNotificationKindEnabled,
} from "./pushNotificationPolicy";
import {
  admitAutomationNotification,
  automationNotificationBackoffMs,
  automationNotificationDedupeKey,
  AUTOMATION_NOTIFICATION_MAX_ATTEMPTS,
  nextAutomationNotificationOutcome,
} from "./automationNotificationPolicy";
import type { AutomationNotificationPreferences } from "@octant/contracts";

const hostId = "11111111-1111-4111-8111-111111111111";
const threadId = "00000000-0000-4000-8000-000000000001";
const automationId = "aa000000-0000-4000-8000-000000000001" as const;
const runId = "aa000000-0000-4000-8000-000000000010" as const;

const prefs = (overrides: Partial<AutomationNotificationPreferences> = {}) =>
  ({
    enabled: true,
    waiting: true,
    approvalNeeded: true,
    failure: true,
    completion: true,
    version: 1,
    updatedAt: "2026-08-11T12:00:00.000Z",
    ...overrides,
  }) as AutomationNotificationPreferences;

describe("buildRedactedPushNotification", () => {
  it("uses generic copy for kinds without leaking raw detail", () => {
    const payload = buildRedactedPushNotification({
      kind: "approval-needed",
      hostId,
      threadId,
      mode: "code",
      threadTitle: "Ship merge",
    });
    expect(payload.title).toContain("Ship merge");
    expect(payload.body).toContain("desktop host");
    expect(JSON.stringify(payload)).not.toContain("ghp_");
  });

  it("scrubs secrets and absolute paths from raw detail", () => {
    const secret = buildRedactedPushNotification({
      kind: "failure",
      hostId,
      threadId,
      rawDetail: "Provider rejected ghp_exampletoken123 with /Users/example/secret.ts",
    });
    expect(secret.body).toBe("Details available on the host.");
    expect(secret.body).not.toContain("ghp_");
    expect(secret.body).not.toContain("/Users/");
  });
});

describe("buildRedactedAutomationPushNotification", () => {
  it("includes automation navigation without requiring a thread id", () => {
    const payload = buildRedactedAutomationPushNotification({
      kind: "failure",
      hostId,
      automationId: automationId as never,
      automationRunId: runId as never,
      mode: "code",
      displayName: "Nightly review",
    });
    expect(payload.navigation).toEqual({
      surface: "automation-center",
      automationId,
      runId,
    });
    expect(payload.threadId).toBeUndefined();
    expect(payload.title).toContain("Nightly review");
  });

  it("scrubs hostile secrets, paths, prompts, and authority-like detail", () => {
    const payload = buildRedactedAutomationPushNotification({
      kind: "waiting",
      hostId,
      automationId: automationId as never,
      automationRunId: runId as never,
      threadId: threadId as never,
      rawDetail:
        "Waiting on approval receipt authz-deadbeef for prompt: delete /Users/example/secrets with ghp_leak",
    });
    expect(payload.body).toBe("Details available on the host.");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("ghp_");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("authz-deadbeef");
    expect(serialized).not.toContain("delete");
  });
});

describe("automation notification admission and retry policy", () => {
  it("maps notifiable lifecycles and respects disabled preferences", () => {
    expect(automationNotificationKindForLifecycle("waiting")).toBe("waiting");
    expect(automationNotificationKindForLifecycle("completed")).toBe("completion");
    expect(automationNotificationKindForLifecycle("failed")).toBe("failure");
    expect(automationNotificationKindForLifecycle("running")).toBeUndefined();
    expect(isAutomationNotificationKindEnabled(prefs({ enabled: false }), "failure")).toBe(false);
    expect(isAutomationNotificationKindEnabled(prefs({ failure: false }), "failure")).toBe(false);
  });

  it("dedupes, skips preference/destination, and bounds retry backoff", () => {
    expect(automationNotificationDedupeKey(runId as never, "completion")).toBe(
      `${runId}:completion`,
    );
    expect(
      admitAutomationNotification({
        preferences: prefs(),
        notificationKind: "completion",
        destinationCount: 1,
        alreadyRecorded: true,
      }),
    ).toEqual({ kind: "skip", outcome: "skipped-duplicate" });
    expect(
      admitAutomationNotification({
        preferences: prefs({ enabled: false }),
        notificationKind: "completion",
        destinationCount: 1,
        alreadyRecorded: false,
      }),
    ).toEqual({ kind: "skip", outcome: "skipped-preference" });
    expect(
      admitAutomationNotification({
        preferences: prefs(),
        notificationKind: "completion",
        destinationCount: 0,
        alreadyRecorded: false,
      }),
    ).toEqual({ kind: "skip", outcome: "skipped-no-destination" });

    expect(automationNotificationBackoffMs(0)).toBe(1_000);
    expect(automationNotificationBackoffMs(1)).toBe(2_000);
    expect(automationNotificationBackoffMs(10)).toBe(60_000);

    expect(
      nextAutomationNotificationOutcome({
        cancelled: true,
        attemptCount: 1,
        send: "delivered",
      }).outcome,
    ).toBe("cancelled");
    expect(
      nextAutomationNotificationOutcome({
        cancelled: false,
        attemptCount: AUTOMATION_NOTIFICATION_MAX_ATTEMPTS,
        send: { kind: "failed", retryable: true },
      }).outcome,
    ).toBe("exhausted");
    expect(
      nextAutomationNotificationOutcome({
        cancelled: false,
        attemptCount: 1,
        send: { kind: "failed", retryable: true },
      }),
    ).toMatchObject({ outcome: "queued", retryAtOffsetMs: 2_000 });
  });
});
