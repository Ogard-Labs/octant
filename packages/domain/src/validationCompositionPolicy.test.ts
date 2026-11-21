import { describe, expect, it } from "vitest";
import { computeOverallOutcome } from "./validationCompositionPolicy";
import type { ValidationOutcome } from "@octant/contracts";

function makeEvidence(outcome: ValidationOutcome = "passed"): {
  readonly outcome: ValidationOutcome;
} {
  return { outcome };
}

describe("computeOverallOutcome", () => {
  it("returns inconclusive for empty evidence", () => {
    expect(computeOverallOutcome([])).toBe("inconclusive");
  });

  it("returns passed when all pass", () => {
    expect(computeOverallOutcome([makeEvidence()])).toBe("passed");
  });

  it("returns failed when any fails", () => {
    expect(computeOverallOutcome([makeEvidence(), makeEvidence("failed")])).toBe("failed");
  });

  it("returns interrupted when any interrupted", () => {
    expect(computeOverallOutcome([makeEvidence(), makeEvidence("interrupted")])).toBe(
      "interrupted",
    );
  });

  it("returns unavailable when any unavailable", () => {
    expect(computeOverallOutcome([makeEvidence(), makeEvidence("unavailable")])).toBe(
      "unavailable",
    );
  });

  it("returns passed when mix of passed and skipped", () => {
    expect(computeOverallOutcome([makeEvidence(), makeEvidence("skipped")])).toBe("passed");
  });

  it("returns inconclusive when all evidence is skipped", () => {
    expect(computeOverallOutcome([makeEvidence("skipped"), makeEvidence("skipped")])).toBe(
      "inconclusive",
    );
  });
});
