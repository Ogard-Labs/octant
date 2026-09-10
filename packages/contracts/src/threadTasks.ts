import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * One provider-reported task inside a turn's own work plan.
 *
 * Providers restate the whole plan as it moves, so the host keeps the latest
 * list per turn keyed by the provider's own task id; it never authors steps
 * the provider did not report.
 */
export const ThreadTaskState = Schema.Literal(
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
);
export type ThreadTaskState = typeof ThreadTaskState.Type;

export const ThreadTaskProgress = Schema.Struct({
  taskId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  state: ThreadTaskState,
  summary: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_048)),
}).annotations(strict);
export type ThreadTaskProgress = typeof ThreadTaskProgress.Type;

/** How many tasks one turn's plan may carry. Beyond this it is a plan record, not a turn. */
export const MAX_THREAD_TASKS_PER_TURN = 64;

export const ThreadTaskProgressList = Schema.Array(ThreadTaskProgress).pipe(
  Schema.maxItems(MAX_THREAD_TASKS_PER_TURN),
);
export type ThreadTaskProgressList = typeof ThreadTaskProgressList.Type;

/** Replaces one entry by the provider's own task id, keeping first-seen order. */
export function upsertThreadTaskProgress(
  tasks: ThreadTaskProgressList | undefined,
  task: ThreadTaskProgress,
): ThreadTaskProgressList {
  const previous = tasks ?? [];
  const index = previous.findIndex((candidate) => candidate.taskId === task.taskId);
  if (index === -1)
    return previous.length >= MAX_THREAD_TASKS_PER_TURN ? previous : [...previous, task];
  const next = previous.slice();
  next[index] = task;
  return next;
}

export const decodeThreadTaskProgress = Schema.decodeUnknownSync(ThreadTaskProgress);
export const decodeThreadTaskProgressList = Schema.decodeUnknownSync(ThreadTaskProgressList);
