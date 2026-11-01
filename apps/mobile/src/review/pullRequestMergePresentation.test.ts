import { describe, expect, it } from "vitest";
import {
  mergeConfirmationCopy,
  mergeOutcomeCopy,
  mergeWhenReadyOutcomeCopy,
} from "./pullRequestMergePresentation";

describe("pull-request merge wording on the phone", () => {
  it("names the head the person is confirming, and what Merge when ready leaves to GitHub", () => {
    const head = "9".repeat(40);
    expect(mergeConfirmationCopy("merge", 12, head)).toContain("(9999999)");
    expect(mergeConfirmationCopy("when-ready", 12, head)).toContain("once its required checks");
  });

  it("says plainly why the host refused a merge", () => {
    expect(mergeOutcomeCopy({ status: "refused", reason: "checks-not-passing" })).toBe(
      "Merge refused: the required checks have not all passed.",
    );
    expect(mergeOutcomeCopy({ status: "refused", reason: "stale" })).toContain("changed");
    expect(mergeOutcomeCopy({ status: "unavailable", reason: "unauthenticated" })).toContain(
      "sign-in",
    );
  });

  it("reports an unsupported repository instead of pretending Merge when ready is on", () => {
    expect(
      mergeWhenReadyOutcomeCopy({ status: "unsupported", reason: "auto-merge-not-allowed" }),
    ).toContain("does not allow auto-merge");
    expect(mergeWhenReadyOutcomeCopy({ status: "refused", reason: "not-authorized" })).toContain(
      "not confirmed",
    );
  });
});
