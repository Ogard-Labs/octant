import { describe, expect, it } from "vitest";
import { requestedWorkerOptions } from "./plannerProposalReview";

describe("a coordinator's proposed worker in its review", () => {
  it("says which model and highest level the coordinator asked for", () => {
    expect(requestedWorkerOptions({ modelId: "model-a", executionPolicy: "approval-gated" })).toBe(
      "The coordinator asked for this worker on model-a at Ask first or lower.",
    );
    expect(requestedWorkerOptions({ executionPolicy: "auto-accept-edits" })).toBe(
      "The coordinator asked for this worker at Accept edits or lower.",
    );
  });
});
