import type { CodeOperationEvent } from "@octant/contracts";
import { completedCallDurationMs } from "@octant/domain/turn-activity-timing";
import type { ThreadTaskProgress } from "../transcript/ThreadTasksPanel";
import type { TurnActivity, TurnActivityRow } from "../transcript/turnActivity";

export type TaskActivityRow = Extract<TurnActivityRow, { kind: "task" }>;

/**
 * A Code turn's activity split in two: the provider's task list, which the
 * turn shows as its own group, and the rest, which folds behind the turn's
 * summary line. Kept apart so a task row is never drawn or counted as a step.
 */
export function splitTurnTasks(activity: TurnActivity): {
  readonly tasks: ReadonlyArray<TaskActivityRow>;
  readonly activity: TurnActivity;
} {
  const tasks = activity.rows.filter((row): row is TaskActivityRow => row.kind === "task");
  if (tasks.length === 0) return { tasks, activity };
  return {
    tasks,
    activity: { ...activity, rows: activity.rows.filter((row) => row.kind !== "task") },
  };
}

/**
 * The newest Code turn's task list, for the Tasks dock panel: providers restate
 * their whole plan as a turn proceeds, so the latest list is the agent's
 * current work, and merging older turns would mix finished history into it.
 */
export function latestTurnTasks(
  turns: ReadonlyArray<{ readonly activity: TurnActivity | undefined; readonly running: boolean }>,
): ThreadTaskProgress | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.activity === undefined) continue;
    const { tasks } = splitTurnTasks(turn.activity);
    if (tasks.length > 0) return { tasks, running: turn.running };
    // The newest list was cleared: there is no current list, older ones are history.
    if (turn.activity.tasksCleared === true) return undefined;
  }
  return undefined;
}

function upsert(
  rows: ReadonlyArray<TurnActivityRow>,
  row: TurnActivityRow,
): ReadonlyArray<TurnActivityRow> {
  const index = rows.findIndex(
    (candidate) => candidate.kind === row.kind && candidate.id === row.id,
  );
  if (index === -1) return [...rows, row];
  return rows.map((candidate, candidateIndex) => (candidateIndex === index ? row : candidate));
}

/**
 * Applies a provider's restated plan to a turn's rows: task rows the plan no
 * longer lists go, and the rest take the plan's order in the slots task rows
 * already held, so tool rows keep their place in the transcript.
 */
function restateTaskRows(
  rows: ReadonlyArray<TurnActivityRow>,
  taskIds: ReadonlyArray<string>,
): ReadonlyArray<TurnActivityRow> {
  const tasks = new Map<string, TaskActivityRow>();
  for (const row of rows) if (row.kind === "task") tasks.set(row.id, row);
  const listed = taskIds.flatMap((taskId) => {
    const task = tasks.get(taskId);
    if (task === undefined) return [];
    tasks.delete(taskId);
    return [task];
  });
  let next = 0;
  const restated = rows.flatMap((row): ReadonlyArray<TurnActivityRow> => {
    if (row.kind !== "task") return [row];
    const task = listed[next];
    next += 1;
    return task === undefined ? [] : [task];
  });
  const unchanged =
    restated.length === rows.length && restated.every((row, index) => row === rows[index]);
  return unchanged ? rows : restated;
}

type ToolActivityRow = Extract<TurnActivityRow, { kind: "tool" }>;

function previousTool(
  rows: ReadonlyArray<TurnActivityRow>,
  id: string,
): ToolActivityRow | undefined {
  return rows.find((row): row is ToolActivityRow => row.kind === "tool" && row.id === id);
}

/**
 * Folds one journaled tool-activity event into a row. A later event that omits
 * summary keeps what the row already held, so a completed call still names the
 * last progress the host recorded; only the start names the call's argument,
 * which every later state keeps.
 */
function foldToolEvent(
  previous: ToolActivityRow | undefined,
  event: Extract<CodeOperationEvent, { kind: "tool-activity" }>,
): ToolActivityRow {
  const summary = event.summary ?? previous?.summary;
  const argument = event.argument ?? previous?.argument;
  const published = event.published ?? previous?.published;
  const outsideContent = event.outsideContent ?? previous?.outsideContent;
  const routine = event.routine ?? previous?.routine;
  const timing = completedCallDurationMs(event.timing);
  // A duplicate terminal frame carries no timing of its own: the first
  // bounded measurement the row took stands rather than being cleared by a
  // restatement that cannot measure the call.
  const durationMs = timing?.durationMs ?? previous?.durationMs;
  const waitedMs = timing === undefined ? previous?.waitedMs : timing.waitedMs;
  return {
    kind: "tool",
    id: String(event.toolCallId),
    toolName: event.toolName,
    state: event.state,
    ...(summary === undefined ? {} : { summary }),
    ...(argument === undefined ? {} : { argument }),
    ...(published === undefined ? {} : { published }),
    ...(outsideContent === undefined ? {} : { outsideContent }),
    ...(routine === undefined ? {} : { routine }),
    canvasPreview: event.canvasPreview ?? previous?.canvasPreview,
    ...(durationMs === undefined
      ? {}
      : {
          durationMs,
          ...(waitedMs !== undefined && waitedMs > 0 ? { waitedMs } : {}),
        }),
  };
}

