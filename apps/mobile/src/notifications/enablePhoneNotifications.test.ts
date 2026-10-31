import type { MobileRemoteTransport } from "@octant/client-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  MOBILE_PUSH_GATEWAY_URL,
  enablePhoneNotifications,
  forgetPhoneNotificationsForHost,
  rotatePhoneNotifications,
} from "./enablePhoneNotifications";
import type { MobileNotificationPermissionPort } from "./notificationPermissionPort";
import {
  createPushRegistrationBook,
  digestPlatformToken,
  type PushRegistrationBook,
} from "./pushRegistrationBook";

const platformToken = "a".repeat(64);
const fingerprint = "f".repeat(64);
const capability = `v1.k1.${"C".repeat(64)}`;
const publicKey = "K".repeat(43);
const hostId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const rotatedToken = "b".repeat(64);
const rotatedCapability = `v1.k1.${"D".repeat(64)}`;

function memoryBook(): PushRegistrationBook {
  const values = new Map<string, string>();
  return createPushRegistrationBook({
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => void values.set(key, value),
    deleteItem: async (key) => void values.delete(key),
  });
}

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
  const requests: string[] = [];
  const transport: MobileRemoteTransport = {
    hostId,
    authenticatedFetch: async (request) => {
      requests.push(`${request.method} ${request.path}`);
      if (request.method === "DELETE") {
        return Response.json({ result: "cleared", occurredAt: "2026-10-28T12:00:00.000Z" });
      }
      bodies.push(JSON.parse(String(request.body)));
      return Response.json({ result: "registered", occurredAt: "2026-10-28T12:00:00.000Z" });
    },
  };
  return { transport, bodies, requests };
}

describe("turning phone notifications on for a computer", () => {
  it("gives the computer a gateway capability bound to its key, never the platform token", async () => {
    const host = recordingHost();
    const book = memoryBook();
    const requestCapability = vi.fn(async () => ({ status: "issued" as const, capability }));
    const getNotificationPublicKey = vi.fn(async () => publicKey);

    const result = await enablePhoneNotifications({
      transport: host.transport,
      hostKeyFingerprint: fingerprint,
      deviceId,
      permission: permission({ getNotificationPublicKey }),
      book,
      requestCapability,
    });

    expect(result).toEqual({ status: "registered" });
    // The key is made for this computer and the device id it knows the phone by,
    // because the computer seals to both.
    expect(getNotificationPublicKey).toHaveBeenCalledWith(hostId, deviceId);
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
    // The phone keeps a digest of the token it registered under, never the token.
    const records = await book.list();
    expect(records).toEqual([
      {
        hostId,
        deviceId,
        hostKeyFingerprint: fingerprint,
        tokenDigest: await digestPlatformToken(platformToken),
      },
    ]);
    expect(JSON.stringify(records)).not.toContain(platformToken);
  });

  it("registers nothing with the computer when the gateway refuses or cannot be reached", async () => {
    for (const answer of [
      { status: "refused" as const, code: "unavailable" as const },
      { status: "unreachable" as const },
    ]) {
      const host = recordingHost();
      const book = memoryBook();
      const result = await enablePhoneNotifications({
        transport: host.transport,
        hostKeyFingerprint: fingerprint,
        deviceId,
        permission: permission(),
        book,
        requestCapability: async () => answer,
      });
      expect(result.status).toBe("refused");
      expect(host.bodies).toHaveLength(0);
      expect(await book.list()).toEqual([]);
    }
  });

  it("asks the gateway for nothing when the person declines notification permission", async () => {
    const requestCapability = vi.fn();
    const result = await enablePhoneNotifications({
      transport: recordingHost().transport,
      hostKeyFingerprint: fingerprint,
      deviceId,
      permission: permission({ request: async () => "denied" }),
      book: memoryBook(),
      requestCapability,
    });
    expect(result).toEqual({ status: "refused", reason: "permission-denied" });
    expect(requestCapability).not.toHaveBeenCalled();
  });

  it("asks the system for nothing on a build or device that cannot receive push", async () => {
    const request = vi.fn(async () => "granted" as const);
    const result = await enablePhoneNotifications({
      transport: recordingHost().transport,
      hostKeyFingerprint: fingerprint,
      deviceId,
      permission: permission({ available: false, request }),
      book: memoryBook(),
    });
    expect(result).toEqual({ status: "refused", reason: "unavailable" });
    expect(request).not.toHaveBeenCalled();
  });

  it("registers nothing when the system gives no token, no key can be made, or the pairing has no device id", async () => {
    const cases: ReadonlyArray<{
      readonly reason: string;
      readonly deviceId: string | undefined;
      readonly overrides: Partial<MobileNotificationPermissionPort>;
    }> = [
      {
        reason: "no-platform-token",
        deviceId,
        overrides: { getDevicePushToken: async () => undefined },
      },
      { reason: "no-platform-token", deviceId, overrides: { getDevicePushToken: async () => "" } },
      {
        reason: "no-notification-key",
        deviceId,
        overrides: { getNotificationPublicKey: async () => undefined },
      },
      { reason: "no-device-identity", deviceId: undefined, overrides: {} },
    ];
    for (const testCase of cases) {
      const host = recordingHost();
      const requestCapability = vi.fn();
      const book = memoryBook();
      const result = await enablePhoneNotifications({
        transport: host.transport,
        hostKeyFingerprint: fingerprint,
        deviceId: testCase.deviceId,
        permission: permission(testCase.overrides),
        book,
        requestCapability,
      });
      expect(result).toEqual({ status: "refused", reason: testCase.reason });
      expect(requestCapability).not.toHaveBeenCalled();
      expect(host.requests).toEqual([]);
      expect(await book.list()).toEqual([]);
    }
  });
});

