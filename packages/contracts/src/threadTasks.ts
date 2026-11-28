import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";

/**
 * One provider-reported task inside a turn's own work plan.
 *
 * Providers restate the whole plan as it moves, so the host keeps the latest
 * list per turn keyed by the provider's own task id; it never authors steps
 * the provider did not report.
 */
export const ThreadTaskState = Schema.Literals([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
]);
export type ThreadTaskState = typeof ThreadTaskState.Type;

export const ThreadTaskProgress = Schema.Struct({
  taskId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  state: ThreadTaskState,
  summary: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_048)),
  /**
   * The provider's wording for the task while it runs ("Running the tests").
   * Journals written before it existed omit it, and replay unchanged.
   */
  runningSummary: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_048)),
  ),
});
export type ThreadTaskProgress = typeof ThreadTaskProgress.Type;

/** How many tasks one turn's plan may carry. Beyond this it is a plan record, not a turn. */
export const MAX_THREAD_TASKS_PER_TURN = 64;

export const ThreadTaskProgressList = Schema.Array(ThreadTaskProgress).check(
  Schema.isMaxLength(MAX_THREAD_TASKS_PER_TURN),
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

/**
 * Applies a provider's restated plan: keeps only the listed tasks, in the
 * listed order. The restatement's own items arrive first as single updates,
 * and a full plan turns a new one away before the restatement can drop the
 * tasks it replaces. `turnedAway` holds those items, latest report per id, so
 * replacing a full plan, or renaming an item in one, keeps the new task.
 */
export function restateThreadTaskList(
  tasks: ThreadTaskProgressList | undefined,
  taskIds: ReadonlyArray<string>,
  turnedAway: ReadonlyMap<string, ThreadTaskProgress> = new Map(),
): ThreadTaskProgressList {
  const previous = tasks ?? [];
  const byId = new Map(previous.map((task) => [task.taskId, task]));
  const next = taskIds
    .flatMap((taskId) => {
      const task = byId.get(taskId) ?? turnedAway.get(taskId);
      if (task === undefined) return [];
      byId.delete(taskId);
      return [task];
    })
    .slice(0, MAX_THREAD_TASKS_PER_TURN);
  const unchanged =
    next.length === previous.length && next.every((task, index) => task === previous[index]);
  return unchanged ? previous : next;
}

export const decodeThreadTaskProgress = Schema.decodeUnknownSync(
  ThreadTaskProgress,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadTaskProgressList = Schema.decodeUnknownSync(
  ThreadTaskProgressList,
  STRICT_DECODE_OPTIONS,
);
