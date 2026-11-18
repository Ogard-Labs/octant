import type { ReviewDecision, ToolOutsideContentMark } from "@octant/contracts/shield";
import type {
  HarnessRetryNotice,
  ThreadPublishedPage,
  ThreadRoutineReceipt,
  ThreadToolStep,
} from "@octant/contracts";
import { toolDisplayName } from "./toolKinds";

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
      /** A page the call published outside this host, such as a Claude artifact. */
      readonly published?: ThreadPublishedPage;
      /** The call's result brought outside content into the thread. */
      readonly outsideContent?: ToolOutsideContentMark;
      /** The routine the call created, shown as a receipt card under the turn. */
      readonly routine?: ThreadRoutineReceipt;
      /** How long the call ran, when the host recorded its start and end. */
      readonly durationMs?: number;
    }
  | {
      readonly kind: "task";
      readonly id: string;
      readonly state: "pending" | "running" | "waiting" | "completed" | "failed";
      readonly summary: string;
    }
  | {
      /** An approval a reviewer answered, in the reviewer's own name: Octant Shield or the provider. */
      readonly kind: "review";
      readonly id: string;
      /** The call it answered, as the approval named it. */
      readonly summary: string;
      readonly decision: ReviewDecision;
    };

export interface TurnActivity {
  readonly rows: ReadonlyArray<TurnActivityRow>;
  /** Accumulated reasoning-channel text, in arrival order. */
  readonly reasoning: string;
  /** How long the reasoning channel ran, when the host recorded start and end times. */
  readonly reasoningMs?: number;
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
  /**
   * How many times the runtime started a turn by itself inside this one, to
   * act on background work the turn started. Absent when it never did.
   */
  readonly runtimeTurns?: number;
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
    rows: steps.map((step) =>
      step.shield !== undefined
        ? {
            kind: "review" as const,
            id: step.toolCallId,
            summary: step.summary ?? step.toolName,
            decision: step.shield,
          }
        : {
            kind: "tool" as const,
            id: step.toolCallId,
            toolName: step.toolName,
            state: step.state,
            ...(step.summary === undefined ? {} : { summary: step.summary }),
            ...(step.published === undefined ? {} : { published: step.published }),
            ...(step.outsideContent === undefined ? {} : { outsideContent: step.outsideContent }),
            ...(step.routine === undefined ? {} : { routine: step.routine }),
          },
    ),
    reasoning: "",
    ...(truncated === true ? { truncated: true } : {}),
  };
}

/** How many rows are still open. */
export function activeRowCount(activity: TurnActivity): number {
  return activity.rows.filter((row) =>
    row.kind === "review"
      ? false
      : row.kind === "tool"
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
    row.kind === "review"
      ? false
      : row.kind === "tool"
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
export function settledTurnActivitySummary(activity: TurnActivity, workedFor?: string): string {
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
  const runtimeTurns = activity.runtimeTurns ?? 0;
  if (runtimeTurns > 0) {
    parts.push(
      runtimeTurns === 1
        ? "Continued after background work"
        : `Continued ${runtimeTurns} times after background work`,
    );
  }
  // The duration leads the line, but never makes a fold of its own: a turn with
  // nothing to fold keeps it in the turn header.
  if (parts.length > 0 && workedFor !== undefined) parts.unshift(workedFor);
  return parts.join(" · ");
}

/**
 * Whether a settled turn's machinery folds behind its summary line. The turn
 * header and the fold both read it, so the duration is drawn in one of them.
 */
export function settledTurnFoldsActivity(activity: TurnActivity): boolean {
  if (settledTurnActivitySummary(activity).length === 0) return false;
  const pinned = new Set(alwaysVisibleActivityRows(activity));
  return activity.rows.some((row) => !pinned.has(row));
}

/**
 * The title of the newest tool still running, for the live turn line. Absent
 * when no tool is running.
 */
export function runningStepTitle(activity: TurnActivity | undefined): string | undefined {
  if (activity === undefined) return undefined;
  for (let index = activity.rows.length - 1; index >= 0; index -= 1) {
    const row = activity.rows[index];
    if (row?.kind === "tool" && (row.state === "started" || row.state === "running")) {
      const title = toolDisplayName(row.toolName).trim();
      return title.length === 0 ? undefined : title;
    }
  }
  return undefined;
}

export type ExploreKind = "read" | "search" | "list";

const EXPLORE_KINDS: Readonly<Record<string, ExploreKind>> = {
  read: "read",
  read_file: "read",
  readfile: "read",
  notebookread: "read",
  grep: "search",
  glob: "search",
  rg: "search",
  ripgrep: "search",
  file_search: "search",
  codebase_search: "search",
  search_files: "search",
  ls: "list",
  list_dir: "list",
  listdir: "list",
  list_files: "list",
  list_directory: "list",
};

/**
 * Whether a tool only looks (reads a file, searches files, lists a folder),
 * from the tool's name: the transcript holds no kind beside it. Only the
 * providers' known built-in names count; a generic name such as `search`, `list`
 * or `fetch` may be a tool with side effects, and a web read brings outside
 * content in, so those stay plain rows.
 */
export function exploreKind(toolName: string): ExploreKind | undefined {
  return EXPLORE_KINDS[
    toolName
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_")
  ];
}

export type ToolActivityRow = Extract<TurnActivityRow, { readonly kind: "tool" }>;

/** A tool row that may fold into a run of looks: one that carries no card, route or outside-content tag. */
function isExploreRow(row: TurnActivityRow): row is ToolActivityRow {
  return (
    row.kind === "tool" &&
    exploreKind(row.toolName) !== undefined &&
    row.published === undefined &&
    row.routine === undefined &&
    row.outsideContent === undefined
  );
}

export type ActivityItem =
  | { readonly kind: "row"; readonly row: TurnActivityRow }
  | {
      readonly kind: "group";
      readonly id: string;
      readonly label: string;
      readonly rows: ReadonlyArray<ToolActivityRow>;
    };

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function exploreGroupLabel(rows: ReadonlyArray<ToolActivityRow>): string {
  const counts = { read: 0, search: 0, list: 0 };
  for (const row of rows) {
    const kind = exploreKind(row.toolName);
    if (kind !== undefined) counts[kind] += 1;
  }
  const segments: string[] = [];
  if (counts.read > 0) segments.push(`read ${plural(counts.read, "file", "files")}`);
  if (counts.search > 0) segments.push(`searched ${plural(counts.search, "time", "times")}`);
  if (counts.list > 0) segments.push(`listed ${plural(counts.list, "folder", "folders")}`);
  const line = segments.join(", ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}

/**
 * Runs of two or more consecutive read, search, and list calls become one
 * group; anything else, including a lone look, stays its own row, and any
 * other row ends the run.
 */
export function groupActivityRows(
  rows: ReadonlyArray<TurnActivityRow>,
): ReadonlyArray<ActivityItem> {
  const items: ActivityItem[] = [];
  let run: ToolActivityRow[] = [];
  const flush = () => {
    const first = run[0];
    if (first !== undefined && run.length >= 2) {
      items.push({
        kind: "group",
        id: `group:${first.id}`,
        label: exploreGroupLabel(run),
        rows: run,
      });
    } else {
      for (const row of run) items.push({ kind: "row", row });
    }
    run = [];
  };
  for (const row of rows) {
    if (isExploreRow(row)) {
      run.push(row);
    } else {
      flush();
      items.push({ kind: "row", row });
    }
  }
  flush();
  return items;
}
