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
      /**
       * Latest journaled summary. The contract does not distinguish arguments
       * from output; this is a progress or result message, not captured tool I/O.
       */
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
  /**
   * Whether the durable turn journaled more steps than the conversation page
   * carries back. Only replayed history can set this; a live turn is watched
   * event by event and misses nothing.
   */
  readonly truncated?: boolean;
}

export const EMPTY_TURN_ACTIVITY: CodeTurnActivity = { rows: [], reasoning: "" };

function upsert(
  rows: ReadonlyArray<CodeActivityRow>,
  row: CodeActivityRow,
): ReadonlyArray<CodeActivityRow> {
  const index = rows.findIndex(
    (candidate) => candidate.kind === row.kind && candidate.id === row.id,
  );
  if (index === -1) return [...rows, row];
  return rows.map((candidate, candidateIndex) => (candidateIndex === index ? row : candidate));
}

type ToolActivityRow = Extract<CodeActivityRow, { kind: "tool" }>;

function previousTool(
  rows: ReadonlyArray<CodeActivityRow>,
  id: string,
): ToolActivityRow | undefined {
  return rows.find((row): row is ToolActivityRow => row.kind === "tool" && row.id === id);
}

/**
 * Folds one journaled tool-activity event into a row. A later event that omits
 * summary keeps what the row already held, so a completed call still names the
 * last progress the host recorded.
 */
function foldToolEvent(
  previous: ToolActivityRow | undefined,
  event: Extract<CodeOperationEvent, { kind: "tool-activity" }>,
): ToolActivityRow {
  const summary = event.summary ?? previous?.summary;
  return {
    kind: "tool",
    id: String(event.toolCallId),
    toolName: event.toolName,
    state: event.state,
    ...(summary === undefined ? {} : { summary }),
  };
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
    const id = String(event.toolCallId);
    return {
      ...activity,
      rows: upsert(activity.rows, foldToolEvent(previousTool(activity.rows, id), event)),
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

/** How many rows are still open. */
export function activeRowCount(activity: CodeTurnActivity): number {
  return activity.rows.filter((row) =>
    row.kind === "tool"
      ? row.state === "started" || row.state === "running"
      : row.state === "pending" || row.state === "running" || row.state === "waiting",
  ).length;
}

/**
 * Rows that must stay visible even when a settled turn's toolchain is folded:
 * a task waiting on approval, or any still-open step. Judging a change you
 * cannot see is the fold's failure mode.
 */
export function alwaysVisibleActivityRows(
  activity: CodeTurnActivity,
): ReadonlyArray<CodeActivityRow> {
  return activity.rows.filter((row) =>
    row.kind === "tool"
      ? row.state === "started" || row.state === "running"
      : row.state === "pending" || row.state === "running" || row.state === "waiting",
  );
}

/** Tool names that usually mutate files — used only for the quiet summary line. */
export function isFileEditToolName(toolName: string): boolean {
  const name = toolName.trim().toLowerCase();
  return (
    name === "write" ||
    name === "edit" ||
    name === "multiedit" ||
    name === "strreplace" ||
    name === "str_replace" ||
    name === "applypatch" ||
    name === "apply_patch" ||
    name === "notebookedit" ||
    name === "create_file" ||
    name === "delete_file" ||
    name.includes("edit") ||
    name.includes("write") ||
    name.includes("patch")
  );
}

/**
 * One quiet line for a settled turn's machinery, e.g. "12 tool calls · 4 files
 * edited". Empty when there is nothing to fold.
 */
export function settledTurnActivitySummary(activity: CodeTurnActivity): string {
  const toolCalls = activity.rows.filter((row) => row.kind === "tool").length;
  const filesEdited = activity.rows.filter(
    (row) => row.kind === "tool" && isFileEditToolName(row.toolName),
  ).length;
  const tasks = activity.rows.filter((row) => row.kind === "task").length;
  const thinking = activity.reasoning.trim().length > 0;
  const parts: string[] = [];
  if (toolCalls > 0) {
    parts.push(`${toolCalls} ${toolCalls === 1 ? "tool call" : "tool calls"}`);
  }
  if (filesEdited > 0) {
    parts.push(`${filesEdited} ${filesEdited === 1 ? "file edited" : "files edited"}`);
  }
  if (tasks > 0 && toolCalls === 0) {
    parts.push(`${tasks} ${tasks === 1 ? "task" : "tasks"}`);
  }
  if (thinking && (parts.length === 0 || (toolCalls === 0 && filesEdited === 0))) {
    parts.push("Thinking");
  }
  return parts.join(" · ");
}
