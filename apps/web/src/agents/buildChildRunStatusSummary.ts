import type { DeliveryChildAgentEvidence } from "@octant/domain";
import type { AgentHierarchyInputEntry } from "./buildAgentHierarchyModel";

/**
 * The single word the chrome shows beside its icon. Words are load-bearing:
 * the chrome must never rely on colour alone to say what the children are
 * doing.
 */
export type ChildRunStatusState = "none" | "working" | "waiting" | "blocked";

export interface ChildRunStatusSummary {
  /** Non-terminal children plus terminal results awaiting acknowledgement. */
  readonly outstanding: number;
  readonly working: number;
  readonly waiting: number;
  readonly blocked: number;
  readonly state: ChildRunStatusState;
  /** Icon-independent wording, e.g. "3 child runs · Working". */
  readonly label: string;
  /** One sentence explaining the count, for the chrome's accessible name. */
  readonly detail: string;
  readonly currentTask?: string;
  readonly currentRole?: string;
  /** Run ids the parent thread may cancel right now. */
  readonly stoppableRunIds: ReadonlyArray<string>;
  /**
   * True when stopping would cancel more than one child. The chrome must ask
   * before a stop that reaches beyond a single run.
   */
  readonly confirmationRequired: boolean;
  /**
   * The same non-terminal / unacknowledged counts the delivery-target policy
   * consumes, so the chrome and delivery satisfaction never disagree.
   */
  readonly deliveryEvidence: DeliveryChildAgentEvidence;
}

const NON_TERMINAL = new Set(["queued", "starting", "running", "waiting"]);
const WORKING = new Set(["queued", "starting", "running"]);
const WAITING = new Set(["waiting"]);
const BLOCKED = new Set(["failed", "cancelled", "interrupted"]);

/**
 * Compact child-run summary for one parent thread.
 *
 * This is observability, not orchestration: it reads server-authored AgentRun
 * summaries and reports how many children this thread has and what they are
 * doing. It walks no subtree of its own — nesting is whatever the server
 * already reported — and it invents no second count, reusing the
 * delivery-target policy's definition of outstanding child work (non-terminal
 * runs plus terminal results the user has not acknowledged).
 */
export function buildChildRunStatusSummary(
  entries: ReadonlyArray<AgentHierarchyInputEntry>,
): ChildRunStatusSummary {
  let working = 0;
  let waiting = 0;
  let blocked = 0;
  let active = 0;
  let unacknowledgedResults = 0;
  const stoppableRunIds: string[] = [];

  for (const entry of entries) {
    const status = entry.lifecycleStatus;
    const nonTerminal = NON_TERMINAL.has(status);
    if (nonTerminal) {
      active += 1;
      stoppableRunIds.push(entry.runId);
    } else if (entry.resultAcknowledgement.required && !entry.resultAcknowledgement.acknowledged) {
      unacknowledgedResults += 1;
    }
    if (WORKING.has(status)) working += 1;
    else if (WAITING.has(status)) waiting += 1;
    else if (
      BLOCKED.has(status) &&
      entry.resultAcknowledgement.required &&
      !entry.resultAcknowledgement.acknowledged
    ) {
      blocked += 1;
    }
  }

  const outstanding = active + unacknowledgedResults;
  // Blocked outranks waiting outranks working: the chrome names the state that
  // most needs the user, not the most common one.
  const state: ChildRunStatusState =
    blocked > 0 ? "blocked" : waiting > 0 ? "waiting" : working > 0 ? "working" : "none";
  const current = currentEntry(entries, state);
  return {
    outstanding,
    working,
    waiting,
    blocked,
    state,
    label: `${countLabel(outstanding)} · ${stateLabel(state)}`,
    detail: detailLabel({ outstanding, working, waiting, blocked }),
    ...(current === undefined ? {} : { currentTask: current.task, currentRole: current.role }),
    stoppableRunIds,
    confirmationRequired: stoppableRunIds.length > 1,
    deliveryEvidence: { active, unacknowledgedResults },
  };
}

function currentEntry(
  entries: ReadonlyArray<AgentHierarchyInputEntry>,
  state: ChildRunStatusState,
): AgentHierarchyInputEntry | undefined {
  if (state === "blocked") {
    return entries.find(
      (entry) =>
        BLOCKED.has(entry.lifecycleStatus) &&
        entry.resultAcknowledgement.required &&
        !entry.resultAcknowledgement.acknowledged,
    );
  }
  if (state === "waiting") return entries.find((entry) => WAITING.has(entry.lifecycleStatus));
  return entries.find((entry) => WORKING.has(entry.lifecycleStatus));
}

function countLabel(outstanding: number): string {
  if (outstanding === 0) return "No child runs";
  return outstanding === 1 ? "1 child run" : `${outstanding} child runs`;
}

function stateLabel(state: ChildRunStatusState): string {
  if (state === "working") return "Working";
  if (state === "waiting") return "Waiting";
  if (state === "blocked") return "Blocked";
  return "Idle";
}

function detailLabel(counts: {
  readonly outstanding: number;
  readonly working: number;
  readonly waiting: number;
  readonly blocked: number;
}): string {
  if (counts.outstanding === 0) return "This thread has no outstanding child runs.";
  const parts: string[] = [];
  if (counts.working > 0) parts.push(`${counts.working} working`);
  if (counts.waiting > 0) parts.push(`${counts.waiting} waiting`);
  if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
  if (parts.length === 0) {
    return `${counts.outstanding} finished child ${counts.outstanding === 1 ? "run needs" : "runs need"} acknowledgement.`;
  }
  return `${parts.join(", ")} on this thread.`;
}
