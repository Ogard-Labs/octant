import { describe, expect, it } from "vitest";
import {
  decodeValidationEvidenceRequest,
  decodeValidationEvidenceSnapshot,
  decodeValidationEvidenceSubscribe,
  decodeValidationCompositionFailure,
  decodeValidationStepSummary,
  decodeValidationTimelineEntry,
} from "./validationRpc";

const authority = {
  hostId: "00000000-0000-0000-0000-000000000001",
  mode: "code" as const,
  projectId: "00000000-0000-0000-0000-000000000002",
  providerInstanceId: "00000000-0000-0000-0000-000000000003",
  extension: { kind: "core" as const },
};

describe("validationRpc contracts", () => {
  it("decodes a valid evidence request", () => {
    const request = decodeValidationEvidenceRequest({ authority });
    expect(request.authority.mode).toBe("code");
    expect(request.afterSequence).toBeUndefined();
  });

  it("decodes a valid evidence request with afterSequence", () => {
    const request = decodeValidationEvidenceRequest({
      authority,
      planId: "00000000-0000-0000-0000-000000000011",
      afterSequence: 42,
    });
    expect(request.planId).toBe("00000000-0000-0000-0000-000000000011");
    expect(request.afterSequence).toBe(42);
  });

  it("rejects evidence request with missing authority", () => {
    expect(() => decodeValidationEvidenceRequest({})).toThrow();
  });

  it("decodes a valid timeline entry", () => {
    const entry = decodeValidationTimelineEntry({
      sequence: 7,
      correlationId: "00000000-0000-0000-0000-000000000012",
      causationId: "00000000-0000-0000-0000-000000000013",
      evidenceId: "00000000-0000-0000-0000-000000000010",
      planId: "00000000-0000-0000-0000-000000000011",
      stepId: "step-1",
      outcome: "passed",
      sourceKind: "repository-test",
      sourceReference: "test-suite-a",
      redacted: false,
      observedAt: "2026-07-25T10:00:00.000Z",
    });
    expect(entry.outcome).toBe("passed");
    expect(entry.sourceKind).toBe("repository-test");
    expect(entry.sequence).toBe(7);
  });

  it("rejects timeline entry with invalid outcome", () => {
    expect(() =>
      decodeValidationTimelineEntry({
        sequence: 7,
        correlationId: "00000000-0000-0000-0000-000000000012",
        evidenceId: "00000000-0000-0000-0000-000000000010",
        planId: "00000000-0000-0000-0000-000000000011",
        stepId: "step-1",
        outcome: "invalid-outcome",
        sourceKind: "repository-test",
        sourceReference: "ref",
        redacted: false,
        observedAt: "2026-07-25T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it.each(["missing", "stale", "superseded"] as const)(
    "decodes a distinct %s evidence failure",
    (category) => {
      expect(
        decodeValidationCompositionFailure({ category, message: `${category} evidence` }).category,
      ).toBe(category);
    },
  );

  it("decodes a valid step summary", () => {
    const summary = decodeValidationStepSummary({
      stepId: "step-1",
      description: "Run unit tests",
      outcome: "passed",
      evidenceCount: 3,
      sourceKinds: ["repository-test"],
    });
    expect(summary.evidenceCount).toBe(3);
  });

  it("decodes a valid evidence snapshot", () => {
    const snapshot = decodeValidationEvidenceSnapshot({
      authority,
      sequence: 1,
      snapshotAt: "2026-07-25T10:00:00.000Z",
      timeline: [],
      steps: [],
      overallOutcome: "inconclusive",
    });
    expect(snapshot.overallOutcome).toBe("inconclusive");
    expect(snapshot.plan).toBeUndefined();
    expect(snapshot.report).toBeUndefined();
  });

  it("decodes a valid subscribe envelope", () => {
    const sub = decodeValidationEvidenceSubscribe({
      kind: "validation-evidence-subscribe",
      authority,
      afterSequence: 5,
    });
    expect(sub.afterSequence).toBe(5);
  });
});
