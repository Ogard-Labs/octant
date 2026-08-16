export type RemoteCredentialUseDecision =
  | { readonly kind: "usable" }
  | { readonly kind: "rejected"; readonly reason: "revoked" | "expired" | "stale-generation" };

export type CredentialGenerationDecision =
  | { readonly kind: "rotated"; readonly previousGeneration: number; readonly generation: number }
  | { readonly kind: "rejected"; readonly reason: "invalid-generation" };

export function rotateCredentialGeneration(input: {
  readonly currentGeneration: number;
}): CredentialGenerationDecision {
  if (!Number.isSafeInteger(input.currentGeneration) || input.currentGeneration < 1) {
    return { kind: "rejected", reason: "invalid-generation" };
  }
  return {
    kind: "rotated",
    previousGeneration: input.currentGeneration,
    generation: input.currentGeneration + 1,
  };
}

export type RemoteSessionUseDecision =
  | { readonly kind: "usable" }
  | {
      readonly kind: "rejected";
      readonly reason: "invalidated" | "expired" | "stale-generation";
    };

export function evaluateRemoteSessionUse(input: {
  readonly state: "active" | "invalidated" | "expired";
  readonly credentialGeneration: number;
  readonly currentCredentialGeneration: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  readonly now: number;
}): RemoteSessionUseDecision {
  if (input.state === "invalidated") return { kind: "rejected", reason: "invalidated" };
  if (
    input.state === "expired" ||
    input.now >= input.absoluteExpiresAt ||
    input.now >= input.idleExpiresAt
  ) {
    return { kind: "rejected", reason: "expired" };
  }
  if (input.credentialGeneration !== input.currentCredentialGeneration) {
    return { kind: "rejected", reason: "stale-generation" };
  }
  return { kind: "usable" };
}

export function evaluateCredentialUse(input: {
  readonly deviceState: "active" | "revoked" | "expired";
  readonly credentialGeneration: number;
  readonly presentedGeneration: number;
  readonly expiresAt: number;
  readonly now: number;
}): RemoteCredentialUseDecision {
  if (input.deviceState === "revoked") return { kind: "rejected", reason: "revoked" };
  if (input.deviceState === "expired" || input.now >= input.expiresAt) {
    return { kind: "rejected", reason: "expired" };
  }
  if (input.presentedGeneration !== input.credentialGeneration) {
    return { kind: "rejected", reason: "stale-generation" };
  }
  return { kind: "usable" };
}
