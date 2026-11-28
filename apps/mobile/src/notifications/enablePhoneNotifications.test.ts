import type { MobileRemoteTransport } from "@octant/client-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  enablePhoneNotifications,
  forgetPhoneNotificationsForHost,
  formatEnableRefusal,
  rotatePhoneNotifications,
} from "./enablePhoneNotifications";
import type { MobileNotificationPermissionPort } from "./notificationPermissionPort";
import {
  createPushRegistrationBook,
  digestPlatformToken,
  type PushRegistrationBook,
} from "./pushRegistrationBook";

const platformToken = "a".repeat(64);
const rotatedToken = "b".repeat(64);
const hostId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";

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
    allowHost: async () => undefined,
    forgetHost: async () => undefined,
    ...overrides,
  };
}

function recordingHost(options?: {
  readonly getStatus?: () => Promise<Response>;
  readonly onPut?: () => Promise<void>;
}) {
  const bodies: unknown[] = [];
  const requests: string[] = [];
  const transport: MobileRemoteTransport = {
    hostId,
    authenticatedFetch: async (request) => {
      requests.push(`${request.method} ${request.path}`);
      if (request.method === "GET") {
        if (options?.getStatus !== undefined) return options.getStatus();
        return Response.json({
          status: "available",
          platforms: { ios: true, android: true },
        });
      }
      if (request.method === "DELETE") {
        return Response.json({ result: "cleared", occurredAt: "2026-11-28T12:00:00.000Z" });
      }
      if (options?.onPut !== undefined) await options.onPut();
      bodies.push(JSON.parse(String(request.body)));
      return Response.json({ result: "registered", occurredAt: "2026-11-28T12:00:00.000Z" });
    },
  };
  return { transport, bodies, requests };
}

describe("turning phone notifications on for a computer", () => {
  it("registers the platform token directly with threadTitles off by default and stores only a token digest", async () => {
    const host = recordingHost();
    const book = memoryBook();
    const allowHost = vi.fn(async () => undefined);

    const result = await enablePhoneNotifications({
      transport: host.transport,
      deviceId,
      permission: permission({ allowHost }),
      book,
    });

    expect(result).toEqual({ status: "registered" });
    expect(allowHost).toHaveBeenCalledWith(hostId);
    expect(host.requests).toEqual([
      "GET /api/remote/auth/push-token",
      "PUT /api/remote/auth/push-token",
    ]);
    expect(host.bodies).toEqual([
      {
        version: 2,
        platform: "ios",
        token: platformToken,
        preferences: {
          approvalNeeded: true,
          waiting: true,
          failure: true,
          completion: true,
          threadTitles: false,
        },
      },
    ]);
    const records = await book.list();
    expect(records).toEqual([
      {
        hostId,
        deviceId,
        tokenDigest: await digestPlatformToken(platformToken),
      },
    ]);
    expect(JSON.stringify(records)).not.toContain(platformToken);
  });

  it("refuses older hosts returning 404 or 405, clears local registration, and tells the person to update the host", async () => {
    for (const status of [404, 405]) {
      const host = recordingHost({
        getStatus: async () => new Response("Not Found", { status }),
      });
      const book = memoryBook();
      await book.record({
        hostId,
        deviceId,
        tokenDigest: await digestPlatformToken(platformToken),
      });
      const forgetHost = vi.fn(async () => undefined);

      const result = await enablePhoneNotifications({
        transport: host.transport,
        deviceId,
        permission: permission({ forgetHost }),
        book,
      });

      expect(result).toEqual({ status: "refused", reason: "update-host" });
      expect(formatEnableRefusal("update-host", "Studio Mac")).toBe(
        "Update Octant on Studio Mac to use notifications.",
      );
      expect(forgetHost).toHaveBeenCalledWith(hostId);
      expect(host.bodies).toHaveLength(0);
      expect(await book.list()).toEqual([]);
    }
  });

  it("refuses when the host reports push unavailable without registering", async () => {
    for (const [hostReason, expectedReason] of [
      ["off", "host-push-off"],
      ["no-credentials", "host-no-credentials"],
    ] as const) {
      const host = recordingHost({
        getStatus: async () => Response.json({ status: "unavailable", reason: hostReason }),
      });
      const book = memoryBook();
      const result = await enablePhoneNotifications({
        transport: host.transport,
        deviceId,
        permission: permission(),
        book,
      });
      expect(result).toEqual({ status: "refused", reason: expectedReason });
      expect(host.bodies).toHaveLength(0);
      expect(await book.list()).toEqual([]);
    }
  });

  it("asks the computer for nothing when permission is denied, build is unavailable, token is missing, or deviceId is absent", async () => {
    const cases = [
      { reason: "unavailable", deviceId, overrides: { available: false } },
      {
        reason: "permission-denied",
        deviceId,
        overrides: { request: async () => "denied" as const },
      },
      {
        reason: "no-platform-token",
        deviceId,
        overrides: { getDevicePushToken: async () => undefined },
      },
      { reason: "no-platform-token", deviceId, overrides: { getDevicePushToken: async () => "" } },
      { reason: "no-device-identity", deviceId: undefined, overrides: {} },
    ] as const;

    for (const testCase of cases) {
      const host = recordingHost();
      const book = memoryBook();
      const result = await enablePhoneNotifications({
        transport: host.transport,
        deviceId: testCase.deviceId,
        permission: permission(testCase.overrides),
        book,
      });
      expect(result).toEqual({ status: "refused", reason: testCase.reason });
      expect(host.requests).toEqual([]);
      expect(await book.list()).toEqual([]);
    }
  });
});

