import type {
  AgentRunAuthority,
  LinkedThreadAggregateStatus,
  LinkedThreadTargetResult,
} from "@octant/contracts";
import { MAX_LINKED_THREAD_TARGETS } from "@octant/contracts";

export const REVIEW_IN_PARALLEL_SKILL_NAME = "review-in-parallel";

export const LINKED_THREAD_REVIEW_ISOLATED_AUTHORITY: AgentRunAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: false,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};

export type ReviewInParallelSkillPromptResult =
  | {
      readonly kind: "linked-thread-fan-out";
      readonly skillName: typeof REVIEW_IN_PARALLEL_SKILL_NAME;
      readonly prompt: string;
      readonly requestedCount: number;
      readonly authority: AgentRunAuthority;
    }
  | { readonly kind: "invalid"; readonly reason: string };

export function resolveReviewInParallelSkillPrompt(input: {
  readonly task: string;
  readonly requestedCount: number;
  readonly maxTargets?: number;
}): ReviewInParallelSkillPromptResult {
  const task = input.task.trim();
  if (task.length === 0) {
    throw new Error("Parallel review requires a non-empty task instruction.");
  }
  const maxTargets = input.maxTargets ?? MAX_LINKED_THREAD_TARGETS;
  if (!Number.isSafeInteger(input.requestedCount) || input.requestedCount < 1) {
    return { kind: "invalid", reason: "Parallel review requires at least one reviewer." };
  }
  const requestedCount = Math.min(input.requestedCount, maxTargets);
  return {
    kind: "linked-thread-fan-out",
    skillName: REVIEW_IN_PARALLEL_SKILL_NAME,
    prompt: `/review ${requestedCount} threads ${task}`,
    requestedCount,
    authority: LINKED_THREAD_REVIEW_ISOLATED_AUTHORITY,
  };
}

const TERMINAL_FAILURE: ReadonlySet<LinkedThreadTargetResult["status"]> = new Set([
  "rejected",
  "failed",
]);

export function aggregateLinkedThreadResults(input: {
  readonly requestedCount: number;
  readonly results: ReadonlyArray<LinkedThreadTargetResult>;
}): {
  readonly status: LinkedThreadAggregateStatus;
  readonly results: ReadonlyArray<LinkedThreadTargetResult>;
} {
  if (input.results.length !== input.requestedCount) {
    throw new Error(
      "Linked-thread aggregation requires one result per requested peer before deriving status.",
    );
  }
  const statuses = input.results.map((result) => result.status);
  const unique = new Set(statuses);
  let status: LinkedThreadAggregateStatus;
  if (unique.size === 1) {
    const only = statuses[0]!;
    status =
      only === "created"
        ? "created"
        : only === "queued"
          ? "queued"
          : only === "rejected"
            ? "rejected"
            : "failed";
  } else if (statuses.every((entry) => TERMINAL_FAILURE.has(entry))) {
    status = "failed";
  } else {
    status = "partial";
  }
  return { status, results: input.results };
}
