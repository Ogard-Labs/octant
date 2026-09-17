import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  type CanvasBlock,
} from "@octant/contracts/canvas";
import { CANVAS_CARD_TITLE_MAX_CHARS } from "@octant/contracts/canvas-cards";
import type { AgentRunForest, AgentRunForestRun, AgentRunForestThread } from "./agentRunForest";

const LABEL_MAX = 512;

/**
 * Snapshot an AgentRun forest as a Canvas diagram document.
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
    decodeCanvasBlock({
      blockId: "agent-run-forest",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "diagram",
      nodes,
      edges,
      groups,
      flow: "down",
      layout: "auto",
    }),
  ];
}

export function agentRunForestCanvasTitle(threadTitle: string): string {
  const suffix = " agent graph";
  const base = threadTitle.trim();
  const combined = `${base}${suffix}`;
  if (combined.length <= CANVAS_CARD_TITLE_MAX_CHARS) return combined;
  const keep = Math.max(1, CANVAS_CARD_TITLE_MAX_CHARS - suffix.length);
  return `${base.slice(0, keep)}${suffix}`.slice(0, CANVAS_CARD_TITLE_MAX_CHARS);
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
  if (trimmed.length === 0) return "Untitled";
  if (trimmed.length <= LABEL_MAX) return trimmed;
  return trimmed.slice(0, LABEL_MAX);
}

function clipToken(value: string): string {
  return value.length <= 128 ? value : value.slice(0, 128);
}
