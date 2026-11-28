import { describe, expect, it, vi } from "vitest";
import {
  createNativeNotificationPermissionPort,
  type OctantPushNativeModule,
} from "./octantPushModule";

function native(overrides: Partial<OctantPushNativeModule> = {}): OctantPushNativeModule {
  return {
    isSupported: () => true,
    permissionStatus: async () => "granted",
    requestPermission: async () => "granted",
    devicePushToken: async () => "a".repeat(64),
    allowHost: async () => true,
    forgetHost: async () => true,
    ...overrides,
  };
}

describe("the phone's notification port over the native module", () => {
  it("passes the system's permission, token, allowHost, and forgetHost through", async () => {
    const allowHost = vi.fn(async () => true);
    const port = createNativeNotificationPermissionPort(native({ allowHost }), {
      platform: "ios",
    });
    expect(port.available).toBe(true);
    expect(port.platform).toBe("ios");
    expect(await port.getStatus()).toBe("granted");
    expect(await port.request()).toBe("granted");
    expect(await port.getDevicePushToken()).toBe("a".repeat(64));
    await port.allowHost?.("host");
    expect(allowHost).toHaveBeenCalledWith("host");
  });

  it("is unavailable and gives no permission or token where push is unsupported, as on the Simulator", async () => {
    const asked = vi.fn(async () => "granted");
    const port = createNativeNotificationPermissionPort(
      native({
        isSupported: () => false,
        requestPermission: asked,
        permissionStatus: asked,
        devicePushToken: asked,
      }),
      { platform: "ios" },
    );
    expect(port.available).toBe(false);
    expect(await port.getStatus()).toBe("undetermined");
    expect(await port.request()).toBe("denied");
    expect(await port.getDevicePushToken()).toBeUndefined();
    expect(asked).not.toHaveBeenCalled();
  });

  it("is unavailable in a build with no native module", async () => {
    const port = createNativeNotificationPermissionPort(null, { platform: "android" });
    expect(port.available).toBe(false);
    expect(await port.request()).toBe("denied");
    expect(await port.getDevicePushToken()).toBeUndefined();
    await expect(port.forgetHost("host")).resolves.toBeUndefined();
  });

  it("reads a module that throws, or answers in the wrong shape, as no permission or token", async () => {
    const broken = async () => {
      throw new Error("native failure");
    };
    const throwing = createNativeNotificationPermissionPort(
      native({
        permissionStatus: broken,
        requestPermission: broken,
        devicePushToken: broken,
      }),
      { platform: "ios" },
    );
    expect(await throwing.getStatus()).toBe("undetermined");
    expect(await throwing.request()).toBe("denied");
    expect(await throwing.getDevicePushToken()).toBeUndefined();

    const damaged = createNativeNotificationPermissionPort(
      native({
        isSupported: () => "yes",
        permissionStatus: async () => 1,
        requestPermission: async () => "maybe",
        devicePushToken: async () => 12345,
      }),
      { platform: "ios" },
    );
    expect(damaged.available).toBe(false);

    const lenient = createNativeNotificationPermissionPort(
      native({
        permissionStatus: async () => 1,
        requestPermission: async () => "maybe",
        devicePushToken: async () => 12345,
      }),
      { platform: "ios" },
    );
    expect(await lenient.getStatus()).toBe("undetermined");
    expect(await lenient.request()).toBe("denied");
    expect(await lenient.getDevicePushToken()).toBeUndefined();
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
    const forgetHost = vi.fn(async () => true);
    const unsupported = createNativeNotificationPermissionPort(
      native({ isSupported: () => false, forgetHost }),
      { platform: "ios" },
    );
    await unsupported.forgetHost("host");
    expect(forgetHost).toHaveBeenCalledWith("host");

    const failing = createNativeNotificationPermissionPort(
      native({
        forgetHost: async () => {
          throw new Error("storage busy");
        },
      }),
      { platform: "ios" },
    );
    await expect(failing.forgetHost("host")).rejects.toThrow("storage busy");
  });

  it("reports a cleanup failure rather than treating any answer as success", async () => {
    for (const answer of [false, undefined, null, "true", 0]) {
      const port = createNativeNotificationPermissionPort(
        native({ forgetHost: async () => answer }),
        { platform: "android" },
      );
      await expect(port.forgetHost("host")).rejects.toThrow("could not clear");
    }
    const port = createNativeNotificationPermissionPort(native({ forgetHost: async () => true }), {
      platform: "android",
    });
    await expect(port.forgetHost("host")).resolves.toBeUndefined();
  });
});
