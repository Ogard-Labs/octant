/**
 * Pure policy for bringing a finished run home.
 *
 * Running the same task several ways is only useful if the results can be
 * compared and one of them can be taken. This module decides both: how a set of
 * attempts compares, and whether a particular one may be merged into the branch
 * it targets. It never runs Git; every fact it reads was measured by the host.
 */

import type { CodeRunOutcome } from "@octant/contracts/code-operations";

export type RunMergeRefusal =
  | "base-unavailable"
  | "base-not-on-branch"
  | "base-dirty"
  | "run-uncommitted"
  | "nothing-to-merge"
  | "conflicts"
  | "mergeability-unknown"
  | "head-moved";

export type RunMergeDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "refuse"; readonly reason: RunMergeRefusal };

export interface RunMergeFacts {
  readonly outcome: Pick<CodeRunOutcome, "ahead" | "mergeability" | "head" | "uncommittedPaths">;
  /** The base checkout as the host found it, immediately before merging. */
  readonly base:
    | { readonly status: "unavailable" }
    | {
        readonly status: "observed";
        readonly branch: string | undefined;
        readonly clean: boolean;
      };
  readonly baseBranch: string;
  /** The head the caller confirmed against, so a run that moved is refused. */
  readonly confirmedHead: string;
}

/**
 * Whether this run may be merged, right now, into the checkout the person
 * works in.
 *
 * Every refusal names a state the user can fix, and the strictest ones come
 * first: a merge into a dirty or differently-placed checkout is how work gets
 * lost, and no approval makes that safe. Uncommitted work inside the run itself
 * refuses too — merging a branch silently leaves it behind, and finding that
 * out afterwards is worse than being told now.
 */
export function decideRunMerge(facts: RunMergeFacts): RunMergeDecision {
  if (facts.base.status !== "observed") return { decision: "refuse", reason: "base-unavailable" };
  if (facts.base.branch !== facts.baseBranch) {
    return { decision: "refuse", reason: "base-not-on-branch" };
  }
  if (!facts.base.clean) return { decision: "refuse", reason: "base-dirty" };
  if (facts.outcome.head !== facts.confirmedHead) {
    return { decision: "refuse", reason: "head-moved" };
  }
  if (facts.outcome.uncommittedPaths.length > 0) {
    return { decision: "refuse", reason: "run-uncommitted" };
  }
  if (facts.outcome.ahead === 0 || facts.outcome.mergeability === "nothing-to-merge") {
    return { decision: "refuse", reason: "nothing-to-merge" };
  }
  if (facts.outcome.mergeability === "conflicts") {
    return { decision: "refuse", reason: "conflicts" };
  }
  if (facts.outcome.mergeability === "unknown") {
    return { decision: "refuse", reason: "mergeability-unknown" };
  }
  return { decision: "allow" };
}

export interface ParallelRunAttempt {
  readonly threadId: string;
  readonly label: string;
  readonly outcome?: CodeRunOutcome;
}

export interface ParallelRunComparisonEntry {
  readonly threadId: string;
  readonly label: string;
  readonly state: "no-outcome" | "empty" | "conflicts" | "ready";
  readonly commits: number;
  readonly changedPaths: number;
  /** Paths this attempt changed that at least one sibling changed too. */
  readonly overlappingPaths: ReadonlyArray<string>;
}

export interface ParallelRunComparison {
  readonly entries: ReadonlyArray<ParallelRunComparisonEntry>;
  /** Paths more than one attempt touched, which is where taking two would collide. */
  readonly contestedPaths: ReadonlyArray<string>;
}

/**
 * Compare the attempts on one task.
 *
 * The comparison is deliberately factual: how much each attempt changed, and
 * where they overlap. It ranks nothing and recommends nothing — which attempt
 * is better is a judgement about the work, not about its size, and pretending
 * otherwise would make the smallest diff look like the best answer.
 */
export function compareParallelRuns(
  attempts: ReadonlyArray<ParallelRunAttempt>,
): ParallelRunComparison {
  const counts = new Map<string, number>();
  for (const attempt of attempts) {
    for (const path of new Set(attempt.outcome?.changedPaths ?? [])) {
      counts.set(String(path), (counts.get(String(path)) ?? 0) + 1);
    }
  }
  const contested = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([path]) => path)
    .sort();
  const contestedSet = new Set(contested);

  return {
    entries: attempts.map((attempt) => {
      const outcome = attempt.outcome;
      const changed = (outcome?.changedPaths ?? []).map(String);
      return {
        threadId: attempt.threadId,
        label: attempt.label,
        state:
          outcome === undefined
            ? "no-outcome"
            : outcome.mergeability === "conflicts"
              ? "conflicts"
              : outcome.ahead === 0
                ? "empty"
                : "ready",
        commits: outcome?.ahead ?? 0,
        changedPaths: changed.length,
        overlappingPaths: changed.filter((path) => contestedSet.has(path)).sort(),
      };
    }),
    contestedPaths: contested,
  };
}

/** What the user is told when a merge is refused, in the words of the state. */
export function runMergeRefusalText(reason: RunMergeRefusal): string {
  switch (reason) {
    case "base-unavailable":
      return "The Project's checkout could not be read.";
    case "base-not-on-branch":
      return "The Project's checkout is on another branch. Switch to the base branch first.";
    case "base-dirty":
      return "The Project's checkout has uncommitted changes. Commit or stash them first.";
    case "run-uncommitted":
      return "This run has uncommitted changes. A merge would leave them behind.";
    case "nothing-to-merge":
      return "This run added no commits to bring home.";
    case "conflicts":
      return "This run conflicts with the base branch. Resolve it in the run first.";
    case "mergeability-unknown":
      return "Git could not say whether this merges cleanly, so it was not attempted.";
    case "head-moved":
      return "This run moved since it was reviewed. Review it again.";
  }
}
