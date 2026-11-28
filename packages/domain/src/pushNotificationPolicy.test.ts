import { describe, expect, it } from "vitest";
import {
  decodeStableHostId,
  type AutomationNotificationPreferences,
  type UtcTimestamp,
} from "@octant/contracts";
import { checkPushLabel } from "./pushLabelPolicy";
import {
  admitRemotePushByRate,
  automationNotificationKindForLifecycle,
  buildLiveStatusPushMessage,
  buildPushAlert,
  isAutomationNotificationKindEnabled,
  recheckHubPushMessage,
  REMOTE_PUSH_RATE_LIMIT,
  remotePushDedupeKey,
  remotePushPreferenceAllows,
  remotePushUrgency,
  remotePushWantsNewDevices,
} from "./pushNotificationPolicy";
import {
  admitAutomationNotification,
  automationNotificationBackoffMs,
  automationNotificationDedupeKey,
  AUTOMATION_NOTIFICATION_MAX_ATTEMPTS,
  nextAutomationNotificationOutcome,
} from "./automationNotificationPolicy";

const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const threadId = "00000000-0000-4000-8000-000000000001";
const runId = "aa000000-0000-4000-8000-000000000010" as const;
const collapseId = "q2HnS1wZcV0k3fA8uYt7Rg";
const occurredAt = "2026-11-28T12:00:00.000Z" as UtcTimestamp;
const staleAt = "2026-11-28T12:30:00.000Z" as UtcTimestamp;
const readyEmpty = { status: "ready", values: [] } as const;

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

describe("checkPushLabel", () => {
  it("drops strings matching secret patterns, paths, or exact held secrets even when no pattern matches", () => {
    const randomOpaqueSecret = "my-custom-opaque-company-canary-98471";
    expect(checkPushLabel("Rotate ghp_exampletoken1234567890", [])).toBeUndefined();
    expect(checkPushLabel("Fix /Users/example/secret.ts", [])).toBeUndefined();
    expect(
      checkPushLabel(`Deploy ${randomOpaqueSecret} now`, [randomOpaqueSecret]),
    ).toBeUndefined();
    expect(checkPushLabel("Quarterly plan", [randomOpaqueSecret])).toBe("Quarterly plan");
  });

  it("strips control and bidi characters and checks before stripping so injected control chars cannot evade secret detection", () => {
    const held = "canary-value-7711";
    expect(checkPushLabel(`Title\u202E ${held}`, [held])).toBeUndefined();
    expect(checkPushLabel("Clean\u0007\u202E title\nline2", [])).toBe("Clean title line2");
  });
});

