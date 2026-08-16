import { describe, expect, it } from "vitest";
import { parseReviewInParallelDraft } from "./parseReviewInParallelDraft";

describe("parseReviewInParallelDraft", () => {
  it("parses a bare $review-in-parallel reference with defaults", () => {
    expect(parseReviewInParallelDraft("$review-in-parallel")).toEqual({
      task: "Review the current conversation context.",
      requestedCount: 2,
    });
  });

  it("parses a bundled skill reference with trailing task text", () => {
    expect(parseReviewInParallelDraft("$review-in-parallel Check the API surface.")).toEqual({
      task: "Check the API surface.",
      requestedCount: 2,
    });
  });

  it("returns null for unrelated composer input", () => {
    expect(parseReviewInParallelDraft("@build-tools")).toBeNull();
    expect(parseReviewInParallelDraft("Review in parallel")).toBeNull();
  });
});
