import { describe, expect, it, vi } from "vitest";
import {
  createNativeNotificationPermissionPort,
  type OctantPushNativeModule,
} from "./octantPushModule";

const key = "K".repeat(43);

function native(overrides: Partial<OctantPushNativeModule> = {}): OctantPushNativeModule {
  return {
    isSupported: () => true,
    permissionStatus: async () => "granted",
    requestPermission: async () => "granted",
    devicePushToken: async () => "a".repeat(64),
    notificationPublicKey: async () => key,
    forgetHost: async () => undefined,
    ...overrides,
  };
}

describe("the phone's notification port over the native module", () => {
  it("passes the system's permission, token and key through", async () => {
    const notificationPublicKey = vi.fn(async () => key);
    const port = createNativeNotificationPermissionPort(native({ notificationPublicKey }), {
      platform: "ios",
    });
    expect(port.available).toBe(true);
    expect(port.platform).toBe("ios");
    expect(await port.getStatus()).toBe("granted");
    expect(await port.request()).toBe("granted");
    expect(await port.getDevicePushToken()).toBe("a".repeat(64));
    expect(await port.getNotificationPublicKey("host", "device")).toBe(key);
    expect(notificationPublicKey).toHaveBeenCalledWith("host", "device");
  });

  it("is unavailable and gives no permission, token or key where push is unsupported, as on the Simulator", async () => {
    const asked = vi.fn(async () => "granted");
    const port = createNativeNotificationPermissionPort(
      native({
        isSupported: () => false,
        requestPermission: asked,
        permissionStatus: asked,
        devicePushToken: asked,
        notificationPublicKey: asked,
      }),
      { platform: "ios" },
    );
    expect(port.available).toBe(false);
    expect(await port.getStatus()).toBe("undetermined");
    expect(await port.request()).toBe("denied");
    expect(await port.getDevicePushToken()).toBeUndefined();
    expect(await port.getNotificationPublicKey("host", "device")).toBeUndefined();
    expect(asked).not.toHaveBeenCalled();
  });

  it("is unavailable in a build with no native module", async () => {
    const port = createNativeNotificationPermissionPort(null, { platform: "android" });
    expect(port.available).toBe(false);
    expect(await port.request()).toBe("denied");
    expect(await port.getDevicePushToken()).toBeUndefined();
    await expect(port.forgetHost("host")).resolves.toBeUndefined();
  });

  it("reads a module that throws, or answers in the wrong shape, as no permission, token or key", async () => {
    const broken = async () => {
      throw new Error("native failure");
    };
    const throwing = createNativeNotificationPermissionPort(
      native({
        permissionStatus: broken,
        requestPermission: broken,
        devicePushToken: broken,
        notificationPublicKey: broken,
      }),
      { platform: "ios" },
    );
    expect(await throwing.getStatus()).toBe("undetermined");
    expect(await throwing.request()).toBe("denied");
    expect(await throwing.getDevicePushToken()).toBeUndefined();
    expect(await throwing.getNotificationPublicKey("host", "device")).toBeUndefined();

    const damaged = createNativeNotificationPermissionPort(
      native({
        isSupported: () => "yes",
        permissionStatus: async () => 1,
        requestPermission: async () => "maybe",
        devicePushToken: async () => 12345,
        notificationPublicKey: async () => "short",
      }),
      { platform: "ios" },
    );
    expect(damaged.available).toBe(false);

    const lenient = createNativeNotificationPermissionPort(
      native({
        permissionStatus: async () => 1,
        requestPermission: async () => "maybe",
        devicePushToken: async () => 12345,
        notificationPublicKey: async () => "short",
      }),
      { platform: "ios" },
    );
    expect(await lenient.getStatus()).toBe("undetermined");
    expect(await lenient.request()).toBe("denied");
    expect(await lenient.getDevicePushToken()).toBeUndefined();
    expect(await lenient.getNotificationPublicKey("host", "device")).toBeUndefined();
  });

  it("refuses an empty, padded or oversized token", async () => {
    for (const token of ["", " token", "t".repeat(4_097), null, undefined]) {
      const port = createNativeNotificationPermissionPort(
        native({ devicePushToken: async () => token }),
        { platform: "android" },
      );
      expect(await port.getDevicePushToken()).toBeUndefined();
    }
  });

  it("asks Android's run-time permission first and treats a refusal as denied without asking the module", async () => {
    const requestPermission = vi.fn(async () => "granted");
    const refused = createNativeNotificationPermissionPort(native({ requestPermission }), {
      platform: "android",
      requestRuntimePermission: async () => false,
    });
    expect(await refused.request()).toBe("denied");
    expect(requestPermission).not.toHaveBeenCalled();

    const allowed = createNativeNotificationPermissionPort(native({ requestPermission }), {
      platform: "android",
      requestRuntimePermission: async () => true,
    });
    expect(await allowed.request()).toBe("granted");
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("forgets a computer even where push is no longer supported, and reports a native failure", async () => {
    const forgetHost = vi.fn(async () => undefined);
    const unsupported = createNativeNotificationPermissionPort(
      native({ isSupported: () => false, forgetHost }),
      { platform: "ios" },
    );
    await unsupported.forgetHost("host");
    expect(forgetHost).toHaveBeenCalledWith("host");

    const failing = createNativeNotificationPermissionPort(
      native({
        forgetHost: async () => {
          throw new Error("keychain busy");
        },
      }),
      { platform: "ios" },
    );
    await expect(failing.forgetHost("host")).rejects.toThrow("keychain busy");
  });
});
