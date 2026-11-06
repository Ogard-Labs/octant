import { describe, expect, it } from "vitest";
import { decideProviderCloudSubmission } from "./providerCloudPolicy";

const request = {
  principalKind: "local-window" as const,
  personOwned: true,
  mode: "code" as const,
  executionPolicy: "full-access" as const,
  supported: true,
  enabled: true,
  current: true,
  reviewedInputDigest: "a".repeat(64),
  inputDigest: "a".repeat(64),
  cloudExecutionConsent: true,
  requiresUnsupportedBound: false,
};

describe("provider cloud submission", () => {
  it("requires this provider's opt-in and consent to the exact reviewed input", () => {
    expect(decideProviderCloudSubmission(request)).toEqual({ status: "allowed" });
    expect(decideProviderCloudSubmission({ ...request, enabled: false })).toMatchObject({
      status: "refused",
      reason: "opt-in-required",
    });
    expect(
      decideProviderCloudSubmission({ ...request, reviewedInputDigest: "b".repeat(64) }),
    ).toMatchObject({
      status: "refused",
      reason: "review-required",
    });
    expect(
      decideProviderCloudSubmission({ ...request, cloudExecutionConsent: false }),
    ).toMatchObject({
      status: "refused",
      reason: "review-required",
    });
  });

  it("refuses Plan, changed authority and a budget the remote adapter cannot enforce", () => {
    for (const input of [
      { ...request, executionPolicy: "plan" as const },
      { ...request, current: false },
      { ...request, personOwned: false },
      { ...request, principalKind: "remote-device" as const },
      { ...request, requiresUnsupportedBound: true },
    ])
      expect(decideProviderCloudSubmission(input).status).toBe("refused");
  });
});
