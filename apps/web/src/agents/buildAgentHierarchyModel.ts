import type { AgentRunResultPacket } from "@octant/contracts";
import { AGENT_RUN_DEPENDENCY_WAITING_REASON } from "@octant/domain";

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
  readonly resultPackets?: ReadonlyArray<AgentRunResultPacket>;
  readonly resultsTruncated?: boolean;
  readonly runId: string;
  readonly parentRunId?: string;
  /** The sibling runs this one waits for, as the host listed them. */
  readonly dependsOn?: ReadonlyArray<string>;
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
  /** The effort the run was asked to use, when the host recorded one. */
  readonly normalizedReasoning?: string;
  readonly recoveryReason?: string;
  /** How the host settled delivering this result to the parent; absent while owed. */
  readonly resultDeliveryOutcome?: "delivered" | "consumed" | "invalidated" | "failed";
  /** The normalized limit fact the host journaled when the run last waited. */
  readonly usageLimit?: {
    readonly kind: "temporary" | "exhausted" | "billing";
    readonly resetsAt?: string | undefined;
  };
  /** An armed or settled usage-resume opt-in, when one exists. */
  readonly usageResume?: {
    readonly status: "scheduled" | "dispatched" | "invalidated" | "failed";
    readonly record: { readonly resetsAt: string };
    readonly detail?: string | undefined;
  };
  readonly result?: {
    readonly reference: string;
    readonly text?: string;
    readonly truncated: boolean;
  };
  readonly version: number;
  /** When the run was requested. Absent from a host that predates the field. */
  readonly createdAt?: string;
  readonly updatedAt: string;
}

/** A run another run waits for, named by its task so a reader need not match ids. */
export interface AgentHierarchyRunReference {
  readonly runId: string;
  readonly task: string;
}

export interface AgentHierarchyRow {
  readonly resultPackets?: ReadonlyArray<AgentRunResultPacket>;
  readonly resultsTruncated?: boolean;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly depth: number;
  readonly role: string;
  readonly task: string;
  readonly lifecycleStatus: string;
  readonly executionKind: string;
  readonly usageQuality: string;
  readonly bucket: "active" | "history";
  /** Still asks the person to look: unreviewed and not yet handed to the parent. */
  readonly needsReview: boolean;
  /** The host still records the result as unreviewed, so Mark reviewed applies. */
  readonly needsAcknowledgement: boolean;
  readonly followUpReason?: string;
  readonly recoveryReason?: string;
  readonly usageLimit?: AgentHierarchyInputEntry["usageLimit"];
  readonly usageResume?: AgentHierarchyInputEntry["usageResume"];
  /** The model the host ran, for a row's one-line facts. */
  readonly model?: string;
  /** The provider instance that ran it, which a surface may draw as that provider's mark. */
  readonly providerInstanceId?: string;
  /** The effort the run was asked to use. */
  readonly effort?: string;
  /** The listed runs this one waits for, in the host's order. Empty when it waits for none. */
  readonly runsAfter: ReadonlyArray<AgentHierarchyRunReference>;
  /**
   * How many of those have not finished, while the host holds this run for
   * them. Absent once it started or when it waits for something else.
   */
  readonly waitingOn?: number;
  readonly routeLabel?: string;
  readonly routeReason?: string;
  readonly nativeReadOnly: boolean;
  readonly result?: AgentHierarchyInputEntry["result"];
  readonly version: number;
  readonly createdAt?: string;
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
 * A finished result only the person can still take in: they have not marked it
 * reviewed, and the host has not already put it in the parent's hands. A result
 * the parent received sits in the thread as a child-result card, so flagging it
 * as awaiting review asks for nothing anyone can act on.
 */
export function subagentNeedsReview(entry: AgentHierarchyInputEntry): boolean {
  return (
    entry.resultAcknowledgement.required &&
    !entry.resultAcknowledgement.acknowledged &&
    entry.resultDeliveryOutcome !== "delivered" &&
    entry.resultDeliveryOutcome !== "consumed"
  );
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
  const creationPosture = input.creationPosture ?? "automatic";
  const byId = new Map(input.entries.map((entry) => [entry.runId, entry]));
  const rows = input.entries.map((entry) => toRow(entry, depthOf(entry, input.entries), byId));
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
              : "No subagents yet. They appear here when the agent hands off part of its work.",
        }
      : {}),
  };
}

function toRow(
  entry: AgentHierarchyInputEntry,
  depth: number,
  byId: ReadonlyMap<string, AgentHierarchyInputEntry>,
): AgentHierarchyRow {
  const bucket = ACTIVE.has(entry.lifecycleStatus) ? "active" : "history";
  // Only a listed run is named: the host leaves out one this window may not
  // read, and a reader cannot open what is not in the list.
  const awaited = (entry.dependsOn ?? []).flatMap((runId) => {
    const run = runId === entry.runId ? undefined : byId.get(runId);
    return run === undefined ? [] : [run];
  });
  const heldForDependencies =
    entry.lifecycleStatus === "waiting" &&
    entry.recoveryReason === AGENT_RUN_DEPENDENCY_WAITING_REASON;
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
    needsReview: subagentNeedsReview(entry),
    needsAcknowledgement:
      entry.resultAcknowledgement.required && !entry.resultAcknowledgement.acknowledged,
    ...(entry.resultAcknowledgement.followUpReason === undefined
      ? {}
      : { followUpReason: entry.resultAcknowledgement.followUpReason }),
    ...(entry.recoveryReason === undefined ? {} : { recoveryReason: entry.recoveryReason }),
    ...(entry.usageLimit === undefined ? {} : { usageLimit: entry.usageLimit }),
    ...(entry.usageResume === undefined ? {} : { usageResume: entry.usageResume }),
    ...(entry.result === undefined ? {} : { result: entry.result }),
    ...(entry.resultPackets === undefined ? {} : { resultPackets: entry.resultPackets }),
    ...(entry.resultsTruncated === undefined ? {} : { resultsTruncated: entry.resultsTruncated }),
    ...(entry.route === undefined
      ? {}
      : {
          model: entry.route.executionModelId,
          providerInstanceId: entry.route.executionProviderInstanceId,
          routeLabel: routeLabel(entry.route),
        }),
    ...(entry.normalizedReasoning === undefined ? {} : { effort: entry.normalizedReasoning }),
    runsAfter: awaited.map((run) => ({ runId: run.runId, task: run.task })),
    ...(heldForDependencies
      ? { waitingOn: awaited.filter((run) => run.lifecycleStatus !== "completed").length }
      : {}),
    ...(entry.route?.routingReason === undefined ? {} : { routeReason: entry.route.routingReason }),
    nativeReadOnly: entry.executionKind === "provider-native",
    version: entry.version,
    ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
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
