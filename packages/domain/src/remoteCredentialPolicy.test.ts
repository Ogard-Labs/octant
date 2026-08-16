import { describe, expect, it } from "vitest";
import {
  evaluateCredentialUse,
  evaluateRemoteSessionUse,
  rotateCredentialGeneration,
} from "./remoteCredentialPolicy";

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

  it("requires monotonic generations and invalidates sessions on exact generation changes", () => {
    expect(rotateCredentialGeneration({ currentGeneration: 3 })).toEqual({
      kind: "rotated",
      previousGeneration: 3,
      generation: 4,
    });
    expect(rotateCredentialGeneration({ currentGeneration: 0 })).toEqual({
      kind: "rejected",
      reason: "invalid-generation",
    });
    expect(
      evaluateRemoteSessionUse({
        state: "active",
        credentialGeneration: 3,
        currentCredentialGeneration: 4,
        idleExpiresAt: 200,
        absoluteExpiresAt: 300,
        now: 100,
      }),
    ).toEqual({ kind: "rejected", reason: "stale-generation" });
    expect(
      evaluateRemoteSessionUse({
        state: "active",
        credentialGeneration: 4,
        currentCredentialGeneration: 4,
        idleExpiresAt: 200,
        absoluteExpiresAt: 300,
        now: 100,
      }),
    ).toEqual({ kind: "usable" });
  });
});
