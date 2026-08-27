import type { CanvasDiagramBlock, CanvasDiagramFlow } from "@octant/contracts/canvas";

/**
 * Where a diagram's parts sit, worked out from the diagram alone.
 *
 * Layout is a pure reading of the block, so every surface that draws a diagram
 * — the thread tab, a pinned card, a share export — draws the same picture from
 * the same data. Nothing here decides what a diagram means; it decides where
 * the reader's eye goes, which is why it is data and not markup.
 */
export interface CanvasDiagramLayout {
  readonly width: number;
  readonly height: number;
  readonly flow: CanvasDiagramFlow;
  readonly nodes: ReadonlyArray<CanvasDiagramNodeBox>;
  readonly edges: ReadonlyArray<CanvasDiagramEdgeRoute>;
  readonly groups: ReadonlyArray<CanvasDiagramGroupBox>;
}

export interface CanvasDiagramNodeBox {
  readonly nodeId: string;
  readonly label: string;
  readonly role?: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasDiagramEdgeRoute {
  readonly edgeId: string;
  readonly label?: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly labelX: number;
  readonly labelY: number;
}

export interface CanvasDiagramGroupBox {
  readonly groupId: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const NODE_WIDTH = 160;
const NODE_HEIGHT = 48;
/**
 * Room between ranks, wide enough for an edge label and a group's own name to
 * sit between two boxes without landing on each other.
 */
const RANK_GAP = 96;
const SIBLING_GAP = 24;
const GROUP_PADDING = 16;
/** Room above a group's contents for its own label. */
const GROUP_LABEL_HEIGHT = 20;
const MARGIN = 24;

/**
 * Rank every node by the longest path that reaches it.
 *
 * Longest path rather than shortest: a node is drawn after everything it
 * depends on, so an architecture reads in the direction its arrows point. Edges
 * that would close a cycle are ignored for ranking — a cycle has no first node,
 * and refusing to draw one would be worse than drawing it flattened.
 */
function rankNodes(block: CanvasDiagramBlock): Map<string, number> {
  const order = block.nodes.map((node) => String(node.nodeId));
  const position = new Map(order.map((nodeId, index) => [nodeId, index]));
  const incoming = new Map<string, string[]>(order.map((nodeId) => [nodeId, []]));
  for (const edge of block.edges) {
    const source = String(edge.source);
    const target = String(edge.target);
    // Only edges that run forward in declaration order rank a node. That is
    // what makes the result the same on every machine and every reload, and it
    // is what stops a cycle from ranking forever.
    if ((position.get(source) ?? 0) < (position.get(target) ?? 0)) {
      incoming.get(target)?.push(source);
    }
  }
  const ranks = new Map<string, number>();
  for (const nodeId of order) {
    const sources = incoming.get(nodeId) ?? [];
    const rank = sources.reduce(
      (highest, source) => Math.max(highest, (ranks.get(source) ?? 0) + 1),
      0,
    );
    ranks.set(nodeId, rank);
  }
  return ranks;
}

/**
 * Place a diagram's nodes, edges, and groups on a fixed grid.
 *
 * A node that carries its own `x` and `y` keeps them: those are the author's,
 * and a future editor that lets someone drag a node writes them there. Every
 * other node is placed by rank, so a diagram nobody has arranged still reads.
 */
export function layoutCanvasDiagram(block: CanvasDiagramBlock): CanvasDiagramLayout {
  const flow = block.flow ?? "down";
  const autoLayout = block.layout === "auto";
  const ranks = rankNodes(block);
  const withinRank = new Map<number, number>();
  const boxes = block.nodes.map((node) => {
    const nodeId = String(node.nodeId);
    const rank = ranks.get(nodeId) ?? 0;
    const slot = withinRank.get(rank) ?? 0;
    withinRank.set(rank, slot + 1);
    const alongFlow = MARGIN + rank * (rankExtent(flow) + RANK_GAP);
    const acrossFlow = MARGIN + slot * (siblingExtent(flow) + SIBLING_GAP);
    const authoredX = autoLayout ? undefined : node.x;
    const authoredY = autoLayout ? undefined : node.y;
    return {
      nodeId,
      label: node.label,
      ...(node.role === undefined ? {} : { role: node.role }),
      x: authoredX ?? (flow === "down" ? acrossFlow : alongFlow),
      y: authoredY ?? (flow === "down" ? alongFlow : acrossFlow),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  const byId = new Map(boxes.map((box) => [box.nodeId, box]));

  const groups = (block.groups ?? []).flatMap((group) => {
    const members: CanvasDiagramNodeBox[] = [];
    for (const nodeId of group.nodeIds) {
      const member = byId.get(String(nodeId));
      if (member !== undefined) members.push(member);
    }
    if (members.length === 0) return [];
    const left = Math.min(...members.map((member) => member.x));
    const top = Math.min(...members.map((member) => member.y));
    const right = Math.max(...members.map((member) => member.x + member.width));
    const bottom = Math.max(...members.map((member) => member.y + member.height));
    return [
      {
        groupId: String(group.groupId),
        label: group.label,
        x: left - GROUP_PADDING,
        y: top - GROUP_PADDING - GROUP_LABEL_HEIGHT,
        width: right - left + GROUP_PADDING * 2,
        height: bottom - top + GROUP_PADDING * 2 + GROUP_LABEL_HEIGHT,
      },
    ];
  });

  const edges = block.edges.flatMap((edge) => {
    const source = byId.get(String(edge.source));
    const target = byId.get(String(edge.target));
    if (source === undefined || target === undefined) return [];
    const from = center(source);
    const to = center(target);
    return [
      {
        edgeId: String(edge.edgeId),
        ...(edge.label === undefined ? {} : { label: edge.label }),
        ...borderToBorder(source, target, from, to),
        labelX: (from.x + to.x) / 2,
        labelY: (from.y + to.y) / 2,
      },
    ];
  });

  const extents = [
    ...boxes.map((box) => ({ right: box.x + box.width, bottom: box.y + box.height })),
    ...groups.map((group) => ({ right: group.x + group.width, bottom: group.y + group.height })),
  ];
  return {
    width: Math.max(...extents.map((extent) => extent.right), MARGIN) + MARGIN,
    height: Math.max(...extents.map((extent) => extent.bottom), MARGIN) + MARGIN,
    flow,
    nodes: boxes,
    edges,
    groups,
  };
}

function rankExtent(flow: CanvasDiagramFlow): number {
  return flow === "down" ? NODE_HEIGHT : NODE_WIDTH;
}

function siblingExtent(flow: CanvasDiagramFlow): number {
  return flow === "down" ? NODE_WIDTH : NODE_HEIGHT;
}

function center(box: CanvasDiagramNodeBox): { readonly x: number; readonly y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Stop each end of an edge at the node's border rather than its centre, so the
 * line meets the box instead of disappearing under it.
 */
function borderToBorder(
  source: CanvasDiagramNodeBox,
  target: CanvasDiagramNodeBox,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number } {
  const start = borderPoint(source, from, to);
  const end = borderPoint(target, to, from);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

function borderPoint(
  box: CanvasDiagramNodeBox,
  from: { readonly x: number; readonly y: number },
  toward: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  if (dx === 0 && dy === 0) return from;
  const scaleX = dx === 0 ? Infinity : box.width / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : box.height / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}
