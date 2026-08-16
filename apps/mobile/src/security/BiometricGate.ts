import type { DeviceAuthenticator } from "./AppVault";
import { beginMobileHighRiskPrompt } from "./mobileAuthPromptState";

/**
 * High-risk mobile actions (approve, reject, merge, revoke) require a biometric
 * (or device-credential) confirmation. Follow-ups after vault unlock do not.
 */

export type BiometricPromptReason = "approve" | "reject" | "merge" | "revoke";

export type BiometricGateResult =
  | { readonly status: "confirmed" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable"; readonly reason: string };

export type BiometricAuthenticator = DeviceAuthenticator;

const PROMPTS: Record<BiometricPromptReason, string> = {
  approve: "Confirm approval with biometrics",
  reject: "Confirm rejection with biometrics",
  merge: "Confirm clean pull-request merge with biometrics",
  revoke: "Confirm device revocation with biometrics",
};

export async function requireBiometricConfirmation(input: {
  readonly authenticator: BiometricAuthenticator;
  readonly reason: BiometricPromptReason;
  readonly promptMessage?: string;
}): Promise<BiometricGateResult> {
  const releasePrompt = beginMobileHighRiskPrompt();
  try {
    const hasDeviceCredential = await input.authenticator.hasDeviceCredential();
    if (!hasDeviceCredential) {
      return {
        status: "unavailable",
        reason: "No biometric or device credential is enrolled on this phone.",
      };
    }
    const outcome = await input.authenticator.authenticate({
      reason: input.reason,
      promptMessage: input.promptMessage ?? PROMPTS[input.reason],
    });
    if (outcome === "confirmed") return { status: "confirmed" };
    if (outcome === "denied") return { status: "denied" };
    return {
      status: "unavailable",
      reason: "Biometric confirmation is unavailable right now.",
    };
  } finally {
    releasePrompt();
  }
}

export function assertBiometricConfirmed(result: BiometricGateResult, actionLabel: string): void {
  if (result.status === "confirmed") return;
  if (result.status === "denied") {
    throw new Error(`${actionLabel} cancelled — biometric confirmation required.`);
  }
  throw new Error(`${actionLabel} blocked — ${result.reason}`);
}
