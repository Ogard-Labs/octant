import { describe, expect, it, vi } from "vitest";
import {
  createNativeKeyStorageProtectionPort,
  createSecureWindowScreenshotPrivacyPort,
  type OctantDeviceProtectionNativeModule,
} from "./deviceProtectionModule";
import { describeKeyStorageProtection } from "./keyStorageProtectionPort";
import { describeScreenshotProtection } from "./screenshotPrivacyPort";

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
    const port = createSecureWindowScreenshotPrivacyPort(
      fakeNative(),
      "screenshots-recording-and-recents",
    );
    expect(port.available).toBe(true);
    expect(await port.getMode()).toBe("hide-in-recents");
  });

  it("sets the secure-window flag for hide-in-recents and clears it for standard capture", async () => {
    const native = fakeNative();
    const port = createSecureWindowScreenshotPrivacyPort(
      native,
      "screenshots-recording-and-recents",
    );

    expect(await port.apply("standard")).toBe("applied");
    expect(await port.apply("hide-in-recents")).toBe("applied");

    expect(native.setSecureWindow).toHaveBeenNthCalledWith(1, false);
    expect(native.setSecureWindow).toHaveBeenNthCalledWith(2, true);
  });

  it("reports unavailable, never applied, when the window could not be reached or the answer is damaged", async () => {
    const noWindow = createSecureWindowScreenshotPrivacyPort(
      fakeNative({ setSecureWindow: async () => "unavailable" }),
      "screenshots-recording-and-recents",
    );
    expect(await noWindow.apply("hide-in-recents")).toBe("unavailable");

    const damaged = createSecureWindowScreenshotPrivacyPort(
      fakeNative({ setSecureWindow: async () => ({ status: "applied" }) }),
      "screenshots-recording-and-recents",
    );
    expect(await damaged.apply("hide-in-recents")).toBe("unavailable");

    const throwing = createSecureWindowScreenshotPrivacyPort(
      fakeNative({
        setSecureWindow: async () => {
          throw new Error("no activity");
        },
      }),
      "screenshots-recording-and-recents",
    );
    expect(await throwing.apply("hide-in-recents")).toBe("unavailable");
  });

  it("keeps the person's choice for the rest of the session", async () => {
    const port = createSecureWindowScreenshotPrivacyPort(
      fakeNative(),
      "screenshots-recording-and-recents",
    );
    await port.setMode("standard");
    expect(await port.getMode()).toBe("standard");
  });

  it("says screenshots, recordings, and the recents preview show no Octant content", () => {
    expect(describeScreenshotProtection("screenshots-recording-and-recents")).toBe(
      "Screenshots, screen recordings, and the recents preview show no Octant content.",
    );
  });
});

describe("the iOS screenshot privacy", () => {
  it("starts protected and covers the app through the same native switch", async () => {
    const native = fakeNative();
    const port = createSecureWindowScreenshotPrivacyPort(native, "app-switcher-and-recording");

    expect(port.available).toBe(true);
    expect(port.coverage).toBe("app-switcher-and-recording");
    expect(await port.getMode()).toBe("hide-in-recents");
    expect(await port.apply("standard")).toBe("applied");
    expect(native.setSecureWindow).toHaveBeenCalledWith(false);
  });

  it("names the app switcher and screen recording, and says plainly that a screenshot is not blocked", () => {
    const said = describeScreenshotProtection("app-switcher-and-recording");
    expect(said).toBe(
      "The app switcher and a recorded or mirrored screen show no Octant content. iOS cannot block a screenshot, so avoid taking one of sensitive thread content.",
    );
  });
});

describe("the Android key storage report", () => {
  it("reports secure hardware or software storage as the keystore answers", async () => {
    expect(
      await createNativeKeyStorageProtectionPort(fakeNative(), "android-keystore").probe(),
    ).toBe("secure-hardware");
    expect(
      await createNativeKeyStorageProtectionPort(
        fakeNative({ keyStorageProtection: async () => "software" }),
        "android-keystore",
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
        await createNativeKeyStorageProtectionPort(
          fakeNative({ keyStorageProtection }),
          "android-keystore",
        ).probe(),
      ).toBe("unavailable");
    }
  });

  it("says the keys are encrypted with a hardware-held key, not that the keys live in the hardware", () => {
    expect(describeKeyStorageProtection("secure-hardware", "android-keystore")).toBe(
      "Octant's keys are encrypted with a key held in this phone's secure hardware.",
    );
    expect(describeKeyStorageProtection("software", "android-keystore")).toBe(
      "This phone offers no secure hardware for keys, so Octant's keys are protected by software storage only.",
    );
  });
});

describe("the iOS key storage report", () => {
  it("says the keys stay in this phone's Keychain under the Secure Enclave's protection", async () => {
    const port = createNativeKeyStorageProtectionPort(fakeNative(), "ios-keychain");
    expect(port.vault).toBe("ios-keychain");
    expect(describeKeyStorageProtection(await port.probe(), port.vault)).toBe(
      "Octant's keys are kept in this phone's Keychain, encrypted under keys its Secure Enclave protects. They can be read only while the phone is unlocked, and a backup cannot carry them to another device.",
    );
  });

  it("says a device without a Secure Enclave protects the keys in software only", () => {
    expect(describeKeyStorageProtection("software", "ios-keychain")).toBe(
      "This device has no Secure Enclave, so the Keychain protects Octant's keys in software only. A backup cannot carry them to another device.",
    );
  });

  it("claims nothing when the answer is missing", () => {
    expect(describeKeyStorageProtection("unavailable", "ios-keychain")).toBe(
      "This build does not report where Octant's keys are held.",
    );
  });
});
