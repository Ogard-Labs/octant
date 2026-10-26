import { describe, expect, it } from "vitest";
import {
  decodeRemotePushNotificationPayloadV1,
  decodeRemotePushRegistrationClearedV1,
  decodeRemotePushRegistrationRecordedV1,
  decodeRemotePushTokenReceiptV1,
  decodeRemotePushTokenRegistrationV1,
} from "./remotePushNotifications";

const hostId = "11111111-1111-4111-8111-111111111111";

describe("remotePushNotifications", () => {
  it("accepts bounded token registration and receipts", () => {
    expect(
      decodeRemotePushTokenRegistrationV1({
        platform: "ios",
        token: "opaque-provider-token",
      }),
    ).toMatchObject({ platform: "ios" });
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
});
