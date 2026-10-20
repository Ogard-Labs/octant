import { describe, expect, it, vi } from "vitest";
import {
  assertBiometricConfirmed,
  decideWithConfirmation,
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
        reason: "revoke",
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
      reason: "revoke",
    });
    expect(result.status).toBe("unavailable");
    expect(() => assertBiometricConfirmed(result, "Revoke")).toThrow(/blocked/);
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
      reason: "revoke",
    });

    expect(isMobileHighRiskPromptActive()).toBe(true);
    resolveAuthentication?.("confirmed");
    await expect(pending).resolves.toEqual({ status: "confirmed" });
    expect(isMobileHighRiskPromptActive()).toBe(false);
  });
});

describe("decideWithConfirmation", () => {
  it("sends the decision after the person confirms", async () => {
    const send = vi.fn(async () => "accepted");
    await expect(
      decideWithConfirmation({ authenticator: authenticator(), reason: "approve", send }),
    ).resolves.toEqual({ status: "sent", value: "accepted" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends no decision when the person cancels the prompt", async () => {
    const send = vi.fn(async () => "accepted");
    const result = await decideWithConfirmation({
      authenticator: authenticator({ authenticate: vi.fn(async () => "denied" as const) }),
      reason: "approve",
      send,
    });
    expect(result.status).toBe("blocked");
    expect(send).not.toHaveBeenCalled();
  });

  it("sends no decision and says what to set up when nothing is enrolled", async () => {
    const send = vi.fn(async () => "accepted");
    const result = await decideWithConfirmation({
      authenticator: authenticator({ hasDeviceCredential: vi.fn(async () => false) }),
      reason: "approve",
      send,
    });
    expect(result).toEqual({
      status: "blocked",
      message: "Set up Face ID, Touch ID or a passcode to allow from this phone.",
    });
    expect(send).not.toHaveBeenCalled();
  });
});
