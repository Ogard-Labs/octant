import { describe, expect, it, vi } from "vitest";
import { presentStaleHostSecurity } from "@octant/domain";
import {
  assertBiometricConfirmed,
  requireBiometricConfirmation,
  type BiometricAuthenticator,
} from "../security/BiometricGate";

describe("mobile merge gate", () => {
  const authenticator = (outcome: "confirmed" | "denied"): BiometricAuthenticator => ({
    hasDeviceCredential: vi.fn(async () => true),
    authenticate: vi.fn(async () => outcome),
  });

  it("requires biometric confirmation before merge proceeds", async () => {
    const denied = await requireBiometricConfirmation({
      authenticator: authenticator("denied"),
      reason: "merge",
    });
    expect(() => assertBiometricConfirmed(denied, "Merge")).toThrow(/biometric/);

    const confirmed = await requireBiometricConfirmation({
      authenticator: authenticator("confirmed"),
      reason: "merge",
    });
    expect(() => assertBiometricConfirmed(confirmed, "Merge")).not.toThrow();
  });

  it("blocks product merge when host session is not ready", () => {
    expect(presentStaleHostSecurity("stale").allowProductMutations).toBe(false);
    expect(presentStaleHostSecurity("ready").allowProductMutations).toBe(true);
  });
});
