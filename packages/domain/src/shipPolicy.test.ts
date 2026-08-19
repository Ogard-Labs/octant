import { describe, expect, it } from "vitest";
import { decideShip, shipRefusalText, type ShipFacts } from "./shipPolicy";

const digest = "sha256:aaaa";
const revision = "1111111111111111111111111111111111111111";

function facts(overrides: Partial<ShipFacts> = {}): ShipFacts {
  return {
    targetId: "target-1",
    targetEnabled: true,
    credentialBound: true,
    executionPolicy: "approval-gated",
    checkoutClean: true,
    headRevision: revision,
    reviewedRevision: revision,
    artifact: { digest, observedDigest: digest, producedByRunId: "run-1" },
    approval: { kind: "per-act", targetId: "target-1", revision, artifactDigest: digest },
    ...overrides,
  };
}

describe("deciding whether something may be published to a user-owned target", () => {
  it("ships when the host observed the build and a person approved this exact act", () => {
    expect(decideShip(facts())).toEqual({ decision: "ship" });
  });

  it("is never covered by a standing grant, however broad", () => {
    expect(decideShip(facts({ approval: { kind: "standing" } }))).toEqual({
      decision: "refuse",
      reason: "approval-not-per-act",
    });
  });

  it("refuses an approval given for a different target, revision, or artifact", () => {
    expect(
      decideShip(
        facts({
          approval: { kind: "per-act", targetId: "other", revision, artifactDigest: digest },
        }),
      ),
    ).toEqual({ decision: "refuse", reason: "approval-not-per-act" });
    expect(
      decideShip(
        facts({
          approval: {
            kind: "per-act",
            targetId: "target-1",
            revision: "2".repeat(40),
            artifactDigest: digest,
          },
        }),
      ),
    ).toEqual({ decision: "refuse", reason: "approval-not-per-act" });
    expect(
      decideShip(
        facts({
          approval: {
            kind: "per-act",
            targetId: "target-1",
            revision,
            artifactDigest: "sha256:bbbb",
          },
        }),
      ),
    ).toEqual({ decision: "refuse", reason: "approval-not-per-act" });
  });

  it("refuses work the host cannot vouch for", () => {
    expect(decideShip(facts({ checkoutClean: false }))).toEqual({
      decision: "refuse",
      reason: "checkout-dirty",
    });
    expect(decideShip(facts({ reviewedRevision: "2".repeat(40) }))).toEqual({
      decision: "refuse",
      reason: "revision-not-reviewed",
    });
    expect(decideShip(facts({ reviewedRevision: undefined }))).toEqual({
      decision: "refuse",
      reason: "revision-not-reviewed",
    });
  });

  it("refuses an artifact no run of this host produced", () => {
    expect(
      decideShip(
        facts({ artifact: { digest, observedDigest: digest, producedByRunId: undefined } }),
      ),
    ).toEqual({ decision: "refuse", reason: "artifact-unobserved" });
  });

  it("refuses an artifact whose bytes are not the ones the host saw", () => {
    expect(
      decideShip(
        facts({
          artifact: { digest, observedDigest: "sha256:cccc", producedByRunId: "run-1" },
        }),
      ),
    ).toEqual({ decision: "refuse", reason: "artifact-digest-mismatch" });
  });

  it("refuses a target that is installed but not yet usable, and one with no credential bound", () => {
    expect(decideShip(facts({ targetEnabled: false }))).toEqual({
      decision: "refuse",
      reason: "target-not-enabled",
    });
    expect(decideShip(facts({ credentialBound: false }))).toEqual({
      decision: "refuse",
      reason: "credential-unbound",
    });
  });

  it("refuses in Plan mode, because read-only is a promise about the outside world too", () => {
    expect(decideShip(facts({ executionPolicy: "plan" }))).toEqual({
      decision: "refuse",
      reason: "plan-mode",
    });
  });

  it("refuses under full access exactly as it does under any other posture", () => {
    expect(
      decideShip(facts({ executionPolicy: "full-access", approval: { kind: "none" } })),
    ).toEqual({ decision: "refuse", reason: "approval-required" });
  });

  it("gives every refusal words that name what to do about it", () => {
    for (const reason of [
      "revision-not-reviewed",
      "checkout-dirty",
      "artifact-unobserved",
      "artifact-digest-mismatch",
      "credential-unbound",
      "approval-required",
      "approval-not-per-act",
      "target-not-enabled",
      "plan-mode",
    ] as const) {
      expect(shipRefusalText(reason).length).toBeGreaterThan(0);
    }
  });
});