describe("buildPushAlert", () => {
  it("shows only the status word and computer label unless the phone opted in to thread names", () => {
    const message = buildPushAlert({
      source: "thread",
      kind: "approval-needed",
      hostId,
      threadId,
      mode: "code",
      computerLabel: "Studio Mac",
      threadTitle: "Acme incident 4411 rollback",
      projectName: "SecretProject",
      threadTitles: false,
      collapseId,
      sequence: 1,
      occurredAt,
      heldSecrets: readyEmpty,
    });
    expect(message).toEqual({
      type: "alert",
      alert: {
        version: 2,
        kind: "approval-needed",
        hostId,
        threadId,
        mode: "code",
        title: "Approval needed",
        body: "On Studio Mac",
        collapseId,
        urgency: "high",
        sequence: 1,
        occurredAt,
      },
    });
    expect(JSON.stringify(message)).not.toContain("Acme");
    expect(JSON.stringify(message)).not.toContain("SecretProject");
  });

  it("includes thread and project names only for a phone that opted in", () => {
    const message = buildPushAlert({
      source: "thread",
      kind: "completion",
      hostId,
      threadId,
      mode: "work",
      computerLabel: "Studio Mac",
      threadTitle: "Quarterly plan",
      projectName: "Finance",
      threadTitles: true,
      collapseId,
      sequence: 2,
      occurredAt,
      heldSecrets: readyEmpty,
    });
    expect(message.type).toBe("alert");
    if (message.type === "alert") {
      expect(message.alert.title).toBe("Thread completed: Quarterly plan");
      expect(message.alert.body).toBe("Finance · On Studio Mac");
    }
  });

  it("drops a thread title or project name carrying a secret pattern, path, or exact held host secret", () => {
    const heldSecret = "opaque-prod-key-zx991827";
    const heldSecrets = { status: "ready", values: [heldSecret] } as const;
    for (const threadTitle of [
      "Rotate ghp_exampletoken1234567890",
      "Fix /Users/example/secret.ts",
      `Use ${heldSecret} in prod`,
    ]) {
      const message = buildPushAlert({
        source: "thread",
        kind: "failure",
        hostId,
        threadId,
        mode: "chat",
        computerLabel: "Studio Mac",
        threadTitle,
        projectName: `Project ${heldSecret}`,
        threadTitles: true,
        collapseId,
        sequence: 3,
        occurredAt,
        heldSecrets,
      });
      expect(message.type).toBe("alert");
      if (message.type === "alert") {
        expect(message.alert.title).toBe("Thread failed");
        expect(message.alert.body).toBe("On Studio Mac");
      }
      expect(JSON.stringify(message)).not.toContain(heldSecret);
      expect(JSON.stringify(message)).not.toContain("ghp_");
      expect(JSON.stringify(message)).not.toContain("/Users/");
    }
  });

  it("fails closed to a generic placeholder when the host secret check cannot run", () => {
    const message = buildPushAlert({
      source: "thread",
      kind: "waiting",
      hostId,
      threadId,
      mode: "code",
      computerLabel: "Studio Mac",
      threadTitle: "Ship release",
      projectName: "Octant",
      threadTitles: true,
      collapseId,
      sequence: 4,
      occurredAt,
      heldSecrets: { status: "unavailable" },
    });
    expect(message.type).toBe("alert");
    if (message.type === "alert") {
      expect(message.alert.title).toBe("Octant");
      expect(message.alert.body).toBe("A paired computer has an update");
    }
    expect(JSON.stringify(message)).not.toContain("Ship release");
    expect(JSON.stringify(message)).not.toContain("Studio Mac");
  });

  it("drops privateAddress and alertId from device-joined notifications and drops automationId/runId from automation notifications", () => {
    const joined = buildPushAlert({
      source: "device-joined",
      hostId,
      deviceName: "Ada's phone",
      joined: "host",
      computerLabel: "Studio Mac",
      collapseId,
      sequence: 5,
      occurredAt,
      heldSecrets: readyEmpty,
    });
    expect(joined).toEqual({
      type: "alert",
      alert: {
        version: 2,
        kind: "device-joined",
        hostId,
        title: "New device: Ada's phone",
        body: "Paired with Studio Mac",
        collapseId,
        urgency: "high",
        sequence: 5,
        occurredAt,
      },
    });
    expect(JSON.stringify(joined)).not.toContain("alertId");
    expect(JSON.stringify(joined)).not.toContain("privateAddress");

    const moved = buildPushAlert({
      source: "move-waiting",
      hostId,
      destinationName: "Studio Mac",
      collapseId,
      sequence: 6,
      occurredAt,
      heldSecrets: readyEmpty,
    });
    expect(moved.type === "alert" && moved.alert.title).toBe("A move is waiting for your phone");
    expect(moved.type === "alert" && moved.alert.body).toBe("To Studio Mac");

    const automation = buildPushAlert({
      source: "automation",
      kind: "failure",
      hostId,
      mode: "code",
      displayName: "Nightly review",
      computerLabel: "Studio Mac",
      threadTitles: true,
      collapseId,
      sequence: 7,
      occurredAt,
      heldSecrets: readyEmpty,
    });
    expect(automation.type === "alert" && automation.alert.title).toBe(
      "Automation failed: Nightly review",
    );
    expect(automation.type === "alert" && automation.alert.body).toBe("On Studio Mac");
    expect(JSON.stringify(automation)).not.toContain("automationId");
    expect(JSON.stringify(automation)).not.toContain("automationRunId");
  });

  it("stays within UTF-8 byte bounds for long or multibyte labels", () => {
    const message = buildPushAlert({
      source: "thread",
      kind: "waiting",
      hostId,
      threadId,
      mode: "chat",
      computerLabel: "Ü".repeat(200),
      threadTitle: "日本語のスレッド".repeat(30),
      threadTitles: true,
      collapseId,
      sequence: 8,
      occurredAt,
      heldSecrets: readyEmpty,
    });
    expect(message.type).toBe("alert");
    if (message.type === "alert") {
      expect(encoder.encode(message.alert.title).byteLength).toBeLessThanOrEqual(80);
      expect(encoder.encode(message.alert.body).byteLength).toBeLessThanOrEqual(120);
    }
  });
});

