import { describe, expect, it } from "vitest";
import type { LinkedThreadTargetResult } from "@octant/contracts";
import {
  aggregateLinkedThreadResults,
  LINKED_THREAD_REVIEW_ISOLATED_AUTHORITY,
  REVIEW_IN_PARALLEL_SKILL_NAME,
  resolveReviewInParallelSkillPrompt,
} from "./linkedThreadAggregationPolicy";

describe("LINKED_THREAD_REVIEW_ISOLATED_AUTHORITY", () => {
  it("defaults to read-only plan execution with no widening capabilities", () => {
    expect(LINKED_THREAD_REVIEW_ISOLATED_AUTHORITY).toEqual({
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: false,
      subagents: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    });
  });
});

describe("resolveReviewInParallelSkillPrompt", () => {
  it("builds a bounded linked-thread fan-out prompt from the bundled skill", () => {
    const result = resolveReviewInParallelSkillPrompt({
      task: "Review the migration plan for security risks.",
      requestedCount: 3,
    });
    expect(result).toMatchObject({
      kind: "linked-thread-fan-out",
      skillName: REVIEW_IN_PARALLEL_SKILL_NAME,
      requestedCount: 3,
    });
  });

  it("clamps requested count to the linked-thread maximum", () => {
    const result = resolveReviewInParallelSkillPrompt({
      task: "Check the API surface.",
      requestedCount: 9,
      maxTargets: 4,
    });
    expect(result.kind).toBe("linked-thread-fan-out");
    if (result.kind !== "linked-thread-fan-out") throw new Error("expected fan-out");
    expect(result.requestedCount).toBe(4);
  });
});

describe("aggregateLinkedThreadResults", () => {
  const base = (
    status: LinkedThreadTargetResult["status"],
    index: number,
  ): LinkedThreadTargetResult =>
    status === "created"
      ? {
          targetIndex: index,
          label: `Reviewer ${index}`,
          status,
          threadId: `${index}${"0".repeat(35)}` as never,
        }
      : status === "queued"
        ? { targetIndex: index, label: `Reviewer ${index}`, status }
        : { targetIndex: index, label: `Reviewer ${index}`, status, reason: `${status} reason` };

  it("returns partial for mixed peer outcomes", () => {
    expect(
      aggregateLinkedThreadResults({
        requestedCount: 3,
        results: [base("created", 1), base("queued", 2), base("rejected", 3)],
      }).status,
    ).toBe("partial");
  });

  it("rejects aggregates with fewer results than requested", () => {
    expect(() =>
      aggregateLinkedThreadResults({ requestedCount: 3, results: [base("created", 1)] }),
    ).toThrow();
  });
});
