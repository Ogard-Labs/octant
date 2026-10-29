import type { MobileRemoteTransport } from "@octant/client-runtime";
import { describe, expect, it, vi } from "vitest";
import { MOBILE_PUSH_GATEWAY_URL, enablePhoneNotifications } from "./enablePhoneNotifications";
import type { MobileNotificationPermissionPort } from "./notificationPermissionPort";

const platformToken = "a".repeat(64);
const fingerprint = "f".repeat(64);
const capability = `v1.k1.${"C".repeat(64)}`;
const publicKey = "K".repeat(43);

function permission(
  overrides: Partial<MobileNotificationPermissionPort> = {},
): MobileNotificationPermissionPort {
  return {
    available: true,
    platform: "ios",
    getStatus: async () => "granted",
    request: async () => "granted",
    getDevicePushToken: async () => platformToken,
    getNotificationPublicKey: async () => publicKey,
    forgetHost: async () => undefined,
    ...overrides,
  };
}

function recordingHost() {
  const bodies: unknown[] = [];
  const transport: MobileRemoteTransport = {
    hostId: "11111111-1111-4111-8111-111111111111",
    authenticatedFetch: async (request) => {
      bodies.push(JSON.parse(String(request.body)));
      return Response.json({ result: "registered", occurredAt: "2026-10-28T12:00:00.000Z" });
    },
  };
  return { transport, bodies };
}

describe("turning phone notifications on for a computer", () => {
  it("gives the computer a gateway capability bound to its key, never the platform token", async () => {
    const host = recordingHost();
    const requestCapability = vi.fn(async () => ({ status: "issued" as const, capability }));

    const result = await enablePhoneNotifications({
      transport: host.transport,
      hostKeyFingerprint: fingerprint,
      permission: permission(),
      requestCapability,
    });

    expect(result).toEqual({ status: "registered" });
    expect(requestCapability).toHaveBeenCalledWith({
      gatewayUrl: MOBILE_PUSH_GATEWAY_URL,
      platform: "ios",
      token: platformToken,
      hostKeyFingerprint: fingerprint,
    });
    expect(host.bodies).toEqual([
      {
        platform: "ios",
        token: capability,
        notificationPublicKey: publicKey,
        preferences: {
          approvalNeeded: true,
          waiting: true,
          failure: true,
          completion: true,
          threadTitles: false,
        },
      },
    ]);
    expect(JSON.stringify(host.bodies)).not.toContain(platformToken);
  });

  it("registers nothing with the computer when the gateway refuses or cannot be reached", async () => {
    for (const answer of [
      { status: "refused" as const, code: "unavailable" as const },
      { status: "unreachable" as const },
    ]) {
      const host = recordingHost();
      const result = await enablePhoneNotifications({
        transport: host.transport,
        hostKeyFingerprint: fingerprint,
        permission: permission(),
        requestCapability: async () => answer,
      });
      expect(result.status).toBe("refused");
      expect(host.bodies).toHaveLength(0);
    }
  });

  it("asks the gateway for nothing when the person declines notification permission", async () => {
    const requestCapability = vi.fn();
    const result = await enablePhoneNotifications({
      transport: recordingHost().transport,
      hostKeyFingerprint: fingerprint,
      permission: permission({ request: async () => "denied" }),
      requestCapability,
    });
    expect(result).toEqual({ status: "refused", reason: "permission-denied" });
    expect(requestCapability).not.toHaveBeenCalled();
  });
});
