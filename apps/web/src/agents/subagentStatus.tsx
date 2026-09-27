import { AlertTriangle, CircleCheck, Loader, PauseCircle } from "lucide-react";
import {
  isActiveAgentHierarchyStatus,
  type AgentHierarchyInputEntry,
} from "./buildAgentHierarchyModel";

/**
 * The four shapes a subagent's state takes on screen. Every one of them is
 * drawn as an icon *and* named in words beside it: the default theme is
 * monochrome, so neither the icon's shape nor any colour may carry the state
 * alone.
 */
export type SubagentPhase = "working" | "waiting" | "done" | "stopped";

export function subagentPhase(lifecycleStatus: string): SubagentPhase {
  if (lifecycleStatus === "waiting") return "waiting";
  if (isActiveAgentHierarchyStatus(lifecycleStatus)) return "working";
  if (lifecycleStatus === "completed") return "done";
  return "stopped";
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  queued: "Queued",
  starting: "Starting",
  running: "Working",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

/** The host's lifecycle status in the words the interface uses for it. */
export function subagentStatusWord(lifecycleStatus: string): string {
  return STATUS_WORDS[lifecycleStatus] ?? lifecycleStatus;
}

const ROLE_WORDS: Readonly<Record<string, string>> = {
  research: "Research",
  implementation: "Implement",
  review: "Review",
  custom: "Custom",
};

export function subagentRoleWord(role: string): string {
  return ROLE_WORDS[role] ?? role;
}

/** A finished result the person has not yet looked at and marked reviewed. */
export function subagentNeedsReview(entry: AgentHierarchyInputEntry): boolean {
  return entry.resultAcknowledgement.required && !entry.resultAcknowledgement.acknowledged;
}

/** The model the host actually ran, when it reported a route. */
export function subagentModel(entry: AgentHierarchyInputEntry): string | undefined {
  return entry.route?.executionModelId;
}

/**
 * How long a subagent has been in its current state, compactly: "12s",
 * "4m", "2h". The summary carries no start time, only `updatedAt`, which the
 * host moves on each status change — so this is time in the present state,
 * not total run time.
 */
export function subagentElapsedLabel(since: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1_000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

export function SubagentStatusIcon(props: { readonly lifecycleStatus: string }) {
  const phase = subagentPhase(props.lifecycleStatus);
  const Icon =
    phase === "working"
      ? Loader
      : phase === "waiting"
        ? PauseCircle
        : phase === "done"
          ? CircleCheck
          : AlertTriangle;
  return (
    <Icon
      aria-hidden="true"
      className={
        phase === "working"
          ? "subagent-status-icon subagent-status-icon--working"
          : "subagent-status-icon"
      }
      size={14}
      strokeWidth={1.8}
    />
  );
}
