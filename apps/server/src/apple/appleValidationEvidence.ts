import {
  decodeValidationEvidenceRecord,
  decodeValidationPlan,
  decodeValidationReport,
  type AppleBuildEvidence,
  type ValidationEvidenceRecord,
  type ValidationOutcome,
  type ValidationPlan,
  type ValidationReport,
} from "@octant/contracts";

export interface ComposedAppleValidationEvents {
  readonly plan: ValidationPlan;
  readonly record: ValidationEvidenceRecord;
  readonly report: ValidationReport;
}

export function composeAppleValidationEvents(input: {
  readonly evidence: AppleBuildEvidence;
  readonly startedAt: string;
  readonly newId: () => string;
}): ComposedAppleValidationEvents {
  const stepId = `apple-${input.evidence.kind}`;
  const outcome = validationOutcome(input.evidence.outcome);
  const plan = decodeValidationPlan({
    planId: input.evidence.actionId,
    authority: input.evidence.authority,
    steps: [
      {
        stepId,
        description: `Run bounded Apple ${input.evidence.kind} validation.`,
        sources: [source(input.evidence)],
        expectedOutcome: "passed",
      },
    ],
    createdAt: input.startedAt,
    budgetMs: Math.max(1, Math.min(600_000, input.evidence.durationMs || 1)),
  });
  const record = decodeValidationEvidenceRecord({
    evidenceId: input.newId(),
    planId: plan.planId,
    stepId,
    source: source(input.evidence),
    outcome,
    authority: input.evidence.authority,
    observedAt: input.evidence.completedAt,
    ...(input.evidence.diagnostics.length === 0
      ? {}
      : {
          detail: input.evidence.diagnostics
            .map(({ severity, message }) => `${severity}: ${message}`)
            .join("\n")
            .slice(0, 8192),
        }),
    redacted: false,
  });
  const report = decodeValidationReport({
    planId: plan.planId,
    authority: input.evidence.authority,
    evidence: [record],
    overallOutcome: outcome,
    completedAt: input.evidence.completedAt,
    stepResults: [{ stepId, outcome, evidenceCount: 1 }],
  });
  return { plan, record, report };
}

function source(evidence: AppleBuildEvidence) {
  return {
    kind: evidence.kind === "test" ? ("apple-test" as const) : ("apple-build" as const),
    reference: evidence.artifacts[0]?.reference ?? `apple-action-${String(evidence.actionId)}`,
    actionId: evidence.actionId,
    correlationId: evidence.correlationId,
  };
}

function validationOutcome(outcome: AppleBuildEvidence["outcome"]): ValidationOutcome {
  switch (outcome) {
    case "succeeded":
      return "passed";
    case "failed":
    case "process-died":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "interrupted";
    case "timed-out":
      return "inconclusive";
    case "unavailable":
    case "unauthorized":
    case "invalid-destination":
      return "unavailable";
  }
}
