import type { WorkTurnState } from "@octant/contracts";
import type { MobileCodeConversationTurn } from "@octant/client-runtime";
import type { ToolCall, ToolCallStatus } from "../../ui/ToolActivity";

export interface PlanTask {
  readonly id: string;
  readonly state: "pending" | "running" | "waiting" | "completed" | "failed";
  readonly text: string;
}

export interface ChangedFile {
  readonly path: string;
  readonly insertions?: number;
  readonly deletions?: number;
}

/** What a turn did besides writing its reply, as its computer reports it. */
export interface TurnActivity {
  readonly calls: ReadonlyArray<ToolCall>;
  /** The computer kept the first calls and stopped. */
  readonly callsTruncated: boolean;
  readonly reasoningMs?: number;
  readonly plan: ReadonlyArray<PlanTask>;
  /** Changed while the turn ran, which is not to say the agent wrote them. */
  readonly files?: {
    readonly files: ReadonlyArray<ChangedFile>;
    readonly total: number;
    readonly truncated: boolean;
  };
}

type StepState = "started" | "running" | "completed" | "failed";

/** A call its turn left unfinished did not finish; it is not still running. */
function callStatus(state: StepState, live: boolean): ToolCallStatus {
  if (state === "completed") return "done";
  if (state === "failed") return "failed";
  return live ? "running" : "failed";
}

export function isLiveWorkTurn(turn: WorkTurnState): boolean {
  return turn.status === "accepted" || turn.status === "running" || turn.status === "waiting";
}

export function workTurnActivity(turn: WorkTurnState): TurnActivity {
  const live = isLiveWorkTurn(turn);
  return {
    calls: (turn.toolSteps ?? []).map((step) => ({
      name: step.toolName,
      status: callStatus(step.state, live),
      summary: step.summary ?? "",
    })),
    callsTruncated: turn.toolStepsTruncated === true,
    ...(turn.reasoningMs === undefined ? {} : { reasoningMs: turn.reasoningMs }),
    plan: (turn.tasks ?? []).map((task) => ({
      id: task.taskId,
      state: task.state,
      text: task.state === "running" ? (task.runningSummary ?? task.summary) : task.summary,
    })),
    ...(turn.wroteFiles === undefined || turn.wroteFiles.paths.length === 0
      ? {}
      : {
          files: {
            files: turn.wroteFiles.paths.map((path) => ({ path })),
            total: turn.wroteFiles.paths.length,
            truncated: turn.wroteFiles.truncated,
          },
        }),
  };
}

export function codeTurnActivity(turn: MobileCodeConversationTurn): TurnActivity {
  const live = turn.status === "waiting";
  const changed = turn.changedFiles;
  return {
    calls: turn.steps.map((step) =>
      step.kind === "tool"
        ? {
            name: step.toolName,
            status: callStatus(step.state, live),
            summary: step.summary ?? "",
          }
        : { name: step.summary, status: "done", summary: "" },
    ),
    callsTruncated: turn.stepsTruncated,
    ...(turn.reasoningMs === undefined ? {} : { reasoningMs: turn.reasoningMs }),
    plan: [],
    ...(changed === undefined || changed.total === 0
      ? {}
      : {
          files: {
            files: changed.files.map(({ path, insertions, deletions, binary }) => ({
              path,
              ...(binary === true ? {} : { insertions, deletions }),
            })),
            total: changed.total,
            truncated: changed.truncated,
          },
        }),
  };
}

export interface TurnSubagent {
  readonly id: string;
  readonly task: string;
  readonly summary: string;
  readonly status: string;
  readonly working: boolean;
  readonly updatedAt: string;
}

/** The provider's own subagents, as the running turn observed them. */
export function turnSubagents(turn: WorkTurnState): ReadonlyArray<TurnSubagent> {
  return (turn.childObservations?.children ?? []).map((child) => ({
    id: String(child.childAgentId),
    task: child.task ?? "",
    summary: child.finalSummary ?? child.latestSummary,
    status: child.lifecycleStatus,
    working: ["starting", "running", "waiting"].includes(child.lifecycleStatus),
    updatedAt: child.updatedAt,
  }));
}
