import type { OctantMode, ProjectId } from "@octant/contracts";
import { AGENT_RUN_MAX_DEPTH } from "./agentRunPolicy";

/** Run levels under a parent thread. A grandchild is allowed; a great-grandchild is not. */
export const AGENT_RUN_GRAPH_MAX_DEPTH = AGENT_RUN_MAX_DEPTH;

/** The fields the forest needs to place a run. Callers may pass a richer summary. */
export interface AgentRunForestMember {
  readonly runId: string;
  readonly parentThreadId: string;
  readonly parentThreadTitle: string;
  readonly parentRunId?: string | undefined;
  readonly mode: OctantMode;
  readonly projectId?: ProjectId | undefined;
  readonly role: string;
  readonly task: string;
  readonly createdAt: string;
}

export interface AgentRunForestRun<T extends AgentRunForestMember = AgentRunForestMember> {
  readonly summary: T;
  readonly depth: number;
  readonly children: ReadonlyArray<AgentRunForestRun<T>>;
}

export interface AgentRunForestThread<T extends AgentRunForestMember = AgentRunForestMember> {
  readonly parentThreadId: string;
  readonly title: string;
  readonly mode: OctantMode;
  readonly projectId?: ProjectId | undefined;
  readonly roots: ReadonlyArray<AgentRunForestRun<T>>;
}

export interface AgentRunForest<T extends AgentRunForestMember = AgentRunForestMember> {
  readonly threads: ReadonlyArray<AgentRunForestThread<T>>;
}

/**
 * Project the currently visible Agents Center page as a forest.
 *
 * Launch origin is the parent thread, then parentRunId when that parent is on
 * the same page. Missing parents, cycles, and a third run level stay visible
 * as thread-level roots instead of disappearing or looping.
 */
export function buildAgentRunForest<T extends AgentRunForestMember>(
  items: ReadonlyArray<T>,
): AgentRunForest<T> {
  const groups = new Map<string, T[]>();
  const threadOrder: string[] = [];
  for (const item of items) {
    const threadId = String(item.parentThreadId);
    const existing = groups.get(threadId);
    if (existing === undefined) {
      threadOrder.push(threadId);
      groups.set(threadId, [item]);
    } else {
      existing.push(item);
    }
  }

  const threads: Array<AgentRunForestThread<T>> = [];
  for (const threadId of threadOrder) {
    const members = groups.get(threadId);
    const first = members?.[0];
    if (members === undefined || first === undefined) continue;
    threads.push({
      parentThreadId: threadId,
      title: first.parentThreadTitle,
      mode: first.mode,
      ...(first.projectId === undefined ? {} : { projectId: first.projectId }),
      roots: buildThreadRoots(members),
    });
  }
  return { threads };
}

function buildThreadRoots<T extends AgentRunForestMember>(
  members: ReadonlyArray<T>,
): ReadonlyArray<AgentRunForestRun<T>> {
  const byId = new Map(members.map((item) => [String(item.runId), item]));
  const parentOf = new Map<string, string>();
  for (const item of members) {
    const parentRunId = item.parentRunId === undefined ? undefined : String(item.parentRunId);
    if (parentRunId === undefined) continue;
    if (!byId.has(parentRunId)) continue;
    const childId = String(item.runId);
    if (parentRunId === childId) continue;
    parentOf.set(childId, parentRunId);
  }
  stripCyclicEdges(parentOf);
  stripEdgesBeyondDepth(parentOf);

  const childrenOf = new Map<string, T[]>();
  for (const item of members) {
    const parentId = parentOf.get(String(item.runId));
    if (parentId === undefined) continue;
    const siblings = childrenOf.get(parentId);
    if (siblings === undefined) childrenOf.set(parentId, [item]);
    else siblings.push(item);
  }

  const compare = (a: T, b: T): number => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return String(a.runId).localeCompare(String(b.runId));
  };

  const toNode = (item: T, depth: number): AgentRunForestRun<T> => {
    const childSummaries = [...(childrenOf.get(String(item.runId)) ?? [])].sort(compare);
    return {
      summary: item,
      depth,
      children: childSummaries.map((child) => toNode(child, depth + 1)),
    };
  };

  return members
    .filter((item) => !parentOf.has(String(item.runId)))
    .sort(compare)
    .map((item) => toNode(item, 0));
}

function stripCyclicEdges(parentOf: Map<string, string>): void {
  const cyclic = new Set<string>();
  for (const start of parentOf.keys()) {
    const visiting = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor !== undefined) {
      if (visiting.has(cursor)) {
        let mark: string | undefined = cursor;
        do {
          if (mark === undefined) break;
          cyclic.add(mark);
          mark = parentOf.get(mark);
        } while (mark !== undefined && mark !== cursor);
        break;
      }
      visiting.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }
  for (const runId of cyclic) parentOf.delete(runId);
}

function stripEdgesBeyondDepth(parentOf: Map<string, string>): void {
  const depthOf = (runId: string): number => {
    let depth = 0;
    let cursor: string | undefined = parentOf.get(runId);
    const seen = new Set<string>([runId]);
    while (cursor !== undefined) {
      if (seen.has(cursor)) return 0;
      seen.add(cursor);
      depth += 1;
      cursor = parentOf.get(cursor);
    }
    return depth;
  };
  const tooDeep: string[] = [];
  for (const childId of parentOf.keys()) {
    if (depthOf(childId) > AGENT_RUN_GRAPH_MAX_DEPTH) tooDeep.push(childId);
  }
  for (const childId of tooDeep) parentOf.delete(childId);
}
