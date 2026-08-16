import { describe, expect, it, vi } from "vitest";
import {
  assertBiometricConfirmed,
  requireBiometricConfirmation,
  type BiometricAuthenticator,
} from "./BiometricGate";
import { isMobileHighRiskPromptActive } from "./mobileAuthPromptState";

function authenticator(overrides: Partial<BiometricAuthenticator> = {}): BiometricAuthenticator {
  return {
    hasDeviceCredential: vi.fn(async () => true),
    authenticate: vi.fn(async () => "confirmed" as const),
    ...overrides,
  };
}

describe("BiometricGate", () => {
  it("confirms when enrolled and authentication succeeds", async () => {
    await expect(
      requireBiometricConfirmation({
        authenticator: authenticator(),
        reason: "merge",
      }),
    ).resolves.toEqual({ status: "confirmed" });
  });

  it("denies high-risk actions when authentication fails", async () => {
    const result = await requireBiometricConfirmation({
      authenticator: authenticator({
        authenticate: vi.fn(async () => "denied" as const),
      }),
      reason: "approve",
    });
    expect(result).toEqual({ status: "denied" });
    expect(() => assertBiometricConfirmed(result, "Approve")).toThrow(/biometric confirmation/);
  });

  it("fails closed when nothing is enrolled", async () => {
    const result = await requireBiometricConfirmation({
      authenticator: authenticator({
        hasDeviceCredential: vi.fn(async () => false),
      }),
      reason: "merge",
    });
    expect(result.status).toBe("unavailable");
    expect(() => assertBiometricConfirmed(result, "Merge")).toThrow(/blocked/);
  });

  it("marks app-owned high-risk authentication as active until the prompt settles", async () => {
    let resolveAuthentication:
      | ((outcome: "confirmed" | "denied" | "unavailable") => void)
      | undefined;
    const authentication = new Promise<"confirmed" | "denied" | "unavailable">((resolve) => {
      resolveAuthentication = resolve;
    });
    const pending = requireBiometricConfirmation({
      authenticator: authenticator({ authenticate: vi.fn(() => authentication) }),
      reason: "merge",
    });

    expect(isMobileHighRiskPromptActive()).toBe(true);
    resolveAuthentication?.("confirmed");
    await expect(pending).resolves.toEqual({ status: "confirmed" });
    expect(isMobileHighRiskPromptActive()).toBe(false);
  });
});
