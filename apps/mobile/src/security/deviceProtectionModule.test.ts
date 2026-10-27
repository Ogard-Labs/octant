import { describe, expect, it, vi } from "vitest";
import {
  createNativeKeyStorageProtectionPort,
  createSecureWindowScreenshotPrivacyPort,
  type OctantDeviceProtectionNativeModule,
} from "./deviceProtectionModule";

function fakeNative(
  overrides: Partial<OctantDeviceProtectionNativeModule> = {},
): OctantDeviceProtectionNativeModule {
  return {
    setSecureWindow: vi.fn(async () => "applied"),
    keyStorageProtection: vi.fn(async () => "secure-hardware"),
    ...overrides,
  };
}

describe("the Android secure-window screenshot privacy", () => {
  it("is available and starts hiding Octant from screenshots and recents", async () => {
    const port = createSecureWindowScreenshotPrivacyPort(fakeNative());
    expect(port.available).toBe(true);
    expect(await port.getMode()).toBe("hide-in-recents");
  });

  it("sets the secure-window flag for hide-in-recents and clears it for standard capture", async () => {
    const native = fakeNative();
    const port = createSecureWindowScreenshotPrivacyPort(native);

    expect(await port.apply("standard")).toBe("applied");
    expect(await port.apply("hide-in-recents")).toBe("applied");

    expect(native.setSecureWindow).toHaveBeenNthCalledWith(1, false);
    expect(native.setSecureWindow).toHaveBeenNthCalledWith(2, true);
  });

  it("reports unavailable, never applied, when the window could not be reached or the answer is damaged", async () => {
    const noWindow = createSecureWindowScreenshotPrivacyPort(
      fakeNative({ setSecureWindow: async () => "unavailable" }),
    );
    expect(await noWindow.apply("hide-in-recents")).toBe("unavailable");

    const damaged = createSecureWindowScreenshotPrivacyPort(
      fakeNative({ setSecureWindow: async () => ({ status: "applied" }) }),
    );
    expect(await damaged.apply("hide-in-recents")).toBe("unavailable");

    const throwing = createSecureWindowScreenshotPrivacyPort(
      fakeNative({
        setSecureWindow: async () => {
          throw new Error("no activity");
        },
      }),
    );
    expect(await throwing.apply("hide-in-recents")).toBe("unavailable");
  });

  it("keeps the person's choice for the rest of the session", async () => {
    const port = createSecureWindowScreenshotPrivacyPort(fakeNative());
    await port.setMode("standard");
    expect(await port.getMode()).toBe("standard");
  });
});

describe("the Android key storage report", () => {
  it("reports secure hardware or software storage as the keystore answers", async () => {
    expect(await createNativeKeyStorageProtectionPort(fakeNative()).probe()).toBe(
      "secure-hardware",
    );
    expect(
      await createNativeKeyStorageProtectionPort(
        fakeNative({ keyStorageProtection: async () => "software" }),
      ).probe(),
    ).toBe("software");
  });

  it("reads an unknown, damaged, or failed answer as unavailable rather than as protected", async () => {
    for (const keyStorageProtection of [
      async () => "unknown",
      async () => "strongbox-ish",
      async () => ({ level: "secure-hardware" }),
      async () => {
        throw new Error("keystore busy");
      },
    ]) {
      expect(
        await createNativeKeyStorageProtectionPort(fakeNative({ keyStorageProtection })).probe(),
      ).toBe("unavailable");
    }
  });
});
