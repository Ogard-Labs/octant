import { describe, expect, it } from "vitest";
import {
  decodeHostPushSenderChangedV1,
  decodeLiveStatusV1,
  decodePushAlertV2,
  decodePushMessageV2,
  decodeRemotePushDeliveryRecordedV1,
  decodeRemotePushDeviceJoinedDeliveryRecordedV1,
  decodeRemotePushMoveWaitingDeliveryRecordedV1,
  decodeRemotePushRegistrationClearedV1,
  decodeRemotePushRegistrationRecordedV1,
  decodeRemotePushStatusV1,
  decodeRemotePushTokenReceiptV1,
  decodeRemotePushTokenRegistrationV2,
} from "./remotePushNotifications";

const hostId = "11111111-1111-4111-8111-111111111111";
const preferences = {
  approvalNeeded: true,
  waiting: true,
  failure: true,
  completion: true,
  threadTitles: false,
};

describe("remotePushNotifications", () => {
  it("accepts v2 token registrations and rejects legacy v1 registrations with notificationPublicKey", () => {
    expect(
      decodeRemotePushTokenRegistrationV2({
        version: 2,
        platform: "ios",
        token: "opaque-provider-token",
        preferences,
      }),
    ).toMatchObject({ version: 2, platform: "ios" });

    expect(
      decodeRemotePushTokenRegistrationV2({
        version: 2,
        platform: "android",
        token: "opaque-provider-token",
        preferences: { ...preferences, newDevices: false, threadTitles: true },
      }).preferences,
    ).toMatchObject({ newDevices: false, threadTitles: true });

    expect(() =>
      decodeRemotePushTokenRegistrationV2({
        platform: "ios",
        token: "opaque-provider-token",
        notificationPublicKey: "MJaD3ARvNKlDGKOdP1uw2ORQnq9V7CJeVRT9Xg09h3E",
        preferences,
      }),
    ).toThrow();

    expect(
      decodeRemotePushTokenReceiptV1({
        result: "registered",
        occurredAt: "2026-11-28T12:00:00.000Z",
      }),
    ).toMatchObject({ result: "registered" });
  });

  it("decodes honest host push availability status", () => {
    expect(
      decodeRemotePushStatusV1({
        status: "available",
        platforms: { ios: true, android: false },
      }),
    ).toEqual({ status: "available", platforms: { ios: true, android: false } });
    expect(decodeRemotePushStatusV1({ status: "unavailable", reason: "off" })).toEqual({
      status: "unavailable",
      reason: "off",
    });
    expect(decodeRemotePushStatusV1({ status: "unavailable", reason: "no-credentials" })).toEqual({
      status: "unavailable",
      reason: "no-credentials",
    });
    expect(() => decodeRemotePushStatusV1({ status: "unavailable", reason: "other" })).toThrow();
  });

  it("decodes direct v2 alerts and rejects forbidden fields such as prompts, alertId, or privateAddress", () => {
    const alert = {
      version: 2 as const,
      kind: "waiting" as const,
      hostId,
      threadId: "00000000-0000-4000-8000-000000000001",
      mode: "code" as const,
      title: "Waiting for you",
      body: "On Studio Mac",
      collapseId: "q2HnS1wZcV0k3fA8uYt7Rg",
      urgency: "high" as const,
      sequence: 1,
      occurredAt: "2026-11-28T12:00:00.000Z",
    };
    expect(decodePushAlertV2(alert)).toEqual(alert);
    expect(decodePushMessageV2({ type: "alert", alert })).toEqual({ type: "alert", alert });
    for (const forbidden of [
      { prompt: "secret prompt" },
      { alertId: "44444444-4444-4444-8444-444444444444" },
      { automationId: "aa000000-0000-4000-8000-000000000001" },
      { automationRunId: "aa000000-0000-4000-8000-000000000010" },
      { privateAddress: "192.168.1.20" },
    ]) {
      expect(() => decodePushAlertV2({ ...alert, ...forbidden })).toThrow();
    }
  });

  it("decodes live-status v1 payloads with at most five rows", () => {
    const row = {
      threadId: "00000000-0000-4000-8000-000000000001",
      mode: "code" as const,
      status: "working" as const,
      updatedAt: "2026-11-28T12:00:00.000Z",
    };
    const liveStatus = {
      version: 1 as const,
      hostId,
      computerName: "Studio Mac",
      event: "update" as const,
      counts: { needsYou: 1, failed: 0, working: 2, done: 1 },
      rows: [row],
      sequence: 3,
      occurredAt: "2026-11-28T12:00:00.000Z",
      staleAt: "2026-11-28T12:30:00.000Z",
      urgency: "normal" as const,
    };
    expect(decodeLiveStatusV1(liveStatus)).toEqual(liveStatus);
    expect(decodePushMessageV2({ type: "live-status", liveStatus })).toEqual({
      type: "live-status",
      liveStatus,
    });
    expect(() =>
      decodeLiveStatusV1({ ...liveStatus, rows: [row, row, row, row, row, row] }),
    ).toThrow();
  });

  it("journals registration, delivery, and push-sender changes without tokens or credentials", () => {
    const deviceId = "22222222-2222-4222-8222-222222222222";
    const recorded = {
      hostId,
      deviceId,
      platform: "android",
      change: "added",
      recordedAt: "2026-10-26T12:00:00.000Z",
    };
    expect(decodeRemotePushRegistrationRecordedV1(recorded)).toEqual(recorded);
    expect(() =>
      decodeRemotePushRegistrationRecordedV1({ ...recorded, token: "opaque-provider-token" }),
    ).toThrow();

    const cleared = {
      hostId,
      deviceId,
      reason: "pairing-abandoned",
      clearedAt: "2026-10-26T12:00:00.000Z",
    };
    expect(decodeRemotePushRegistrationClearedV1(cleared)).toEqual(cleared);

    const delivery = {
      hostId,
      deviceId,
      threadId: "00000000-0000-4000-8000-000000000001",
      kind: "approval-needed",
      outcome: "failed",
      failureCategory: "provider-unavailable",
      recordedAt: "2026-10-26T12:00:00.000Z",
    };
    expect(decodeRemotePushDeliveryRecordedV1(delivery)).toEqual(delivery);
    expect(() =>
      decodeRemotePushDeliveryRecordedV1({ ...delivery, title: "Approval needed" }),
    ).toThrow();

    expect(
      decodeRemotePushMoveWaitingDeliveryRecordedV1({
        hostId,
        deviceId,
        outcome: "delivered",
        recordedAt: "2026-11-09T12:00:00.000Z",
      }).outcome,
    ).toBe("delivered");

    expect(
      decodeRemotePushDeviceJoinedDeliveryRecordedV1({
        hostId,
        deviceId,
        alertId: "33333333-3333-4333-8333-333333333333",
        outcome: "delivered",
        recordedAt: "2026-11-20T08:00:00.000Z",
      }).outcome,
    ).toBe("delivered");

    const senderChanged = {
      change: "credential-changed",
      platform: "ios",
      recordedAt: "2026-11-28T12:00:00.000Z",
    };
    expect(decodeHostPushSenderChangedV1(senderChanged)).toEqual(senderChanged);
    expect(() =>
      decodeHostPushSenderChangedV1({
        ...senderChanged,
        privateKey: "-----BEGIN PRIVATE KEY-----",
      }),
    ).toThrow();
  });
});