async function registeredBook(token = platformToken) {
  const book = memoryBook();
  await book.record({
    hostId,
    deviceId,
    hostKeyFingerprint: fingerprint,
    tokenDigest: await digestPlatformToken(token),
  });
  return book;
}

describe("rotating the platform token a computer was registered under", () => {
  it("registers the new token with each connected computer once the system issues one", async () => {
    const host = recordingHost();
    const book = await registeredBook();
    const requestCapability = vi.fn(async () => ({
      status: "issued" as const,
      capability: rotatedCapability,
    }));

    const report = await rotatePhoneNotifications({
      book,
      permission: permission({ getDevicePushToken: async () => rotatedToken }),
      transportForHost: () => host.transport,
      requestCapability,
    });

    expect(report).toEqual({ status: "checked", hosts: [{ hostId, outcome: "rotated" }] });
    expect(requestCapability).toHaveBeenCalledWith({
      gatewayUrl: MOBILE_PUSH_GATEWAY_URL,
      platform: "ios",
      token: rotatedToken,
      hostKeyFingerprint: fingerprint,
    });
    expect(host.bodies).toMatchObject([
      { token: rotatedCapability, notificationPublicKey: publicKey },
    ]);
    expect(JSON.stringify(host.bodies)).not.toContain(rotatedToken);
    expect((await book.list())[0]?.tokenDigest).toBe(await digestPlatformToken(rotatedToken));

    // The next run finds nothing to do.
    const again = await rotatePhoneNotifications({
      book,
      permission: permission({ getDevicePushToken: async () => rotatedToken }),
      transportForHost: () => host.transport,
      requestCapability,
    });
    expect(again.hosts).toEqual([{ hostId, outcome: "unchanged" }]);
    expect(requestCapability).toHaveBeenCalledTimes(1);
  });

  it("touches neither the gateway nor the computer while the token is the one it registered", async () => {
    const host = recordingHost();
    const requestCapability = vi.fn();
    const report = await rotatePhoneNotifications({
      book: await registeredBook(),
      permission: permission(),
      transportForHost: () => host.transport,
      requestCapability,
    });
    expect(report.hosts).toEqual([{ hostId, outcome: "unchanged" }]);
    expect(requestCapability).not.toHaveBeenCalled();
    expect(host.requests).toEqual([]);
  });

  it("keeps a record it could not renew so the next run tries again", async () => {
    const host = recordingHost();
    const book = await registeredBook();
    const rotated = permission({ getDevicePushToken: async () => rotatedToken });
    const before = await book.list();

    const notConnected = await rotatePhoneNotifications({
      book,
      permission: rotated,
      transportForHost: () => undefined,
    });
    expect(notConnected.hosts).toEqual([{ hostId, outcome: "not-connected" }]);

    const unreachable = await rotatePhoneNotifications({
      book,
      permission: rotated,
      transportForHost: () => host.transport,
      requestCapability: async () => ({ status: "unreachable" }),
    });
    expect(unreachable.hosts).toEqual([{ hostId, outcome: "failed" }]);

    const hostRefuses: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: async () => new Response("no", { status: 503 }),
    };
    const refused = await rotatePhoneNotifications({
      book,
      permission: rotated,
      transportForHost: () => hostRefuses,
      requestCapability: async () => ({ status: "issued", capability: rotatedCapability }),
    });
    expect(refused.hosts).toEqual([{ hostId, outcome: "failed" }]);

    expect(await book.list()).toEqual(before);
    expect(host.bodies).toHaveLength(0);
  });

  it("clears every registration and forgets its key once notifications are off in the system", async () => {
    const host = recordingHost();
    const book = await registeredBook();
    const forgetHost = vi.fn(async () => undefined);

    const report = await rotatePhoneNotifications({
      book,
      permission: permission({ getStatus: async () => "denied", forgetHost }),
      transportForHost: () => host.transport,
    });

    expect(report.hosts).toEqual([{ hostId, outcome: "permission-withdrawn" }]);
    expect(host.requests).toEqual(["DELETE /api/remote/auth/push-token"]);
    expect(forgetHost).toHaveBeenCalledWith(hostId);
    expect(await book.list()).toEqual([]);
  });

  it("changes nothing on a build that cannot tell, or when the system gives no token", async () => {
    const book = await registeredBook();
    const before = await book.list();
    const forgetHost = vi.fn(async () => undefined);

    expect(
      await rotatePhoneNotifications({
        book,
        permission: permission({ available: false, forgetHost }),
        transportForHost: () => undefined,
      }),
    ).toEqual({ status: "unavailable", hosts: [] });
    expect(
      await rotatePhoneNotifications({
        book,
        permission: permission({ getDevicePushToken: async () => undefined, forgetHost }),
        transportForHost: () => undefined,
      }),
    ).toEqual({ status: "no-platform-token", hosts: [] });
    expect(
      await rotatePhoneNotifications({
        book: memoryBook(),
        permission: permission(),
        transportForHost: () => undefined,
      }),
    ).toEqual({ status: "nothing-registered", hosts: [] });

    expect(forgetHost).not.toHaveBeenCalled();
    expect(await book.list()).toEqual(before);
  });
});

