import type { ProviderExecutionPolicy } from "@octant/contracts";
import { actsAsHostPerson, type PrincipalKind } from "./remoteAccessPolicy";

export type ProviderCloudRefusalReason =
  | "unavailable"
  | "unauthorized"
  | "plan"
  | "opt-in-required"
  | "review-required"
  | "unsupported-budget";

export type ProviderCloudSubmissionDecision =
  | { readonly status: "allowed" }
  | { readonly status: "refused"; readonly reason: ProviderCloudRefusalReason };

export function decideProviderCloudSubmission(input: {
  readonly principalKind: PrincipalKind;
  readonly personOwned: boolean;
  readonly mode: "chat" | "work" | "code";
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly current: boolean;
  readonly reviewedInputDigest: string;
  readonly inputDigest: string;
  readonly cloudExecutionConsent: boolean;
  readonly requiresUnsupportedBound: boolean;
}): ProviderCloudSubmissionDecision {
  if (!actsAsHostPerson(input.principalKind) || !input.personOwned || !input.current) {
    return { status: "refused", reason: "unauthorized" };
  }
  if (input.mode !== "code" || !input.supported) {
    return { status: "refused", reason: "unavailable" };
  }
  if (input.executionPolicy === "plan") return { status: "refused", reason: "plan" };
  if (!input.enabled) return { status: "refused", reason: "opt-in-required" };
  if (
    !input.cloudExecutionConsent ||
    !/^[a-f0-9]{64}$/.test(input.inputDigest) ||
    input.reviewedInputDigest !== input.inputDigest
  )
    return { status: "refused", reason: "review-required" };
  if (input.requiresUnsupportedBound) return { status: "refused", reason: "unsupported-budget" };
  return { status: "allowed" };
}
