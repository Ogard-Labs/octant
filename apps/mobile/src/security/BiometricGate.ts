import type { DeviceAuthenticator } from "./AppVault";
import { MOBILE_COPY } from "../copy";
import { beginMobileHighRiskPrompt } from "./mobileAuthPromptState";

/**
 * Granting authority (approve) and revoking this device require a biometric
 * (or device-credential) confirmation. Denying never does: refusing is the
 * safe direction, so a locked or unenrolled phone can still say no. Follow-ups
 * after vault unlock do not need it either.
 */

export type BiometricPromptReason = "approve" | "revoke";

export type BiometricGateResult =
  | { readonly status: "confirmed" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable"; readonly reason: string };

export type BiometricAuthenticator = DeviceAuthenticator;

const PROMPTS: Record<BiometricPromptReason, string> = {
  approve: "Confirm approval with biometrics",
  revoke: "Confirm device revocation with biometrics",
};

export async function requireBiometricConfirmation(input: {
  readonly authenticator: BiometricAuthenticator;
  readonly reason: BiometricPromptReason;
  readonly promptMessage?: string;
}): Promise<BiometricGateResult> {
  const releasePrompt = beginMobileHighRiskPrompt();
  try {
    // A native auth API that throws is "cannot confirm", not a send failure.
    const hasDeviceCredential = await input.authenticator
      .hasDeviceCredential()
      .catch(() => undefined);
    if (hasDeviceCredential === undefined) {
      return {
        status: "unavailable",
        reason: "Biometric confirmation is unavailable right now.",
      };
    }
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

export type ConfirmedSendResult<T> =
  | { readonly status: "sent"; readonly value: T }
  | { readonly status: "blocked"; readonly message: string };

/**
 * Runs `send` only after the person confirmed on this phone. Unavailable and
 * denied both fail closed: nothing is sent and the caller gets words to show.
 */
export async function decideWithConfirmation<T>(input: {
  readonly authenticator: BiometricAuthenticator;
  readonly reason: BiometricPromptReason;
  readonly send: () => Promise<T>;
}): Promise<ConfirmedSendResult<T>> {
  const gate = await requireBiometricConfirmation({
    authenticator: input.authenticator,
    reason: input.reason,
  });
  if (gate.status === "unavailable") {
    return { status: "blocked", message: MOBILE_COPY.approvalBiometricUnavailable };
  }
  if (gate.status === "denied") {
    return { status: "blocked", message: MOBILE_COPY.approvalBiometricDenied };
  }
  return { status: "sent", value: await input.send() };
}
