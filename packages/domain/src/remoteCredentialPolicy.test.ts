import { describe, expect, it } from "vitest";
import { evaluateCredentialUse } from "./remoteCredentialPolicy";

describe("remote credential lifecycle policy", () => {
  it("fails closed for revoked, expired, and stale credential generations", () => {
    const base = {
      deviceState: "active" as const,
      credentialGeneration: 2,
      expiresAt: 200,
    };

    expect(evaluateCredentialUse({ ...base, presentedGeneration: 2, now: 100 })).toEqual({
      kind: "usable",
    });
    expect(evaluateCredentialUse({ ...base, presentedGeneration: 1, now: 100 })).toEqual({
      kind: "rejected",
      reason: "stale-generation",
    });
    expect(evaluateCredentialUse({ ...base, presentedGeneration: 2, now: 200 })).toEqual({
      kind: "rejected",
      reason: "expired",
    });
    expect(
      evaluateCredentialUse({
        deviceState: "revoked",
        credentialGeneration: 2,
        presentedGeneration: 2,
        expiresAt: 200,
        now: 100,
      }),
    ).toEqual({ kind: "rejected", reason: "revoked" });
  });
});