describe("forgetting a computer's notifications when it is unpaired", () => {
  it("asks the computer to drop its registration, then forgets the key and the record", async () => {
    const host = recordingHost();
    const book = await registeredBook();
    const order: string[] = [];
    const forgetHost = vi.fn(async () => void order.push("forget"));
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: async (request) => {
        order.push("clear");
        return host.transport.authenticatedFetch(request);
      },
    };

    const outcome = await forgetPhoneNotificationsForHost({
      hostId,
      permission: permission({ forgetHost }),
      book,
      transport,
    });

    expect(outcome).toEqual({ clearedOnComputer: true, keyForgotten: true });
    expect(order).toEqual(["clear", "forget"]);
    expect(await book.list()).toEqual([]);
  });

  it("still forgets the key and the record when the computer cannot be reached or does not answer", async () => {
    const answers: ReadonlyArray<MobileRemoteTransport["authenticatedFetch"]> = [
      async () => {
        throw new Error("offline");
      },
      async () => new Response("gone", { status: 403 }),
      () => new Promise<Response>(() => undefined),
    ];
    for (const authenticatedFetch of answers) {
      const book = await registeredBook();
      const forgetHost = vi.fn(async () => undefined);
      const outcome = await forgetPhoneNotificationsForHost({
        hostId,
        permission: permission({ forgetHost }),
        book,
        transport: { hostId, authenticatedFetch },
        waitMs: 20,
      });
      expect(outcome).toEqual({ clearedOnComputer: false, keyForgotten: true });
      expect(forgetHost).toHaveBeenCalledWith(hostId);
      expect(await book.list()).toEqual([]);
    }
  });

  it("drops the record and reports the key when the native side fails to forget it", async () => {
    const book = await registeredBook();
    const outcome = await forgetPhoneNotificationsForHost({
      hostId,
      permission: permission({
        forgetHost: async () => {
          throw new Error("keychain busy");
        },
      }),
      book,
    });
    expect(outcome).toEqual({ clearedOnComputer: false, keyForgotten: false });
    expect(await book.list()).toEqual([]);
  });

  it("leaves other computers' records alone", async () => {
    const book = await registeredBook();
    await book.record({
      hostId: "33333333-3333-4333-8333-333333333333",
      deviceId,
      hostKeyFingerprint: fingerprint,
      tokenDigest: "d".repeat(64),
    });
    await forgetPhoneNotificationsForHost({ hostId, permission: permission(), book });
    expect((await book.list()).map((record) => record.hostId)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
  });
});
