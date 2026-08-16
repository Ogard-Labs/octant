import type {
  ValidationEvidenceRecord,
  ValidationOutcome,
  ValidationPlan,
  ValidationReport,
  ToolActionAuthority,
} from "@octant/contracts";
import { sameToolActionAuthority } from "@octant/contracts";

export type ValidationPolicyDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly reason: string };

export function canRecordValidationEvidence(
  evidence: ValidationEvidenceRecord,
  plan: ValidationPlan,
  granted: ToolActionAuthority,
): ValidationPolicyDecision {
  if (!sameToolActionAuthority(evidence.authority, plan.authority)) {
    return { kind: "denied", reason: "Evidence authority does not match plan authority." };
  }
  if (!sameToolActionAuthority(evidence.authority, granted)) {
    return { kind: "denied", reason: "Evidence authority does not match granted authority." };
  }
  if (evidence.planId !== plan.planId) {
    return { kind: "denied", reason: "Evidence references a different validation plan." };
  }
  const stepExists = plan.steps.some((step) => step.stepId === evidence.stepId);
  if (!stepExists) {
    return { kind: "denied", reason: "Evidence references a step not in the plan." };
  }
  return { kind: "allowed" };
}

export function isPlanBudgetExceeded(plan: ValidationPlan, elapsedMs: number): boolean {
  if (plan.budgetMs === undefined) return false;
  return elapsedMs > plan.budgetMs;
}

export function computeOverallOutcome(
  evidence: ReadonlyArray<{ readonly outcome: ValidationOutcome }>,
): ValidationOutcome {
  if (evidence.length === 0) return "inconclusive";
  const outcomes = evidence.map((e) => e.outcome);
  // Skip-only evidence means no effective validation occurred
  const effective = outcomes.filter((o) => o !== "skipped");
  if (effective.length === 0) return "inconclusive";
  if (effective.some((o) => o === "failed")) return "failed";
  if (effective.some((o) => o === "interrupted")) return "interrupted";
  if (effective.some((o) => o === "unavailable")) return "unavailable";
  if (effective.some((o) => o === "inconclusive")) return "inconclusive";
  if (effective.every((o) => o === "passed")) return "passed";
  return "inconclusive";
}

export function buildStepResults(
  plan: ValidationPlan,
  evidence: ReadonlyArray<ValidationEvidenceRecord>,
): ReadonlyArray<{
  readonly stepId: string;
  readonly outcome: ValidationOutcome;
  readonly evidenceCount: number;
}> {
  return plan.steps.map((step) => {
    const stepEvidence = evidence.filter((e) => e.stepId === step.stepId);
    return {
      stepId: step.stepId,
      outcome: computeOverallOutcome(stepEvidence),
      evidenceCount: stepEvidence.length,
    };
  });
}

export function canReplayEvidence(
  evidence: ValidationEvidenceRecord,
  plan: ValidationPlan,
): boolean {
  if (evidence.planId !== plan.planId) return false;
  if (!sameToolActionAuthority(evidence.authority, plan.authority)) return false;
  return true;
}
