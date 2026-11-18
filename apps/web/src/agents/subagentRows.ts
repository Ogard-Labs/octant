import type { AgentObservedChild } from "@octant/contracts";
import {
  isActiveAgentHierarchyStatus,
  subagentNeedsReview,
  type AgentHierarchyInputEntry,
} from "./buildAgentHierarchyModel";
import type { SubagentProviderIdentity } from "./AgentRunDependencyGraph";
import { observedChildSelectionId } from "./ObservedChildActivity";

interface SubagentRowFacts {
  /** The run id for an Octant-started subagent; the observation's selection id otherwise. */
  readonly id: string;
  readonly providerInstanceId?: string;
  /** The provider's display name, or its instance id when the surface does not know it. */
  readonly providerName: string;
  /** Present only when the surface knows the instance, so a glyph is drawn for it. */
  readonly driverKind?: string;
  /** The model the host or runtime reported, or "Model unknown". */
  readonly model: string;
  readonly lifecycleStatus: string;
  readonly task: string;
  /** The id of the listed row it is nested under; absent at top level. */
  readonly parentId?: string;
  /** How many listed ancestors it has. */
  readonly depth: number;
  /** Failed, waiting, interrupted, or a result the person has yet to review. */
  readonly needsAttention: boolean;
  readonly updatedAt: string;
}

/**
 * One subagent of a thread, whoever started it. Octant starts a subagent when
 * the thread's agent delegates through `octant_agents`; a provider runtime can
 * also start its own, which Octant only observes. Both are the thread's
 * subagents, so every surface lists them together; the kind decides only what
 * the row offers (an observed child has no managed controls).
 */
export type SubagentRow =
  | (SubagentRowFacts & {
      readonly kind: "octant-started";
      readonly entry: AgentHierarchyInputEntry;
      readonly compareGroup?: string;
    })
  | (SubagentRowFacts & {
      readonly kind: "provider-started";
      readonly child: AgentObservedChild;
    });

/** Attention order: the states that ask something of the person lead. */
export function subagentNeedsAttention(row: {
  readonly lifecycleStatus: string;
  readonly entry?: AgentHierarchyInputEntry;
}): boolean {
  return (
    row.lifecycleStatus === "failed" ||
    row.lifecycleStatus === "waiting" ||
    row.lifecycleStatus === "interrupted" ||
    (row.entry !== undefined && subagentNeedsReview(row.entry))
  );
}

/**
 * Both kinds of subagent as one list, in the host's order (Octant-started
 * first, then observed), each nested under the listed subagent that started
 * it. A provider-started child of a managed run names that run
 * (`parentRunId`); one started by another observed child names it
 * (`parentChildAgentId`, within the same provider session). A parent that is
 * not listed leaves the row at top level rather than inventing an ancestor.
 */
export function buildSubagentRows(input: {
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry>;
  readonly observations?: ReadonlyArray<AgentObservedChild>;
  readonly providers?: ReadonlyMap<string, SubagentProviderIdentity>;
}): ReadonlyArray<SubagentRow> {
  const observations = input.observations ?? [];
  const runIds = new Set(input.entries.map((entry) => entry.runId));
  const observedIds = new Map(
    observations.map((child) => [observedKey(child, child.childAgentId), child]),
  );
  const provider = (id: string | undefined) => {
    const known = id === undefined ? undefined : input.providers?.get(id);
    return {
      ...(id === undefined ? {} : { providerInstanceId: id }),
      providerName: known?.displayName ?? id ?? "Provider unknown",
      ...(known === undefined ? {} : { driverKind: known.driverKind }),
    };
  };
  const rows: SubagentRow[] = [
    ...input.entries.map((entry): SubagentRow => {
      const parentId =
        entry.parentRunId !== undefined && runIds.has(entry.parentRunId)
          ? entry.parentRunId
          : undefined;
      return {
        kind: "octant-started",
        id: entry.runId,
        entry,
        ...provider(entry.route?.executionProviderInstanceId),
        model: modelName(
          input.providers,
          entry.route?.executionProviderInstanceId,
          entry.route?.executionModelId,
        ),
        lifecycleStatus: entry.lifecycleStatus,
        task: entry.task,
        ...(parentId === undefined ? {} : { parentId }),
        depth: 0,
        needsAttention: subagentNeedsAttention({ lifecycleStatus: entry.lifecycleStatus, entry }),
        ...(entry.compareGroup === undefined ? {} : { compareGroup: entry.compareGroup }),
        updatedAt: entry.updatedAt,
      };
    }),
    ...observations.map((child): SubagentRow => {
      const observedParent =
        child.parentChildAgentId === undefined
          ? undefined
          : observedIds.get(observedKey(child, child.parentChildAgentId));
      const parentId =
        observedParent !== undefined && observedParent !== child
          ? observedChildSelectionId(observedParent)
          : child.parentRunId !== undefined && runIds.has(String(child.parentRunId))
            ? String(child.parentRunId)
            : undefined;
      return {
        kind: "provider-started",
        id: observedChildSelectionId(child),
        child,
        ...provider(String(child.providerInstanceId)),
        model: modelName(
          input.providers,
          String(child.providerInstanceId),
          child.modelId === undefined ? undefined : String(child.modelId),
        ),
        lifecycleStatus: child.lifecycleStatus,
        task: child.task ?? "Task unavailable",
        ...(parentId === undefined ? {} : { parentId }),
        depth: 0,
        needsAttention: subagentNeedsAttention({ lifecycleStatus: child.lifecycleStatus }),
        updatedAt: child.updatedAt,
      };
    }),
  ];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return rows.map((row) => ({ ...row, depth: depthOf(row, byId) }));
}

