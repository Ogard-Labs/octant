import { describe, expect, it } from "vitest";
import {
  decodeValidationOutcome,
  decodeValidationSourceKind,
  decodeValidationSourceRef,
  decodeValidationStep,
  decodeValidationPlan,
  decodeValidationEvidenceRecord,
  decodeValidationReport,
  decodeValidationCompositionFailure,
} from "./validationComposition";

describe("ValidationOutcome", () => {
  it("accepts all valid outcomes", () => {
    for (const outcome of [
      "passed",
      "failed",
      "inconclusive",
      "unavailable",
      "interrupted",
      "skipped",
    ] as const) {
      expect(decodeValidationOutcome(outcome)).toBe(outcome);
    }
  });
});

describe("ValidationSourceKind", () => {
  it("accepts all valid kinds", () => {
    for (const kind of [
      "repository-test",
      "artifact-validation",
      "browser-observation",
      "computer-use-observation",
      "apple-build",
      "apple-test",
      "manual-check",
    ] as const) {
      expect(decodeValidationSourceKind(kind)).toBe(kind);
    }
  });
});

describe("ValidationSourceRef", () => {
  it("decodes a source ref", () => {
    const ref = decodeValidationSourceRef({
      kind: "repository-test",
      reference: "bun test packages/contracts",
    });
    expect(ref.kind).toBe("repository-test");
  });
  it("decodes a source ref with actionId", () => {
    const ref = decodeValidationSourceRef({
      kind: "browser-observation",
      reference: "obs-123",
      actionId: "00000000-0000-4000-8000-000000000002",
      correlationId: "00000000-0000-4000-8000-000000000003",
    });
    expect(ref.actionId).toBeDefined();
  });
});

describe("ValidationStep", () => {
  it("decodes a step", () => {
    const step = decodeValidationStep({
      stepId: "step-1",
      description: "Run contract tests",
      sources: [{ kind: "repository-test", reference: "bun test packages/contracts" }],
    });
    expect(step.stepId).toBe("step-1");
    expect(step.sources).toHaveLength(1);
  });
});

describe("ValidationPlan", () => {
  it("decodes a plan", () => {
    const plan = decodeValidationPlan({
      planId: "00000000-0000-4000-8000-000000000001",
      authority: {
        hostId: "00000000-0000-4000-8000-000000000004",
        mode: "code",
        projectId: "00000000-0000-4000-8000-000000000005",
        providerInstanceId: "00000000-0000-4000-8000-000000000006",
        extension: { kind: "core" },
      },
      steps: [{ stepId: "s1", description: "Run tests", sources: [] }],
      createdAt: "2026-07-24T12:00:00.000Z",
    });
    expect(plan.steps).toHaveLength(1);
  });
  it("rejects empty steps", () => {
    expect(() =>
      decodeValidationPlan({
        planId: "00000000-0000-4000-8000-000000000001",
        authority: {
          hostId: "00000000-0000-4000-8000-000000000004",
          mode: "code",
          projectId: "00000000-0000-4000-8000-000000000005",
          providerInstanceId: "00000000-0000-4000-8000-000000000006",
          extension: { kind: "core" },
        },
        steps: [],
        createdAt: "2026-07-24T12:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("ValidationEvidenceRecord", () => {
  it("decodes a record", () => {
    const record = decodeValidationEvidenceRecord({
      evidenceId: "00000000-0000-4000-8000-000000000010",
      planId: "00000000-0000-4000-8000-000000000001",
      stepId: "s1",
      source: { kind: "repository-test", reference: "bun test" },
      outcome: "passed",
      authority: {
        hostId: "00000000-0000-4000-8000-000000000004",
        mode: "code",
        projectId: "00000000-0000-4000-8000-000000000005",
        providerInstanceId: "00000000-0000-4000-8000-000000000006",
        extension: { kind: "core" },
      },
      observedAt: "2026-07-24T12:01:00.000Z",
      redacted: false,
    });
    expect(record.outcome).toBe("passed");
    expect(record.redacted).toBe(false);
  });
});

describe("ValidationReport", () => {
  it("decodes a report", () => {
    const report = decodeValidationReport({
      planId: "00000000-0000-4000-8000-000000000001",
      authority: {
        hostId: "00000000-0000-4000-8000-000000000004",
        mode: "code",
        projectId: "00000000-0000-4000-8000-000000000005",
        providerInstanceId: "00000000-0000-4000-8000-000000000006",
        extension: { kind: "core" },
      },
      evidence: [],
      overallOutcome: "passed",
      completedAt: "2026-07-24T12:05:00.000Z",
      stepResults: [{ stepId: "s1", outcome: "passed", evidenceCount: 1 }],
    });
    expect(report.overallOutcome).toBe("passed");
  });
});

describe("ValidationCompositionFailure", () => {
  it("decodes each failure category", () => {
    for (const category of [
      "invalid",
      "unauthorized",
      "unavailable",
      "budget-exceeded",
      "replay-denied",
    ] as const) {
      const failure = decodeValidationCompositionFailure({ category, message: "test" });
      expect(failure.category).toBe(category);
    }
  });
});
