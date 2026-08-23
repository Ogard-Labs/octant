export type AgentHierarchyFilter = "active" | "history" | "all";

export interface AgentHierarchyInputRoute {
  readonly requestedProviderInstanceId: string;
  readonly requestedModelId: string;
  readonly executionProviderInstanceId: string;
  readonly executionModelId: string;
  readonly poolDerived: boolean;
  readonly selectionKind?: "requested" | "fallback";
  readonly routingReason?: string;
}

export interface AgentHierarchyInputEntry {
  readonly runId: string;
  readonly parentRunId?: string;
  readonly role: string;
  readonly task: string;
  readonly lifecycleStatus: string;
  readonly executionKind: string;
  readonly usageQuality: string;
  readonly resultAcknowledgement: {
    readonly required: boolean;
    readonly acknowledged: boolean;
    readonly followUpReason?: string;
  };
  readonly route?: AgentHierarchyInputRoute;
  readonly recoveryReason?: string;
  readonly result?: {
    readonly reference: string;
    readonly text?: string;
    readonly truncated: boolean;
  };
  readonly version: number;
  readonly updatedAt: string;
}

export interface AgentHierarchyRow {
  readonly runId: string;
  readonly parentRunId?: string;
  readonly depth: number;
  readonly role: string;
  readonly task: string;
  readonly lifecycleStatus: string;
  readonly executionKind: string;
  readonly usageQuality: string;
  readonly bucket: "active" | "history";
  readonly needsAcknowledgement: boolean;
  readonly followUpReason?: string;
  readonly recoveryReason?: string;
  readonly routeLabel?: string;
  readonly routeReason?: string;
  readonly nativeReadOnly: boolean;
  readonly result?: AgentHierarchyInputEntry["result"];
  readonly version: number;
  readonly updatedAt: string;
}

export interface AgentHierarchyModel {
  readonly filter: AgentHierarchyFilter;
  readonly query: string;
  readonly creationPosture: "off" | "ask" | "automatic";
  readonly activeCount: number;
  readonly historyCount: number;
  readonly rows: ReadonlyArray<AgentHierarchyRow>;
  readonly emptyReason?: string;
}

const ACTIVE = new Set(["queued", "starting", "running", "waiting"]);

/**
 * Pure browser hierarchy projection. Never decides routing/authority/completion;
 * only filters and presents server-authored AgentRun summaries.
 */
export function buildAgentHierarchyModel(input: {
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry>;
  readonly filter?: AgentHierarchyFilter;
  readonly query?: string;
  readonly creationPosture?: "off" | "ask" | "automatic";
}): AgentHierarchyModel {
  const filter = input.filter ?? "active";
  const query = (input.query ?? "").trim().toLowerCase();
  const creationPosture = input.creationPosture ?? "ask";
  const rows = input.entries
    .map((entry) => toRow(entry, depthOf(entry, input.entries)))
    .sort((a, b) => {
      if (a.updatedAt === b.updatedAt) return a.runId.localeCompare(b.runId);
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
  const activeCount = rows.filter((row) => row.bucket === "active").length;
  const historyCount = rows.filter((row) => row.bucket === "history").length;
  let visible = rows.filter((row) =>
    filter === "all"
      ? true
      : filter === "active"
        ? row.bucket === "active"
        : row.bucket === "history",
  );
  if (query.length > 0) {
    visible = visible.filter(
      (row) =>
        row.task.toLowerCase().includes(query) ||
        row.role.toLowerCase().includes(query) ||
        row.lifecycleStatus.toLowerCase().includes(query) ||
        row.runId.toLowerCase().includes(query),
    );
  }
  return {
    filter,
    query: input.query ?? "",
    creationPosture,
    activeCount,
    historyCount,
    rows: visible,
    ...(visible.length === 0
      ? {
          emptyReason:
            creationPosture === "off"
              ? "Subagent creation posture is Off."
              : filter === "history"
                ? "No completed or terminal child runs yet."
                : "No active child runs.",
        }
      : {}),
  };
}

function toRow(entry: AgentHierarchyInputEntry, depth: number): AgentHierarchyRow {
  const bucket = ACTIVE.has(entry.lifecycleStatus) ? "active" : "history";
  return {
    runId: entry.runId,
    ...(entry.parentRunId === undefined ? {} : { parentRunId: entry.parentRunId }),
    depth,
    role: entry.role,
    task: entry.task,
    lifecycleStatus: entry.lifecycleStatus,
    executionKind: entry.executionKind,
    usageQuality: entry.usageQuality,
    bucket,
    needsAcknowledgement:
      entry.resultAcknowledgement.required && !entry.resultAcknowledgement.acknowledged,
    ...(entry.resultAcknowledgement.followUpReason === undefined
      ? {}
      : { followUpReason: entry.resultAcknowledgement.followUpReason }),
    ...(entry.recoveryReason === undefined ? {} : { recoveryReason: entry.recoveryReason }),
    ...(entry.result === undefined ? {} : { result: entry.result }),
    ...(entry.route === undefined ? {} : { routeLabel: routeLabel(entry.route) }),
    ...(entry.route?.routingReason === undefined ? {} : { routeReason: entry.route.routingReason }),
    nativeReadOnly: entry.executionKind === "provider-native",
    version: entry.version,
    updatedAt: entry.updatedAt,
  };
}

/**
 * Renders the server-authored route receipt verbatim: the requested model, the
 * effective execution model when an explicit fallback ran, and whether the
 * route was pool-derived. Never invents a route the server did not record.
 */
function routeLabel(route: AgentHierarchyInputRoute): string {
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

function depthOf(
  entry: AgentHierarchyInputEntry,
  all: ReadonlyArray<AgentHierarchyInputEntry>,
): number {
  let depth = 0;
  let current = entry.parentRunId;
  const seen = new Set<string>();
  while (current !== undefined) {
    if (seen.has(current) || depth >= 2) break;
    seen.add(current);
    depth += 1;
    current = all.find((candidate) => candidate.runId === current)?.parentRunId;
  }
  return depth;
}
