import { describe, expect, it } from "vitest";
import type { CodeRunOutcome } from "@octant/contracts/code-operations";
import {
  compareParallelRuns,
  decideRunMerge,
  runMergeRefusalText,
  type RunMergeFacts,
} from "./parallelRunPolicy";

const outcome = {
  branch: "octant/attempt-a",
  baseRef: "origin/main",
  head: "a".repeat(40),
  base: "b".repeat(40),
  ahead: 3,
  behind: 0,
  changedPaths: ["src/app.ts", "src/theme.css"],
  diff: {
    contentId: "11111111-1111-4111-8111-111111111111",
    digest: "c".repeat(64),
    byteLength: 20,
  },
  uncommittedPaths: [],
  mergeability: "clean",
} as unknown as CodeRunOutcome;

const facts: RunMergeFacts = {
  outcome,
  base: { status: "observed", branch: "main", clean: true },
  baseBranch: "main",
  confirmedHead: "a".repeat(40),
};

describe("bringing a run home", () => {
  it("allows a clean run into a clean base on the right branch", () => {
    expect(decideRunMerge(facts)).toEqual({ decision: "allow" });
  });

  it("refuses a checkout with uncommitted work rather than merging over it", () => {
    expect(
      decideRunMerge({ ...facts, base: { status: "observed", branch: "main", clean: false } }),
    ).toEqual({ decision: "refuse", reason: "base-dirty" });
  });

  it("refuses a checkout sitting on another branch", () => {
    expect(
      decideRunMerge({
        ...facts,
        base: { status: "observed", branch: "release", clean: true },
      }),
    ).toEqual({ decision: "refuse", reason: "base-not-on-branch" });
  });

  it("refuses a run that moved since it was reviewed", () => {
    expect(decideRunMerge({ ...facts, confirmedHead: "d".repeat(40) })).toEqual({
      decision: "refuse",
      reason: "head-moved",
    });
  });

  it("refuses a run whose own work is not committed, rather than leaving it behind", () => {
    expect(
      decideRunMerge({
        ...facts,
        outcome: {
          ...outcome,
          uncommittedPaths: ["src/app.ts"],
        } as unknown as CodeRunOutcome,
      }),
    ).toEqual({ decision: "refuse", reason: "run-uncommitted" });
  });

  it("refuses a run with nothing in it", () => {
    expect(
      decideRunMerge({ ...facts, outcome: { ...outcome, ahead: 0 } as CodeRunOutcome }),
    ).toEqual({ decision: "refuse", reason: "nothing-to-merge" });
  });

  it("refuses a conflicting run and an unknowable one alike", () => {
    expect(
      decideRunMerge({
        ...facts,
        outcome: { ...outcome, mergeability: "conflicts" } as CodeRunOutcome,
      }),
    ).toEqual({ decision: "refuse", reason: "conflicts" });
    expect(
      decideRunMerge({
        ...facts,
        outcome: { ...outcome, mergeability: "unknown" } as CodeRunOutcome,
      }),
    ).toEqual({ decision: "refuse", reason: "mergeability-unknown" });
  });

  it("says why in words the user can act on", () => {
    expect(runMergeRefusalText("base-dirty")).toContain("Commit or stash");
    expect(runMergeRefusalText("run-uncommitted")).toContain("leave them behind");
  });
});

describe("comparing the attempts on one task", () => {
  const attempts = [
    { threadId: "thread-a", label: "Attempt A", outcome },
    {
      threadId: "thread-b",
      label: "Attempt B",
      outcome: {
        ...outcome,
        branch: "octant/attempt-b",
        ahead: 1,
        changedPaths: ["src/app.ts", "src/router.ts"],
      } as unknown as CodeRunOutcome,
    },
    { threadId: "thread-c", label: "Attempt C" },
  ];

  it("names the paths more than one attempt touched", () => {
    expect(compareParallelRuns(attempts).contestedPaths).toEqual(["src/app.ts"]);
  });

  it("reports what each attempt did without ranking them", () => {
    const comparison = compareParallelRuns(attempts);
    expect(comparison.entries.map((entry) => entry.state)).toEqual([
      "ready",
      "ready",
      "no-outcome",
    ]);
    expect(comparison.entries[0]?.commits).toBe(3);
    expect(comparison.entries[0]?.overlappingPaths).toEqual(["src/app.ts"]);
    expect(comparison.entries[2]?.changedPaths).toBe(0);
  });

  it("says plainly when an attempt produced nothing or cannot land", () => {
    const comparison = compareParallelRuns([
      { threadId: "empty", label: "Empty", outcome: { ...outcome, ahead: 0 } as CodeRunOutcome },
      {
        threadId: "conflicted",
        label: "Conflicted",
        outcome: { ...outcome, mergeability: "conflicts" } as CodeRunOutcome,
      },
    ]);
    expect(comparison.entries.map((entry) => entry.state)).toEqual(["empty", "conflicts"]);
  });

  it("finds nothing contested when the attempts touched different files", () => {
    expect(
      compareParallelRuns([
        { threadId: "a", label: "A", outcome },
        {
          threadId: "b",
          label: "B",
          outcome: { ...outcome, changedPaths: ["docs/readme.md"] } as unknown as CodeRunOutcome,
        },
      ]).contestedPaths,
    ).toEqual([]);
  });
});