describe("buildLiveStatusPushMessage and hub re-check", () => {
  it("caps live-status rows at five, hides thread names when opted out, and checks every label against held secrets", () => {
    const heldSecret = "hub-secret-canary-4411";
    const rows = Array.from({ length: 7 }, (_, i) => ({
      threadId: `00000000-0000-4000-8000-00000000000${i + 1}`,
      mode: "code" as const,
      status: "working" as const,
      updatedAt: `2026-11-28T12:00:0${7 - i}.000Z` as UtcTimestamp,
      title: i === 0 ? `Leak ${heldSecret}` : `Thread ${i + 1}`,
      projectName: i === 1 ? "Project /Users/example/repo" : "Octant",
    }));

    const optedOut = buildLiveStatusPushMessage({
      event: "update",
      hostId,
      computerLabel: "Studio Mac",
      sequence: 1,
      occurredAt,
      staleAt,
      counts: { needsYou: 0, failed: 0, working: 7, done: 0 },
      rows,
      threadTitles: false,
      heldSecrets: readyEmpty,
    });
    expect(optedOut.type).toBe("live-status");
    if (optedOut.type === "live-status") {
      expect(optedOut.liveStatus.rows).toHaveLength(5);
      expect(
        optedOut.liveStatus.rows.every((r) => r.title === undefined && r.projectName === undefined),
      ).toBe(true);
    }

    const optedIn = buildLiveStatusPushMessage({
      event: "update",
      hostId,
      computerLabel: "Studio Mac",
      sequence: 2,
      occurredAt,
      staleAt,
      counts: { needsYou: 0, failed: 0, working: 7, done: 0 },
      rows,
      threadTitles: true,
      heldSecrets: { status: "ready", values: [heldSecret] },
    });
    expect(optedIn.type).toBe("live-status");
    if (optedIn.type === "live-status") {
      expect(optedIn.liveStatus.rows[0]?.title).toBeUndefined();
      expect(optedIn.liveStatus.rows[1]?.title).toBe("Thread 2");
      expect(optedIn.liveStatus.rows[1]?.projectName).toBeUndefined();
    }
    expect(JSON.stringify(optedIn)).not.toContain(heldSecret);
  });

  it("re-checks spoke messages on the hub and drops labels matching the hub's own secrets or unreadable keyring", () => {
    const hubSecret = "only-hub-knows-this-9911";
    const fromSpoke = buildPushAlert({
      source: "thread",
      kind: "waiting",
      hostId,
      threadId,
      mode: "code",
      computerLabel: "Spoke Mac",
      threadTitle: `Contains ${hubSecret}`,
      threadTitles: true,
      collapseId,
      sequence: 1,
      occurredAt,
      heldSecrets: readyEmpty,
    });
    const rechecked = recheckHubPushMessage(fromSpoke, { status: "ready", values: [hubSecret] });
    expect(rechecked.type).toBe("alert");
    if (rechecked.type === "alert") {
      expect(rechecked.alert.title).toBe("Waiting for you");
      expect(JSON.stringify(rechecked)).not.toContain(hubSecret);
    }

    const failedClosed = recheckHubPushMessage(fromSpoke, { status: "unavailable" });
    expect(failedClosed.type).toBe("alert");
    if (failedClosed.type === "alert") {
      expect(failedClosed.alert.title).toBe("Octant");
      expect(failedClosed.alert.body).toBe("A paired computer has an update");
    }
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

  it("asks the phone's own preference for each kind and new-devices default", () => {
    expect(remotePushPreferenceAllows(preferences, "approval-needed")).toBe(true);
    expect(remotePushPreferenceAllows(preferences, "waiting")).toBe(false);
    expect(remotePushPreferenceAllows(preferences, "failure")).toBe(true);
    expect(remotePushPreferenceAllows(preferences, "completion")).toBe(false);
    expect(remotePushWantsNewDevices(preferences)).toBe(true);
    expect(remotePushWantsNewDevices({ ...preferences, newDevices: false })).toBe(false);
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
    expect(remotePushUrgency("move-waiting")).toBe("high");
    expect(remotePushUrgency("device-joined")).toBe("high");
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
