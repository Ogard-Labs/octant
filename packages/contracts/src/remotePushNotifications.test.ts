import { describe, expect, it } from "vitest";
import {
  decodeRemotePushDeliveryRecordedV1,
  decodeRemotePushEnvelopeV1,
  decodeRemotePushNotificationPayloadV1,
  decodeRemotePushRegistrationClearedV1,
  decodeRemotePushRegistrationRecordedV1,
  decodeRemotePushTokenReceiptV1,
  decodeRemotePushTokenRegistrationV1,
} from "./remotePushNotifications";

const hostId = "11111111-1111-4111-8111-111111111111";
const notificationPublicKey = "MJaD3ARvNKlDGKOdP1uw2ORQnq9V7CJeVRT9Xg09h3E";
const preferences = {
  approvalNeeded: true,
  waiting: true,
  failure: true,
  completion: true,
  threadTitles: false,
};

describe("remotePushNotifications", () => {
  it("accepts bounded token registration and receipts", () => {
    expect(
      decodeRemotePushTokenRegistrationV1({
        platform: "ios",
        token: "opaque-provider-token",
        notificationPublicKey,
        preferences,
      }),
    ).toMatchObject({ platform: "ios", notificationPublicKey });
    expect(
      decodeRemotePushTokenReceiptV1({
        result: "registered",
        occurredAt: "2026-08-05T12:00:00.000Z",
      }),
    ).toMatchObject({ result: "registered" });
  });

  it("accepts redacted notification payloads and rejects extra fields", () => {
    expect(
      decodeRemotePushNotificationPayloadV1({
        kind: "waiting",
        hostId,
        threadId: "00000000-0000-4000-8000-000000000001",
        mode: "code",
        title: "Waiting on host",
        body: "Open Octant to continue.",
      }),
    ).toMatchObject({ kind: "waiting", hostId });
    expect(() =>
      decodeRemotePushNotificationPayloadV1({
        kind: "failure",
        hostId,
        threadId: "00000000-0000-4000-8000-000000000001",
        title: "Failed",
        body: "See host.",
        prompt: "secret user prompt",
      }),
    ).toThrow();
  });

  it("journals a registration change or clear with no room for the token", () => {
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
    expect(() =>
      decodeRemotePushRegistrationClearedV1({ ...cleared, token: "opaque-provider-token" }),
    ).toThrow();
  });

  it("refuses a registration the host could not seal to or would not know what to send", () => {
    const registration = { platform: "ios", token: "opaque-provider-token" };
    expect(() => decodeRemotePushTokenRegistrationV1(registration)).toThrow();
    expect(() =>
      decodeRemotePushTokenRegistrationV1({ ...registration, notificationPublicKey }),
    ).toThrow();
    for (const malformed of [
      "",
      "not a key",
      notificationPublicKey.slice(1),
      `${notificationPublicKey}A`,
    ]) {
      expect(() =>
        decodeRemotePushTokenRegistrationV1({
          ...registration,
          notificationPublicKey: malformed,
          preferences,
        }),
      ).toThrow();
    }
  });

  it("lets the delivery envelope carry only the placeholder, the collapse id, the urgency, and sealed bytes", () => {
    const envelope = {
      alert: { title: "Octant", body: "A paired computer has an update" },
      collapseId: "q2HnS1wZcV0k3fA8uYt7Rg",
      urgency: "high",
      sealed: {
        encapsulatedKey: notificationPublicKey,
        ciphertext: "c2VhbGVkLWNvbnRlbnQtYW5kLWl0cy10YWc",
      },
    };
    expect(decodeRemotePushEnvelopeV1(envelope)).toEqual(envelope);
    expect(() =>
      decodeRemotePushEnvelopeV1({
        ...envelope,
        alert: { title: "Approval needed", body: "Ship the release" },
      }),
    ).toThrow();
    expect(() => decodeRemotePushEnvelopeV1({ ...envelope, threadId: "thread" })).toThrow();
    expect(() => decodeRemotePushEnvelopeV1({ ...envelope, hostId })).toThrow();
    expect(() => decodeRemotePushEnvelopeV1({ ...envelope, kind: "approval-needed" })).toThrow();
    expect(() =>
      decodeRemotePushEnvelopeV1({
        ...envelope,
        sealed: { ...envelope.sealed, ciphertext: "A".repeat(4_000) },
      }),
    ).toThrow();
  });

  it("journals a delivery receipt with no room for the notification text, token, or key", () => {
    const receipt = {
      hostId,
      deviceId: "22222222-2222-4222-8222-222222222222",
      threadId: "00000000-0000-4000-8000-000000000001",
      kind: "approval-needed",
      outcome: "failed",
      failureCategory: "provider-unavailable",
      recordedAt: "2026-10-26T12:00:00.000Z",
    };
    expect(decodeRemotePushDeliveryRecordedV1(receipt)).toEqual(receipt);
    for (const leak of [
      { title: "Approval needed: Ship it" },
      { token: "opaque-provider-token" },
      { notificationPublicKey },
    ]) {
      expect(() => decodeRemotePushDeliveryRecordedV1({ ...receipt, ...leak })).toThrow();
    }
    expect(() =>
      decodeRemotePushDeliveryRecordedV1({
        ...receipt,
        failureCategory: "Provider said: /Users/example/secret",
      }),
    ).toThrow();
  });
});
