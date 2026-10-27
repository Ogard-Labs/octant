import { beforeEach, describe, expect, it, vi } from "vitest";

const localAuthentication = vi.hoisted(() => ({
  authenticateAsync: vi.fn(),
  getEnrolledLevelAsync: vi.fn(),
}));

const platform = vi.hoisted(() => ({ OS: "android", Version: 34 as number | string }));

vi.mock("react-native", () => ({ Platform: platform }));

vi.mock("expo-local-authentication", () => ({
  ...localAuthentication,
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));

const { createExpoBiometricAuthenticator } = await import("./expoBiometricAuthenticator");

describe("the phone's biometric confirmation", () => {
  beforeEach(() => {
    localAuthentication.authenticateAsync.mockReset();
    localAuthentication.getEnrolledLevelAsync.mockReset();
    platform.OS = "android";
    platform.Version = 34;
  });

  it("accepts only strong biometrics or the device credential, never a weak face unlock", async () => {
    localAuthentication.authenticateAsync.mockResolvedValue({ success: true });

    const outcome = await createExpoBiometricAuthenticator().authenticate({
      reason: "approve",
      promptMessage: "Confirm approval with biometrics",
    });

    expect(outcome).toBe("confirmed");
    expect(localAuthentication.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        biometricsSecurityLevel: "strong",
        disableDeviceFallback: false,
      }),
    );
  });

  it("keeps Android's default class on Android 9 and 10, which cannot pair strong biometrics with the device credential", async () => {
    localAuthentication.authenticateAsync.mockResolvedValue({ success: true });
    const authenticator = createExpoBiometricAuthenticator();

    for (const version of [28, 29]) {
      platform.Version = version;
      expect(
        await authenticator.authenticate({ reason: "approve", promptMessage: "Confirm" }),
      ).toBe("confirmed");
      expect(localAuthentication.authenticateAsync).toHaveBeenLastCalledWith(
        expect.objectContaining({ biometricsSecurityLevel: "weak", disableDeviceFallback: false }),
      );
    }
    for (const version of [27, 30]) {
      platform.Version = version;
      await authenticator.authenticate({ reason: "approve", promptMessage: "Confirm" });
      expect(localAuthentication.authenticateAsync).toHaveBeenLastCalledWith(
        expect.objectContaining({ biometricsSecurityLevel: "strong" }),
      );
    }
  });

  it("reads a cancelled or failed prompt as denied and a throwing prompt as unavailable", async () => {
    const authenticator = createExpoBiometricAuthenticator();
    localAuthentication.authenticateAsync.mockResolvedValueOnce({
      success: false,
      error: "user_cancel",
    });
    expect(await authenticator.authenticate({ reason: "revoke", promptMessage: "Confirm" })).toBe(
      "denied",
    );
    localAuthentication.authenticateAsync.mockRejectedValueOnce(new Error("no activity"));
    expect(await authenticator.authenticate({ reason: "revoke", promptMessage: "Confirm" })).toBe(
      "unavailable",
    );
  });

  it("counts a phone with only a PIN as having a device credential", async () => {
    const authenticator = createExpoBiometricAuthenticator();
    localAuthentication.getEnrolledLevelAsync.mockResolvedValueOnce(1);
    expect(await authenticator.hasDeviceCredential()).toBe(true);
    localAuthentication.getEnrolledLevelAsync.mockResolvedValueOnce(0);
    expect(await authenticator.hasDeviceCredential()).toBe(false);
  });
});