/**
 * Folds one journaled operation event into a turn's activity. Returns the same
 * activity when the event carries nothing the transcript renders, so callers can
 * skip a re-render on the common content event.
 */
export function applyActivityEvent(
  activity: TurnActivity,
  event: CodeOperationEvent,
): TurnActivity {
  if (event.kind === "reasoning-time") {
    // The journal carries the latest cumulative total; assigning it again is
    // a no-op, so a re-read frame can never double-count.
    return activity.reasoningMs === event.reasoningMs
      ? activity
      : { ...activity, reasoningMs: event.reasoningMs };
  }
  if (event.kind === "tool-activity") {
    const id = String(event.toolCallId);
    // A tool call ends a retry wait as content does: a retried response that
    // only calls a tool streams no content.
    const { retrying: _cleared, ...rest } = activity;
    return {
      ...rest,
      rows: upsert(activity.rows, foldToolEvent(previousTool(activity.rows, id), event)),
    };
  }
  if (event.kind === "approval-reviewed") {
    return {
      ...activity,
      rows: [
        ...activity.rows,
        {
          kind: "review",
          id: `${event.decision.decidedAt}:${String(activity.rows.length)}`,
          summary: event.summary,
          decision: event.decision,
        },
      ],
    };
  }
  if (event.kind === "task-progress") {
    const { tasksCleared: _cleared, ...rest } = activity;
    return {
      ...rest,
      rows: upsert(activity.rows, {
        kind: "task",
        id: event.taskId,
        state: event.state,
        summary: event.summary,
        ...(event.runningSummary === undefined ? {} : { runningSummary: event.runningSummary }),
      }),
    };
  }
  if (event.kind === "task-list") {
    const rows = restateTaskRows(activity.rows, event.taskIds);
    // An empty restatement is the provider clearing its list (OpenCode sends
    // one), which is not the same as a turn that never wrote one: the Tasks
    // panel must stop there rather than fall back to an older turn's list.
    const cleared = event.taskIds.length === 0 ? { tasksCleared: true as const } : {};
    return rows === activity.rows && event.taskIds.length > 0
      ? activity
      : { ...activity, rows, ...cleared };
  }
  if (event.kind === "file-change") {
    const path = String(event.path);
    if (event.change === "deleted") return forgetWrittenPath(activity, path);
    const written = activity.writtenPaths ?? [];
    if (written.includes(path)) return activity;
    return { ...activity, writtenPaths: [...written, path] };
  }
  if (event.kind === "runtime-turn-started") {
    return { ...activity, runtimeTurns: (activity.runtimeTurns ?? 0) + 1 };
  }
  if (event.kind === "provider-retry") {
    return {
      ...activity,
      retrying: {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        reason: event.reason,
        announcedAt: event.announcedAt,
      },
    };
  }
  // Content ends the wait; so does the turn settling, parking, or failing
  // without content, or a failed attempt would keep "retrying 5/5 in 0 s".
  if (
    event.kind === "provider-content" ||
    (event.kind === "operation-state" && event.state !== "running") ||
    (event.kind === "operation-result" &&
      (event.result.kind === "operation-failed" ||
        (event.result.kind === "provider-turn-state" && event.result.state !== "running")))
  ) {
    if (activity.retrying === undefined) return activity;
    const { retrying: _cleared, ...rest } = activity;
    return rest;
  }
  return activity;
}

/**
 * Takes a path out of a turn's written paths.
 *
 * A deletion is a fact about the thread's files, not about the turn that
 * reported it: a later turn can remove the document an earlier turn wrote, so
 * callers apply this to every turn rather than only the addressed one.
 */
export function forgetWrittenPath(activity: TurnActivity, path: string): TurnActivity {
  const written = activity.writtenPaths;
  if (written === undefined || !written.includes(path)) return activity;
  return { ...activity, writtenPaths: written.filter((candidate) => candidate !== path) };
}

export function appendReasoning(activity: TurnActivity, chunk: string): TurnActivity {
  if (chunk === "") return activity;
  return { ...activity, reasoning: `${activity.reasoning}${chunk}` };
}
