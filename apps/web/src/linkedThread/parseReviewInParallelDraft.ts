import { REVIEW_IN_PARALLEL_SKILL_NAME } from "@octant/plugin-host";

export interface ReviewInParallelDraft {
  readonly task: string;
  readonly requestedCount: number;
}

const DEFAULT_TASK = "Review the current conversation context.";
const DEFAULT_REQUESTED_COUNT = 2;

export function parseReviewInParallelDraft(draft: string): ReviewInParallelDraft | null {
  const trimmed = draft.trim();
  const reference = `$${REVIEW_IN_PARALLEL_SKILL_NAME}`;
  if (trimmed === reference) {
    return { task: DEFAULT_TASK, requestedCount: DEFAULT_REQUESTED_COUNT };
  }
  if (!trimmed.startsWith(`${reference} `)) return null;
  const task = trimmed.slice(reference.length + 1).trim();
  if (task.length === 0) return { task: DEFAULT_TASK, requestedCount: DEFAULT_REQUESTED_COUNT };
  return { task, requestedCount: DEFAULT_REQUESTED_COUNT };
}

export function isReviewInParallelReference(draft: string): boolean {
  return parseReviewInParallelDraft(draft) !== null;
}
