import { describe, expect, it } from "vitest";
import {
  admitRemotePushByRate,
  buildRedactedAutomationPushNotification,
  buildRedactedPushNotification,
  automationNotificationKindForLifecycle,
  isAutomationNotificationKindEnabled,
  REMOTE_PUSH_RATE_LIMIT,
  remotePushDedupeKey,
  remotePushPreferenceAllows,
  remotePushUrgency,
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

const encoder = new TextEncoder();

describe("buildRedactedPushNotification", () => {
  it("shows only the kind and the computer's label unless the phone opted in to thread names", () => {
    const payload = buildRedactedPushNotification({
      kind: "approval-needed",
      hostId,
      threadId,
      mode: "code",
      computerLabel: "Studio Mac",
      threadTitle: "Acme incident 4411 rollback",
      threadTitles: false,
    });
    expect(payload).toEqual({
      kind: "approval-needed",
      hostId,
      threadId,
      mode: "code",
      title: "Approval needed",
      body: "On Studio Mac",
    });
    expect(JSON.stringify(payload)).not.toContain("Acme");
  });

  it("adds the thread title only for a phone that opted in", () => {
    const payload = buildRedactedPushNotification({
      kind: "completion",
      hostId,
      threadId,
      mode: "work",
      computerLabel: "Studio Mac",
      threadTitle: "Quarterly plan",
      threadTitles: true,
    });
    expect(payload.title).toBe("Thread completed: Quarterly plan");
    expect(payload.body).toBe("On Studio Mac");
  });

  it("keeps a title that looks like a secret or a path off the lock screen even when titles are on", () => {
    for (const threadTitle of [
      "Rotate ghp_exampletoken123",
      "Fix /Users/example/secret.ts",
      "password reset for prod",
    ]) {
      const payload = buildRedactedPushNotification({
        kind: "failure",
        hostId,
        threadId,
        mode: "chat",
        computerLabel: "Studio Mac",
        threadTitle,
        threadTitles: true,
      });
      expect(payload.title).toBe("Thread failed");
      expect(JSON.stringify(payload)).not.toContain("ghp_");
      expect(JSON.stringify(payload)).not.toContain("/Users/");
      expect(JSON.stringify(payload)).not.toContain("password");
    }
  });

  it("tells the phone an approval only the computer can answer is waiting there, as a wait and not an ask", () => {
    const local = {
      kind: "approval-needed",
      hostId,
      threadId,
      mode: "code",
      computerLabel: "Studio Mac",
      threadTitle: "Fix the release build",
      localPersonOnly: true,
    } as const;
    expect(buildRedactedPushNotification({ ...local, threadTitles: false })).toEqual({
      kind: "waiting",
      hostId,
      threadId,
      mode: "code",
      title: "Waiting for you at Studio Mac",
      body: "Only an Octant window on that computer can answer",
    });
    expect(buildRedactedPushNotification({ ...local, threadTitles: true }).title).toBe(
      "Waiting for you at Studio Mac: Fix the release build",
    );
    // A label the scrubber refuses is replaced, not shown.
    const scrubbed = buildRedactedPushNotification({
      ...local,
      computerLabel: "/Users/example/Mac",
      threadTitles: false,
    });
    expect(scrubbed.title).toBe("Waiting for you at your paired computer");
    expect(JSON.stringify(scrubbed)).not.toContain("/Users/");
  });

  it("stays within the payload's byte bounds for long or multibyte titles and labels", () => {
    const payload = buildRedactedPushNotification({
      kind: "waiting",
      hostId,
      threadId,
      mode: "chat",
      computerLabel: "Ü".repeat(200),
      threadTitle: "日本語のスレッド".repeat(30),
      threadTitles: true,
    });
    expect(encoder.encode(payload.title).byteLength).toBeLessThanOrEqual(80);
    expect(encoder.encode(payload.body).byteLength).toBeLessThanOrEqual(120);
    expect(payload.title.startsWith("Waiting for you: 日本語")).toBe(true);
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
      computerLabel: "Studio Mac",
      threadTitles: true,
    });
    expect(payload.navigation).toEqual({
      surface: "automation-center",
      automationId,
      runId,
    });
    expect(payload.threadId).toBeUndefined();
    expect(payload.title).toBe("Automation failed: Nightly review");
    expect(payload.body).toBe("On Studio Mac");
  });

  it("names the automation only for a phone that opted in to titles", () => {
    const payload = buildRedactedAutomationPushNotification({
      kind: "waiting",
      hostId,
      automationId: automationId as never,
      automationRunId: runId as never,
      threadId: threadId as never,
      displayName: "Customer Acme sync",
      computerLabel: "Studio Mac",
      threadTitles: false,
    });
    expect(payload.title).toBe("Automation waiting");
    expect(JSON.stringify(payload)).not.toContain("Acme");
  });
});

describe("remote push delivery policy", () => {
  const preferences = {
    approvalNeeded: true,
    waiting: false,
    failure: true,
    completion: false,
    threadTitles: false,
  };

  it("asks the phone's own preference for each kind", () => {
    expect(remotePushPreferenceAllows(preferences, "approval-needed")).toBe(true);
    expect(remotePushPreferenceAllows(preferences, "waiting")).toBe(false);
    expect(remotePushPreferenceAllows(preferences, "failure")).toBe(true);
    expect(remotePushPreferenceAllows(preferences, "completion")).toBe(false);
  });

  it("deduplicates per thread, kind, and run", () => {
    const key = remotePushDedupeKey({ threadId, kind: "completion", runId: "run-1" });
    expect(key).toBe(remotePushDedupeKey({ threadId, kind: "completion", runId: "run-1" }));
    expect(key).not.toBe(remotePushDedupeKey({ threadId, kind: "completion", runId: "run-2" }));
    expect(key).not.toBe(remotePushDedupeKey({ threadId, kind: "failure", runId: "run-1" }));
  });

  it("refuses a device's sends beyond the limit inside the window and admits again once it passes", () => {
    let recent: ReadonlyArray<number> = [];
    const start = 1_000_000;
    for (let index = 0; index < REMOTE_PUSH_RATE_LIMIT.maximum; index += 1) {
      const admitted = admitRemotePushByRate({ recent, now: start + index });
      expect(admitted.kind).toBe("admit");
      recent = admitted.recent;
    }
    const refused = admitRemotePushByRate({ recent, now: start + 10 });
    expect(refused.kind).toBe("rate-limited");
    expect(refused.recent).toHaveLength(REMOTE_PUSH_RATE_LIMIT.maximum);
    const later = admitRemotePushByRate({
      recent: refused.recent,
      now: start + REMOTE_PUSH_RATE_LIMIT.windowMs + REMOTE_PUSH_RATE_LIMIT.maximum,
    });
    expect(later.kind).toBe("admit");
    expect(later.recent).toHaveLength(1);
  });

  it("sends what waits on the person at high urgency and the rest at normal", () => {
    expect(remotePushUrgency("approval-needed")).toBe("high");
    expect(remotePushUrgency("waiting")).toBe("high");
    expect(remotePushUrgency("failure")).toBe("normal");
    expect(remotePushUrgency("completion")).toBe("normal");
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
