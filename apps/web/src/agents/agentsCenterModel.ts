import type {
  AgentRunCenterSummary,
  AgentRunCenterStatusFilter,
  AgentRunLifecycleStatus,
  AgentRunUsageQuality,
  OctantMode,
} from "@octant/contracts";
import type { AgentRunCenterQueryInput } from "@octant/client-runtime/agent-run-client";
import { isAgentRunActiveStatus } from "@octant/domain";

export type AgentsCenterStatusFilter = AgentRunCenterStatusFilter;
export type AgentsCenterModeFilter = AgentRunCenterQueryInput["mode"];

export interface AgentsCenterThreadTarget {
  readonly mode: OctantMode;
  readonly threadId: string;
  /** When present, open the Code child worktree thread instead of the parent. */
  readonly childThreadId?: string;
}

const lifecycleLabels: Record<AgentRunLifecycleStatus, string> = {
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function agentRunLifecycleLabel(status: AgentRunLifecycleStatus): string {
  return lifecycleLabels[status];
}

const usageQualityLabels: Record<AgentRunUsageQuality, string> = {
  "provider-reported": "Provider reported",
  estimated: "Estimated",
  unavailable: "Unavailable",
  stale: "Stale",
};

export function agentRunUsageQualityLabel(quality: AgentRunUsageQuality): string {
  return usageQualityLabels[quality];
}

export function agentRunModeLabel(mode: OctantMode): string {
  if (mode === "chat") return "Chat";
  if (mode === "work") return "Work";
  return "Code";
}

export function agentRunAuthoritySummary(authority: AgentRunCenterSummary["authority"]): string {
  const capabilities = (
    ["filesystem", "shell", "git", "network", "tools", "subagents"] as const
  ).filter((key) => authority[key]);
  const capabilityText = capabilities.length === 0 ? "no capabilities" : capabilities.join(", ");
  const executionPolicyLabels = {
    plan: "Plan (read-only)",
    "approval-gated": "Approval-gated",
    "auto-accept-edits": "Auto-accept edits",
    "full-access": "Full access",
  } as const;
  const persistence =
    authority.permissionPersistence === "current-session" ? "this session only" : "Project default";
  return `${executionPolicyLabels[authority.executionPolicy]} · ${capabilityText} · ${persistence}`;
}

export function agentRunWorkspaceLabel(kind: AgentRunCenterSummary["workspaceKind"]): string {
  if (kind === "chat-virtual") return "Chat virtual workspace";
  if (kind === "work-root") return "Work project root";
  return "Code child worktree";
}

export function agentRunRouteLabel(summary: AgentRunCenterSummary): string {
  const route = summary.route;
  const models =
    route.executionModelId === route.requestedModelId &&
    route.executionProviderInstanceId === route.requestedProviderInstanceId
      ? route.requestedModelId
      : `${route.requestedModelId} → ${route.executionModelId}`;
  if (!route.poolDerived) return models;
  if (route.selectionKind === "fallback") return `${models} · pool fallback`;
  if (route.selectionKind === "requested") return `${models} · pool`;
  return `${models} · pool waiting`;
}

export function agentRunAcknowledgementLabel(
  acknowledgement: AgentRunCenterSummary["resultAcknowledgement"],
): string {
  if (!acknowledgement.required) return "Not required";
  return acknowledgement.acknowledged ? "Acknowledged" : "Needs acknowledgement";
}

export function agentRunRecoveryLabel(recoveryReason: string | undefined): string | undefined {
  if (recoveryReason === undefined) return undefined;
  if (recoveryReason === "host-restart") return "Recovered after host restart";
  if (recoveryReason === "journal-replay") return "Recovered after journal replay";
  if (recoveryReason === "provider-reconnect") return "Waiting after provider reconnect";
  return recoveryReason;
}

export function agentRunCenterThreadTarget(
  summary: AgentRunCenterSummary,
): AgentsCenterThreadTarget {
  if (summary.mode === "code" && summary.childThreadId !== undefined) {
    return {
      mode: "code",
      threadId: String(summary.parentThreadId),
      childThreadId: String(summary.childThreadId),
    };
  }
  return { mode: summary.mode, threadId: String(summary.parentThreadId) };
}

export function agentRunCommandFailureMessage(input: {
  readonly reason?: string;
  readonly message?: string;
}): string {
  if (input.message !== undefined && input.message.length > 0) return input.message;
  if (input.reason === "stale-version") {
    return "This run changed on the server. Refresh and retry against the latest version.";
  }
  if (input.reason === "unsupported-transition") {
    return "That control action is not supported for this run in its current state.";
  }
  if (input.reason === "unauthorized") return "You are not authorized to control this run.";
  return "The AgentRun command was refused.";
}

export function agentRunTransportFailureMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return fallback;
}

export interface AgentsCenterClientFilters {
  readonly status: AgentsCenterStatusFilter;
  readonly mode: NonNullable<AgentsCenterModeFilter>;
  readonly projectId?: string;
  readonly providerInstanceId?: string;
  readonly parentThreadId?: string;
  readonly search: string;
}

export function buildAgentsCenterServerQuery(
  filters: AgentsCenterClientFilters,
  limit: number,
  cursor?: string,
): AgentRunCenterQueryInput {
  const trimmedSearch = filters.search.trim();
  return {
    status: filters.status,
    mode: filters.mode,
    limit,
    ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
    ...(filters.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: filters.providerInstanceId }),
    ...(filters.parentThreadId === undefined
      ? {}
      : { parentThreadId: filters.parentThreadId as never }),
    ...(trimmedSearch.length === 0 ? {} : { search: trimmedSearch }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export function filterAgentsCenterRows(
  rows: ReadonlyArray<AgentRunCenterSummary>,
  filters: AgentsCenterClientFilters,
): ReadonlyArray<AgentRunCenterSummary> {
  const query = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.status === "active" && !isAgentRunActiveStatus(row.lifecycleStatus)) return false;
    if (filters.status === "history" && isAgentRunActiveStatus(row.lifecycleStatus)) return false;
    if (filters.mode !== "all" && row.mode !== filters.mode) return false;
    if (filters.projectId !== undefined && String(row.projectId ?? "") !== filters.projectId) {
      return false;
    }
    if (
      filters.providerInstanceId !== undefined &&
      row.route.requestedProviderInstanceId !== filters.providerInstanceId
    ) {
      return false;
    }
    if (
      filters.parentThreadId !== undefined &&
      String(row.parentThreadId) !== filters.parentThreadId
    ) {
      return false;
    }
    if (query.length === 0) return true;
    const haystack =
      `${row.task} ${row.role} ${row.parentThreadTitle} ${row.lifecycleStatus}`.toLowerCase();
    return haystack.includes(query);
  });
}
