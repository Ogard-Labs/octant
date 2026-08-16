import { describe, expect, it } from "vitest";
import {
  decodeValidationEvidenceRecorded,
  decodeValidationPlanCreated,
  decodeValidationReportCompleted,
} from "./validationEvents";

const authority = {
  hostId: "00000000-0000-0000-0000-000000000004",
  mode: "code",
  projectId: "00000000-0000-0000-0000-000000000005",
  providerInstanceId: "00000000-0000-0000-0000-000000000006",
  extension: { kind: "core" },
};

describe("ValidationPlanCreated", () => {
  it("decodes a plan-created event payload", () => {
    const payload = decodeValidationPlanCreated({
      plan: {
        planId: "00000000-0000-4000-8000-000000000001",
        authority,
        steps: [{ stepId: "s1", description: "Run tests", sources: [] }],
        createdAt: "2026-07-24T12:00:00.000Z",
      },
    });
    expect(payload.plan.planId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("rejects excess properties", () => {
    expect(() =>
      decodeValidationPlanCreated({
        plan: {
          planId: "00000000-0000-4000-8000-000000000001",
          authority,
          steps: [{ stepId: "s1", description: "Run tests", sources: [] }],
          createdAt: "2026-07-24T12:00:00.000Z",
        },
        extra: true,
      }),
    ).toThrow();
  });
});

describe("ValidationEvidenceRecorded", () => {
  it("decodes an evidence-recorded event payload", () => {
    const payload = decodeValidationEvidenceRecorded({
      evidence: {
        evidenceId: "00000000-0000-4000-8000-000000000010",
        planId: "00000000-0000-4000-8000-000000000001",
        stepId: "s1",
        source: { kind: "repository-test", reference: "bun-test-suite-a" },
        outcome: "passed",
        authority,
        observedAt: "2026-07-24T12:01:00.000Z",
        redacted: false,
      },
    });
    expect(payload.evidence.outcome).toBe("passed");
  });
});

describe("ValidationReportCompleted", () => {
  it("decodes a report-completed event payload", () => {
    const payload = decodeValidationReportCompleted({
      report: {
        planId: "00000000-0000-4000-8000-000000000001",
        authority,
        evidence: [],
        overallOutcome: "passed",
        completedAt: "2026-07-24T12:05:00.000Z",
        stepResults: [{ stepId: "s1", outcome: "passed", evidenceCount: 1 }],
      },
    });
    expect(payload.report.overallOutcome).toBe("passed");
  });
});
