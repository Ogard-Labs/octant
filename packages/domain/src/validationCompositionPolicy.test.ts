import { describe, expect, it } from "vitest";
import {
  canRecordValidationEvidence,
  isPlanBudgetExceeded,
  computeOverallOutcome,
  buildStepResults,
  canReplayEvidence,
} from "./validationCompositionPolicy";
import type {
  ValidationEvidenceRecord,
  ValidationPlan,
  ToolActionAuthority,
} from "@octant/contracts";

const authority: ToolActionAuthority = {
  hostId: "00000000-0000-4000-8000-000000000004" as any,
  mode: "code",
  projectId: "00000000-0000-4000-8000-000000000005" as any,
  providerInstanceId: "00000000-0000-4000-8000-000000000006" as any,
  extension: { kind: "core" },
};

const plan: ValidationPlan = {
  planId: "00000000-0000-4000-8000-000000000001" as any,
  authority,
  steps: [
    { stepId: "s1", description: "Run tests", sources: [] },
    { stepId: "s2", description: "Check artifacts", sources: [] },
  ],
  createdAt: "2026-07-24T12:00:00.000Z" as any,
  budgetMs: 60_000,
};

function makeEvidence(overrides?: Partial<ValidationEvidenceRecord>): ValidationEvidenceRecord {
  return {
    evidenceId: "00000000-0000-4000-8000-000000000010" as any,
    planId: plan.planId,
    stepId: "s1",
    source: { kind: "repository-test", reference: "bun test" },
    outcome: "passed",
    authority,
    observedAt: "2026-07-24T12:01:00.000Z" as any,
    redacted: false,
    ...overrides,
  };
}

describe("canRecordValidationEvidence", () => {
  it("allows matching authority and plan", () => {
    expect(canRecordValidationEvidence(makeEvidence(), plan, authority).kind).toBe("allowed");
  });

  it("denies mismatched authority", () => {
    const other: ToolActionAuthority = { ...authority, mode: "chat" };
    expect(canRecordValidationEvidence(makeEvidence(), plan, other).kind).toBe("denied");
  });

  it("denies wrong plan", () => {
    expect(
      canRecordValidationEvidence(
        makeEvidence({ planId: "00000000-0000-4000-8000-000000000099" as any }),
        plan,
        authority,
      ).kind,
    ).toBe("denied");
  });

  it("denies unknown step", () => {
    expect(
      canRecordValidationEvidence(makeEvidence({ stepId: "unknown" }), plan, authority).kind,
    ).toBe("denied");
  });
});

describe("isPlanBudgetExceeded", () => {
  it("returns false within budget", () => {
    expect(isPlanBudgetExceeded(plan, 30_000)).toBe(false);
  });

  it("returns true over budget", () => {
    expect(isPlanBudgetExceeded(plan, 60_001)).toBe(true);
  });

  it("returns false when no budget", () => {
    expect(isPlanBudgetExceeded({ ...plan, budgetMs: undefined }, 999_999)).toBe(false);
  });
});

describe("computeOverallOutcome", () => {
  it("returns inconclusive for empty evidence", () => {
    expect(computeOverallOutcome([])).toBe("inconclusive");
  });

  it("returns passed when all pass", () => {
    expect(computeOverallOutcome([makeEvidence()])).toBe("passed");
  });

  it("returns failed when any fails", () => {
    expect(computeOverallOutcome([makeEvidence(), makeEvidence({ outcome: "failed" })])).toBe(
      "failed",
    );
  });

  it("returns interrupted when any interrupted", () => {
    expect(computeOverallOutcome([makeEvidence(), makeEvidence({ outcome: "interrupted" })])).toBe(
      "interrupted",
    );
  });

  it("returns unavailable when any unavailable", () => {
    expect(computeOverallOutcome([makeEvidence(), makeEvidence({ outcome: "unavailable" })])).toBe(
      "unavailable",
    );
  });

  it("returns passed when mix of passed and skipped", () => {
    expect(computeOverallOutcome([makeEvidence(), makeEvidence({ outcome: "skipped" })])).toBe(
      "passed",
    );
  });

  it("returns inconclusive when all evidence is skipped", () => {
    expect(
      computeOverallOutcome([
        makeEvidence({ outcome: "skipped" }),
        makeEvidence({ outcome: "skipped" }),
      ]),
    ).toBe("inconclusive");
  });
});

describe("buildStepResults", () => {
  it("builds results for each step", () => {
    const results = buildStepResults(plan, [makeEvidence()]);
    expect(results).toHaveLength(2);
    expect(results[0]!.stepId).toBe("s1");
    expect(results[0]!.outcome).toBe("passed");
    expect(results[0]!.evidenceCount).toBe(1);
    expect(results[1]!.stepId).toBe("s2");
    expect(results[1]!.outcome).toBe("inconclusive");
    expect(results[1]!.evidenceCount).toBe(0);
  });
});

describe("canReplayEvidence", () => {
  it("returns true for matching evidence", () => {
    expect(canReplayEvidence(makeEvidence(), plan)).toBe(true);
  });

  it("returns false for mismatched plan", () => {
    expect(
      canReplayEvidence(
        makeEvidence({ planId: "00000000-0000-4000-8000-000000000099" as any }),
        plan,
      ),
    ).toBe(false);
  });
});
