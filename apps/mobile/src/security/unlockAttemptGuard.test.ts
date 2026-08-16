import { describe, expect, it } from "vitest";
import {
  createUnlockAttemptGuard,
  resolveUnlockCompletion,
  shouldPreserveVaultForAppState,
  shouldSuppressAutoUnlockAfterPrompt,
} from "./unlockAttemptGuard";

describe("unlock attempt guard", () => {
  it("invalidates a pending biometric result when the app backgrounds", () => {
    const guard = createUnlockAttemptGuard();
    const attempt = guard.begin();

    guard.invalidate();

    expect(guard.isCurrent(attempt)).toBe(false);
  });

  it("keeps only the latest active unlock attempt current", () => {
    const guard = createUnlockAttemptGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("suppresses an automatic active-state retry when authentication is interrupted", () => {
    expect(shouldSuppressAutoUnlockAfterPrompt(true)).toBe(true);
    expect(shouldSuppressAutoUnlockAfterPrompt(false)).toBe(false);
  });

  it("returns a retryable locked outcome while the launch AppState is unknown", () => {
    expect(
      resolveUnlockCompletion({
        appState: null,
        attemptCurrent: true,
        resultStatus: "locked",
      }),
    ).toBe("lock");
  });

  it("preserves the unlocked vault for app-owned high-risk prompt inactivity", () => {
    expect(
      shouldPreserveVaultForAppState({ nextState: "inactive", highRiskPromptInFlight: true }),
    ).toBe(true);
    expect(
      shouldPreserveVaultForAppState({ nextState: "background", highRiskPromptInFlight: true }),
    ).toBe(false);
    expect(
      shouldPreserveVaultForAppState({ nextState: "inactive", highRiskPromptInFlight: false }),
    ).toBe(false);
  });

  it("preserves the vault while its own authentication prompt is inactive", () => {
    expect(
      shouldPreserveVaultForAppState({
        nextState: "inactive",
        highRiskPromptInFlight: false,
        vaultUnlockInFlight: true,
      }),
    ).toBe(true);
  });
});
