export type RemoteCredentialUseDecision =
  | { readonly kind: "usable" }
  | { readonly kind: "rejected"; readonly reason: "revoked" | "expired" | "stale-generation" };

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
