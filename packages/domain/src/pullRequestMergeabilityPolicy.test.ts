import { describe, expect, it } from "vitest";
import { decidePullRequestMergeability } from "./pullRequestMergeabilityPolicy";

const base = {
  state: "open" as const,
  mergeable: true as boolean | null,
  headSha: "a".repeat(40),
  expectedHeadSha: "a".repeat(40),
  requiredChecksPassing: true,
  mergeMethod: "squash" as const,
  advertisedMergeMethods: ["merge", "squash", "rebase"] as const,
};

describe("decidePullRequestMergeability", () => {
  it("allows a clean open PR when checks pass and SHA matches", () => {
    expect(decidePullRequestMergeability(base)).toEqual({ decision: "allow" });
  });

  it("fails closed on draft, conflict, checks, SHA mismatch, and unsupported method", () => {
    expect(decidePullRequestMergeability({ ...base, state: "draft" })).toEqual({
      decision: "deny",
      code: "draft",
    });
    expect(decidePullRequestMergeability({ ...base, mergeable: false })).toEqual({
      decision: "deny",
      code: "conflict",
    });
    expect(decidePullRequestMergeability({ ...base, mergeable: null })).toEqual({
      decision: "deny",
      code: "unknown-mergeable",
    });
    expect(decidePullRequestMergeability({ ...base, requiredChecksPassing: false })).toEqual({
      decision: "deny",
      code: "checks",
    });
    expect(decidePullRequestMergeability({ ...base, expectedHeadSha: "b".repeat(40) })).toEqual({
      decision: "deny",
      code: "sha-mismatch",
    });
    expect(
      decidePullRequestMergeability({
        ...base,
        mergeMethod: "rebase",
        advertisedMergeMethods: ["merge", "squash"],
      }),
    ).toEqual({ decision: "deny", code: "method-unsupported" });
  });
});
