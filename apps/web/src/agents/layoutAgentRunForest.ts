import type { AgentRunCenterSummary } from "@octant/contracts";
import type { AgentRunForest, AgentRunForestRun, AgentRunForestThread } from "@octant/domain";

export const AGENT_RUN_GRAPH_RUN_CARD_WIDTH = 260;
export const AGENT_RUN_GRAPH_RUN_CARD_HEIGHT = 152;
export const AGENT_RUN_GRAPH_THREAD_CARD_WIDTH = 260;
export const AGENT_RUN_GRAPH_THREAD_CARD_HEIGHT = 72;
export const AGENT_RUN_GRAPH_HORIZONTAL_GAP = 28;
export const AGENT_RUN_GRAPH_VERTICAL_GAP = 56;
export const AGENT_RUN_GRAPH_TREE_GAP = 48;
export const AGENT_RUN_GRAPH_MARGIN = 24;

export type AgentRunGraphBox =
  | {
      readonly kind: "thread";
      readonly id: string;
      readonly thread: AgentRunForestThread<AgentRunCenterSummary>;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "run";
      readonly id: string;
      readonly summary: AgentRunCenterSummary;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };

export interface AgentRunGraphEdge {
  readonly fromId: string;
  readonly toId: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface AgentRunGraphLayout {
  readonly width: number;
  readonly height: number;
  readonly boxes: ReadonlyArray<AgentRunGraphBox>;
  readonly edges: ReadonlyArray<AgentRunGraphEdge>;
}

export function threadGraphId(parentThreadId: string): string {
  return `thread:${parentThreadId}`;
}

export function runGraphId(runId: string): string {
  return `run:${runId}`;
}

/**
 * Place the forest top-down: each parent thread above the runs it launched,
 * children under the run that launched them. Empty pages have no boxes.
 */
export function layoutAgentRunForest(
  forest: AgentRunForest<AgentRunCenterSummary>,
): AgentRunGraphLayout {
  if (forest.threads.length === 0) {
    return { width: 0, height: 0, boxes: [], edges: [] };
  }

  const boxes: AgentRunGraphBox[] = [];
  const edges: AgentRunGraphEdge[] = [];
  let cursorX = AGENT_RUN_GRAPH_MARGIN;
  let maxBottom = AGENT_RUN_GRAPH_MARGIN;

  for (const thread of forest.threads) {
    const placed = placeThread(thread, cursorX, AGENT_RUN_GRAPH_MARGIN);
    boxes.push(...placed.boxes);
    edges.push(...placed.edges);
    cursorX += placed.width + AGENT_RUN_GRAPH_TREE_GAP;
    maxBottom = Math.max(maxBottom, placed.bottom);
  }

  return {
    width: cursorX - AGENT_RUN_GRAPH_TREE_GAP + AGENT_RUN_GRAPH_MARGIN,
    height: maxBottom + AGENT_RUN_GRAPH_MARGIN,
    boxes,
    edges,
  };
}

function placeThread(
  thread: AgentRunForestThread<AgentRunCenterSummary>,
  left: number,
  top: number,
): {
  readonly boxes: ReadonlyArray<AgentRunGraphBox>;
  readonly edges: ReadonlyArray<AgentRunGraphEdge>;
  readonly width: number;
  readonly bottom: number;
} {
  const contentWidth = Math.max(AGENT_RUN_GRAPH_THREAD_CARD_WIDTH, subtreeRowWidth(thread.roots));
  const threadId = threadGraphId(thread.parentThreadId);
  const threadX = left + Math.round((contentWidth - AGENT_RUN_GRAPH_THREAD_CARD_WIDTH) / 2);
  const boxes: AgentRunGraphBox[] = [
    {
      kind: "thread",
      id: threadId,
      thread,
      x: threadX,
      y: top,
      width: AGENT_RUN_GRAPH_THREAD_CARD_WIDTH,
      height: AGENT_RUN_GRAPH_THREAD_CARD_HEIGHT,
    },
  ];
  const edges: AgentRunGraphEdge[] = [];
  const runTop = top + AGENT_RUN_GRAPH_THREAD_CARD_HEIGHT + AGENT_RUN_GRAPH_VERTICAL_GAP;
  let childLeft = left;
  let bottom = top + AGENT_RUN_GRAPH_THREAD_CARD_HEIGHT;
  for (const root of thread.roots) {
    const placed = placeRun(root, childLeft, runTop);
    boxes.push(...placed.boxes);
    edges.push(...placed.edges);
    edges.push(
      connect(
        threadId,
        runGraphId(String(root.summary.runId)),
        {
          x: threadX,
          y: top,
          width: AGENT_RUN_GRAPH_THREAD_CARD_WIDTH,
          height: AGENT_RUN_GRAPH_THREAD_CARD_HEIGHT,
        },
        placed.box,
      ),
    );
    childLeft += placed.width + AGENT_RUN_GRAPH_HORIZONTAL_GAP;
    bottom = Math.max(bottom, placed.bottom);
  }
  return { boxes, edges, width: contentWidth, bottom };
}

function placeRun(
  node: AgentRunForestRun<AgentRunCenterSummary>,
  left: number,
  top: number,
): {
  readonly boxes: ReadonlyArray<AgentRunGraphBox>;
  readonly edges: ReadonlyArray<AgentRunGraphEdge>;
  readonly box: {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly width: number;
  readonly bottom: number;
} {
  const contentWidth = Math.max(AGENT_RUN_GRAPH_RUN_CARD_WIDTH, subtreeRowWidth(node.children));
  const x = left + Math.round((contentWidth - AGENT_RUN_GRAPH_RUN_CARD_WIDTH) / 2);
  const box = {
    kind: "run" as const,
    id: runGraphId(String(node.summary.runId)),
    summary: node.summary,
    x,
    y: top,
    width: AGENT_RUN_GRAPH_RUN_CARD_WIDTH,
    height: AGENT_RUN_GRAPH_RUN_CARD_HEIGHT,
  };
  const boxes: AgentRunGraphBox[] = [box];
  const edges: AgentRunGraphEdge[] = [];
  let bottom = top + AGENT_RUN_GRAPH_RUN_CARD_HEIGHT;
  let childLeft = left;
  const childTop = top + AGENT_RUN_GRAPH_RUN_CARD_HEIGHT + AGENT_RUN_GRAPH_VERTICAL_GAP;
  for (const child of node.children) {
    const placed = placeRun(child, childLeft, childTop);
    boxes.push(...placed.boxes);
    edges.push(...placed.edges);
    edges.push(connect(box.id, placed.box.id, box, placed.box));
    childLeft += placed.width + AGENT_RUN_GRAPH_HORIZONTAL_GAP;
    bottom = Math.max(bottom, placed.bottom);
  }
  return { boxes, edges, box, width: contentWidth, bottom };
}

function subtreeRowWidth(nodes: ReadonlyArray<AgentRunForestRun<AgentRunCenterSummary>>): number {
  if (nodes.length === 0) return 0;
  let width = 0;
  for (const [index, node] of nodes.entries()) {
    width += Math.max(AGENT_RUN_GRAPH_RUN_CARD_WIDTH, subtreeRowWidth(node.children));
    if (index < nodes.length - 1) width += AGENT_RUN_GRAPH_HORIZONTAL_GAP;
  }
  return width;
}

function connect(
  fromId: string,
  toId: string,
  from: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  to: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): AgentRunGraphEdge {
  return {
    fromId,
    toId,
    x1: from.x + Math.round(from.width / 2),
    y1: from.y + from.height,
    x2: to.x + Math.round(to.width / 2),
    y2: to.y,
  };
}
