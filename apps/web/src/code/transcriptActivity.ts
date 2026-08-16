import type { CodeOperationEvent } from "@octant/contracts";

/**
 * What a running turn is doing, beyond the message it is writing.
 *
 * The host already journals tool calls, task progress, and the reasoning
 * channel; the transcript folds them into per-turn rows so a long turn reads as
 * work in progress rather than a silent "Thinking…". Rows are keyed by the
 * host's own ids, so a repeated event updates a row rather than appending one.
 */
export type CodeActivityRow =
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly toolName: string;
      readonly state: "started" | "running" | "completed" | "failed";
      readonly summary?: string;
    }
  | {
      readonly kind: "task";
      readonly id: string;
      readonly state: "pending" | "running" | "waiting" | "completed" | "failed";
      readonly summary: string;
    };

export interface CodeTurnActivity {
  readonly rows: ReadonlyArray<CodeActivityRow>;
  /** Accumulated reasoning-channel text, in arrival order. */
  readonly reasoning: string;
}

export const EMPTY_TURN_ACTIVITY: CodeTurnActivity = { rows: [], reasoning: "" };

function upsert(
  rows: ReadonlyArray<CodeActivityRow>,
  row: CodeActivityRow,
): ReadonlyArray<CodeActivityRow> {
  const index = rows.findIndex((candidate) => candidate.kind === row.kind && candidate.id === row.id);
  if (index === -1) return [...rows, row];
  return rows.map((candidate, candidateIndex) => (candidateIndex === index ? row : candidate));
}

/**
 * Folds one journaled operation event into a turn's activity. Returns the same
 * activity when the event carries nothing the transcript renders, so callers can
 * skip a re-render on the common content event.
 */
export function applyActivityEvent(
  activity: CodeTurnActivity,
  event: CodeOperationEvent,
): CodeTurnActivity {
  if (event.kind === "tool-activity") {
    return {
      ...activity,
      rows: upsert(activity.rows, {
        kind: "tool",
        id: String(event.toolCallId),
        toolName: event.toolName,
        state: event.state,
        ...(event.summary === undefined ? {} : { summary: event.summary }),
      }),
    };
  }
  if (event.kind === "task-progress") {
    return {
      ...activity,
      rows: upsert(activity.rows, {
        kind: "task",
        id: event.taskId,
        state: event.state,
        summary: event.summary,
      }),
    };
  }
  return activity;
}

export function appendReasoning(activity: CodeTurnActivity, chunk: string): CodeTurnActivity {
  if (chunk === "") return activity;
  return { ...activity, reasoning: `${activity.reasoning}${chunk}` };
}

/** How many rows are still open, for the collapsed row's summary line. */
export function activeRowCount(activity: CodeTurnActivity): number {
  return activity.rows.filter((row) =>
    row.kind === "tool"
      ? row.state === "started" || row.state === "running"
      : row.state === "pending" || row.state === "running" || row.state === "waiting",
  ).length;
}
