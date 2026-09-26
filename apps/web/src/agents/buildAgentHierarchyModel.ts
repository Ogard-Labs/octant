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
  /** The model the host ran, for a row's one-line facts. */
  readonly model?: string;
  readonly routeLabel?: string;
  readonly routeReason?: string;
  readonly nativeReadOnly: boolean;
  readonly result?: AgentHierarchyInputEntry["result"];
  readonly version: number;
  readonly updatedAt: string;
}

export interface AgentHierarchyModel {
  readonly creationPosture: "off" | "ask" | "automatic";
  /** Queued, starting, running, and waiting subagents, in the host's order. */
  readonly working: ReadonlyArray<AgentHierarchyRow>;
  /** Every settled subagent, newest first. */
  readonly finished: ReadonlyArray<AgentHierarchyRow>;
  readonly emptyReason?: string;
}

const ACTIVE = new Set(["queued", "starting", "running", "waiting"]);

export function isActiveAgentHierarchyStatus(lifecycleStatus: string): boolean {
  return ACTIVE.has(lifecycleStatus);
}

/**
 * Pure browser hierarchy projection. Never decides routing/authority/completion;
 * only groups and presents server-authored AgentRun summaries.
 *
 * A thread's subagents are a short list, so there is no filter or search:
 * what is still working leads, and what has settled follows newest first.
 * Working rows keep the host's order so a row does not jump each time its
 * status (and with it `updatedAt`) changes.
 */
export function buildAgentHierarchyModel(input: {
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry>;
  readonly creationPosture?: "off" | "ask" | "automatic";
}): AgentHierarchyModel {
  const creationPosture = input.creationPosture ?? "ask";
  const rows = input.entries.map((entry) => toRow(entry, depthOf(entry, input.entries)));
  const working = rows.filter((row) => row.bucket === "active");
  const finished = rows
    .filter((row) => row.bucket === "history")
    .sort((a, b) => {
      if (a.updatedAt === b.updatedAt) return a.runId.localeCompare(b.runId);
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
  return {
    creationPosture,
    working,
    finished,
    ...(rows.length === 0
      ? {
          emptyReason:
            creationPosture === "off"
              ? "Subagents are turned off in Settings."
              : "No subagents on this thread yet.",
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
    ...(entry.route === undefined
      ? {}
      : { model: entry.route.executionModelId, routeLabel: routeLabel(entry.route) }),
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
