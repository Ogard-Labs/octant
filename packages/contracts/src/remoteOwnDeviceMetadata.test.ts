import { describe, expect, it } from "vitest";
import {
  decodeRemoteOwnDeviceMetadataV1,
  decodeRemoteSelfServiceReceiptV1,
} from "@octant/contracts/remote-request-proof";

describe("RemoteOwnDeviceMetadataV1", () => {
  it("decodes bounded own-device metadata without other-device fields", () => {
    const metadata = decodeRemoteOwnDeviceMetadataV1({
      deviceId: "22222222-2222-4222-8222-222222222222",
      deviceLabel: "Ada's Safari",
      origin: "https://mac.example.test",
      credentialGeneration: 1,
      createdAt: "2026-08-03T00:00:00.000Z",
      expiresAt: "2026-09-03T00:00:00.000Z",
      lastSeenAt: "2026-08-03T07:00:00.000Z",
      state: "active",
      sessionIdleExpiresAt: "2026-08-03T00:15:00.000Z",
      sessionAbsoluteExpiresAt: "2026-08-03T12:00:00.000Z",
    });
    expect(metadata.deviceLabel).toBe("Ada's Safari");
    expect(metadata.state).toBe("active");
    expect(() =>
      decodeRemoteOwnDeviceMetadataV1({
        deviceId: "22222222-2222-4222-8222-222222222222",
        deviceLabel: "Ada's Safari",
        origin: "https://mac.example.test",
        credentialGeneration: 1,
        createdAt: "2026-08-03T00:00:00.000Z",
        expiresAt: "2026-09-03T00:00:00.000Z",
        lastSeenAt: "2026-08-03T07:00:00.000Z",
        state: "active",
        otherDeviceId: "bad",
      }),
    ).toThrow();
    const receipt = decodeRemoteSelfServiceReceiptV1({
      commandId: "66666666-6666-4666-8666-666666666666",
      result: "applied",
      occurredAt: "2026-08-03T00:00:00.000Z",
    });
    expect(receipt.result).toBe("applied");
  });
});
