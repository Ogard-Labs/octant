import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlockId,
  type CanvasBlock,
} from "@octant/contracts/canvas";
import type {
  AgentRunForest,
  AgentRunForestRun,
  AgentRunForestThread,
} from "./buildAgentRunForest";

const LABEL_MAX = 512;

/**
 * Snapshot the currently visible AgentRun forest as a Canvas diagram.
 * This is a document, not a live projection: callers persist it explicitly.
 */
export function buildAgentRunForestCanvasBlocks(
  forest: AgentRunForest,
): ReadonlyArray<CanvasBlock> {
  const nodes: Array<{ nodeId: string; label: string; role?: string }> = [];
  const edges: Array<{ edgeId: string; source: string; target: string; label?: string }> = [];
  const groups: Array<{ groupId: string; label: string; nodeIds: string[] }> = [];

  for (const thread of forest.threads) {
    const threadNodeId = clipToken(`thread-${thread.parentThreadId}`);
    nodes.push({
      nodeId: threadNodeId,
      label: clipLabel(thread.title),
      role: "thread",
    });
    const nodeIds = [threadNodeId];
    collectRunNodes(thread, threadNodeId, nodeIds, nodes, edges);
    groups.push({
      groupId: clipToken(`group-${thread.parentThreadId}`),
      label: clipLabel(thread.title),
      nodeIds,
    });
  }

  if (nodes.length === 0) return [];

  return [
    {
      blockId: decodeCanvasBlockId("agent-run-forest"),
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "diagram",
      nodes: nodes.map((node) => ({
        nodeId: node.nodeId as never,
        label: node.label,
        ...(node.role === undefined ? {} : { role: node.role as never }),
      })),
      edges: edges.map((edge) => ({
        edgeId: edge.edgeId as never,
        source: edge.source as never,
        target: edge.target as never,
        ...(edge.label === undefined ? {} : { label: edge.label }),
      })),
      groups: groups.map((group) => ({
        groupId: group.groupId as never,
        label: group.label,
        nodeIds: group.nodeIds as never,
      })),
      flow: "down",
      layout: "auto",
    },
  ];
}

function collectRunNodes(
  thread: AgentRunForestThread,
  parentNodeId: string,
  nodeIds: string[],
  nodes: Array<{ nodeId: string; label: string; role?: string }>,
  edges: Array<{ edgeId: string; source: string; target: string; label?: string }>,
): void {
  const walk = (run: AgentRunForestRun, parentId: string): void => {
    const nodeId = clipToken(`run-${String(run.summary.runId)}`);
    nodes.push({
      nodeId,
      label: clipLabel(run.summary.task),
      role: run.summary.role,
    });
    nodeIds.push(nodeId);
    edges.push({
      edgeId: clipToken(`edge-${parentId}-${nodeId}`),
      source: parentId,
      target: nodeId,
      label: "launched",
    });
    for (const child of run.children) walk(child, nodeId);
  };
  for (const root of thread.roots) walk(root, parentNodeId);
}

function clipLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= LABEL_MAX) return trimmed;
  return trimmed.slice(0, LABEL_MAX);
}

function clipToken(value: string): string {
  return value.length <= 128 ? value : value.slice(0, 128);
}