describe("toggling thread titles and new devices, and token rotation", () => {
  it("re-registers immediately when toggling Show thread names or New devices and preserves both across token rotation", async () => {
    const host = recordingHost();
    const book = memoryBook();

    await enablePhoneNotifications({
      transport: host.transport,
      deviceId,
      permission: permission(),
      book,
    });
    await enablePhoneNotifications({
      transport: host.transport,
      deviceId,
      permission: permission(),
      book,
      threadTitles: true,
    });
    await enablePhoneNotifications({
      transport: host.transport,
      deviceId,
      permission: permission(),
      book,
      newDevices: false,
    });

    const prefs = host.bodies.map(
      (body) =>
        (body as { preferences: { threadTitles: boolean; newDevices?: boolean } }).preferences,
    );
    expect(prefs).toEqual([
      { approvalNeeded: true, waiting: true, failure: true, completion: true, threadTitles: false },
      { approvalNeeded: true, waiting: true, failure: true, completion: true, threadTitles: true },
      {
        approvalNeeded: true,
        waiting: true,
        failure: true,
        completion: true,
        threadTitles: true,
        newDevices: false,
      },
    ]);

    const rotated = await rotatePhoneNotifications({
      book,
      permission: permission({ getDevicePushToken: async () => rotatedToken }),
      transportForHost: () => host.transport,
    });
    expect(rotated).toEqual({
      status: "checked",
      hosts: [{ hostId, outcome: "rotated" }],
    });
    expect(host.bodies.at(-1)).toMatchObject({
      version: 2,
      token: rotatedToken,
      preferences: { threadTitles: true, newDevices: false },
    });
  });

  it("forgets every computer when the person withdraws system notification permission", async () => {
    const host = recordingHost();
    const book = memoryBook();
    await book.record({
      hostId,
      deviceId,
      tokenDigest: await digestPlatformToken(platformToken),
    });
    const forgetHost = vi.fn(async () => undefined);

    const report = await rotatePhoneNotifications({
      book,
      permission: permission({ getStatus: async () => "denied", forgetHost }),
      transportForHost: () => host.transport,
    });
    expect(report).toEqual({
      status: "checked",
      hosts: [{ hostId, outcome: "permission-withdrawn" }],
    });
    expect(forgetHost).toHaveBeenCalledWith(hostId);
    expect(host.requests).toContain("DELETE /api/remote/auth/push-token");
    expect(await book.list()).toEqual([]);
  });

  it("cancels an in-flight enable when forgetting a computer and keeps a forgetPending marker if local cleanup fails", async () => {
    let releasePut: (() => void) | undefined;
    const putStarted = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    let finishPut: (() => void) | undefined;
    const host = recordingHost({
      onPut: async () => {
        releasePut?.();
        await new Promise<void>((resolve) => {
          finishPut = resolve;
        });
      },
    });
    const book = memoryBook();
    const enablePromise = enablePhoneNotifications({
      transport: host.transport,
      deviceId,
      permission: permission(),
      book,
    });
    await putStarted;
    const forgetPromise = forgetPhoneNotificationsForHost({
      hostId,
      permission: permission(),
      book,
      transport: host.transport,
    });
    finishPut?.();

    expect(await enablePromise).toEqual({ status: "cancelled" });
    expect(await forgetPromise).toEqual({ clearedOnComputer: true, localCleared: true });
    expect(await book.list()).toEqual([]);

    await book.record({
      hostId,
      deviceId,
      tokenDigest: await digestPlatformToken(platformToken),
    });
    const failedForget = await forgetPhoneNotificationsForHost({
      hostId,
      permission: permission({
        forgetHost: async () => {
          throw new Error("storage locked");
        },
      }),
      book,
    });
    expect(failedForget).toEqual({ clearedOnComputer: false, localCleared: false });
    expect((await book.list())[0]?.forgetPending).toBe(true);
  });
});
