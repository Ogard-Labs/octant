import { describe, expect, it } from "vitest";
import {
  decodeRemotePushNotificationPayloadV1,
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
});
