import type { HarnessRetryNotice, PublishedPage, ThreadToolStep } from "@octant/contracts";

/**
 * What a running turn is doing, beyond the message it is writing.
 *
 * The host journals tool calls, task progress, and the reasoning channel; the
 * transcript folds them into per-turn rows so a long turn reads as work in
 * progress rather than a silent "Thinking…". Rows are keyed by the host's own
 * ids, so a repeated event updates a row rather than appending one.
 */
export type TurnActivityRow =
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
      /** The page a completed call published, shown as its own card under the rows. */
      readonly publishedPage?: PublishedPage;
    }
  | {
      readonly kind: "task";
      readonly id: string;
      readonly state: "pending" | "running" | "waiting" | "completed" | "failed";
      readonly summary: string;
    };

export interface TurnActivity {
  readonly rows: ReadonlyArray<TurnActivityRow>;
  /** Accumulated reasoning-channel text, in arrival order. */
  readonly reasoning: string;
  /**
   * Whether the durable turn journaled more steps than the conversation page
   * carries back. Only replayed history can set this; a live turn is watched
   * event by event and misses nothing.
   */
  readonly truncated?: boolean;
  /**
   * Paths the turn created or rewrote, in first-write order, from the host's
   * file-change events. Only a live turn reports them; replayed history keeps
   * tool and reasoning steps, so a reopened thread offers nothing here.
   */
  readonly writtenPaths?: ReadonlyArray<string>;
  /** The endpoint retry in progress, cleared by the next content or tool call, or the turn settling. */
  readonly retrying?: HarnessRetryNotice;
}

export const EMPTY_TURN_ACTIVITY: TurnActivity = { rows: [], reasoning: "" };

/**
 * The tool rows of a Chat or Work turn, from the steps the host recorded for
 * it. Absent when the turn called no tool, so the group draws nothing.
 */
export function toolStepsActivity(
  steps: ReadonlyArray<ThreadToolStep> | undefined,
  truncated: boolean | undefined,
): TurnActivity | undefined {
  if (steps === undefined || steps.length === 0) return undefined;
  return {
    rows: steps.map((step) => ({
      kind: "tool" as const,
      id: step.toolCallId,
      toolName: step.toolName,
      state: step.state,
      ...(step.summary === undefined ? {} : { summary: step.summary }),
      ...(step.publishedPage === undefined ? {} : { publishedPage: step.publishedPage }),
    })),
    reasoning: "",
    ...(truncated === true ? { truncated: true } : {}),
  };
}

/** How many rows are still open. */
export function activeRowCount(activity: TurnActivity): number {
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
export function alwaysVisibleActivityRows(activity: TurnActivity): ReadonlyArray<TurnActivityRow> {
  return activity.rows.filter((row) =>
    row.kind === "tool"
      ? row.state === "started" || row.state === "running"
      : row.state === "pending" || row.state === "running" || row.state === "waiting",
  );
}

/** Tool names that usually mutate files — used only for the quiet summary line. */
function isFileEditToolName(toolName: string): boolean {
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
export function settledTurnActivitySummary(activity: TurnActivity): string {
  const toolCalls = activity.rows.filter((row) => row.kind === "tool").length;
  // A denied or failed write changed nothing, so only a completed call is an edit.
  const filesEdited = activity.rows.filter(
    (row) => row.kind === "tool" && row.state === "completed" && isFileEditToolName(row.toolName),
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