/**
 * Orders rows so each follows its parent when the parent is in the same list,
 * keeping the given order among siblings. A row whose parent sits elsewhere
 * (another section) keeps its place.
 */
export function nestSubagentRows<Row extends { readonly id: string; readonly parentId?: string }>(
  rows: ReadonlyArray<Row>,
): ReadonlyArray<Row> {
  const listed = new Set(rows.map((row) => row.id));
  const children = new Map<string, Row[]>();
  const roots: Row[] = [];
  for (const row of rows) {
    if (row.parentId !== undefined && listed.has(row.parentId)) {
      const siblings = children.get(row.parentId) ?? [];
      siblings.push(row);
      children.set(row.parentId, siblings);
    } else {
      roots.push(row);
    }
  }
  const ordered: Row[] = [];
  const seen = new Set<string>();
  const visit = (row: Row) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    ordered.push(row);
    for (const child of children.get(row.id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  // A parent cycle has no root; its rows still appear, in the given order.
  for (const row of rows) visit(row);
  return ordered;
}

export function isActiveSubagentRow(row: SubagentRow): boolean {
  return isActiveAgentHierarchyStatus(row.lifecycleStatus);
}

export type OctantStartedSubagentRow = Extract<SubagentRow, { kind: "octant-started" }>;

/** Members of one compare group: siblings the parent agent labelled alike. */
export interface SubagentCompareGroup {
  readonly label: string;
  readonly members: ReadonlyArray<OctantStartedSubagentRow>;
}

export type SubagentListItem =
  | { readonly kind: "row"; readonly row: SubagentRow }
  | ({ readonly kind: "group" } & SubagentCompareGroup);

/**
 * Splits rows into single rows and compare groups, in first-member order. A
 * label shared by only one run is no comparison, so that run stays a row.
 * The host ranks nothing, and neither does this: members keep the host's order.
 */
export function groupSubagentRows(
  rows: ReadonlyArray<SubagentRow>,
): ReadonlyArray<SubagentListItem> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === "octant-started" && row.compareGroup !== undefined) {
      counts.set(row.compareGroup, (counts.get(row.compareGroup) ?? 0) + 1);
    }
  }
  const out: SubagentListItem[] = [];
  const groups = new Map<string, OctantStartedSubagentRow[]>();
  for (const row of rows) {
    if (
      row.kind === "octant-started" &&
      row.compareGroup !== undefined &&
      (counts.get(row.compareGroup) ?? 0) > 1
    ) {
      const existing = groups.get(row.compareGroup);
      if (existing !== undefined) {
        existing.push(row);
        continue;
      }
      const members: OctantStartedSubagentRow[] = [row];
      groups.set(row.compareGroup, members);
      out.push({ kind: "group", label: row.compareGroup, members });
      continue;
    }
    out.push({ kind: "row", row });
  }
  return out;
}

/**
 * The model's display name where the provider's catalogue describes it, its
 * reported id where it does not, and "Model unknown" when the run reported
 * none: never the parent thread's model.
 */
function modelName(
  providers: ReadonlyMap<string, SubagentProviderIdentity> | undefined,
  providerInstanceId: string | undefined,
  modelId: string | undefined,
): string {
  if (modelId === undefined) return "Model unknown";
  const named =
    providerInstanceId === undefined
      ? undefined
      : providers?.get(providerInstanceId)?.models?.get(modelId);
  return named ?? modelId;
}

function observedKey(child: AgentObservedChild, childAgentId: string): string {
  return `${String(child.providerInstanceId)}\u0000${String(child.sessionId)}\u0000${childAgentId}`;
}

function depthOf(row: SubagentRow, byId: ReadonlyMap<string, SubagentRow>): number {
  let depth = 0;
  let current = row.parentId;
  const seen = new Set<string>([row.id]);
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    depth += 1;
    current = byId.get(current)?.parentId;
  }
  return depth;
}
