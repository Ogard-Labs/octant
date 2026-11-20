import type { ValidationOutcome } from "@octant/contracts";

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
