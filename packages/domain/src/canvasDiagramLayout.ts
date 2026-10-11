import {
  CANVAS_DIAGRAM_STYLES_SCHEMA_VERSION,
  isCanvasDiagramNodeRole,
  type CanvasDiagramBlock,
  type CanvasDiagramEdgeStyle,
  type CanvasDiagramFlow,
  type CanvasDiagramTone,
} from "@octant/contracts/canvas";

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

/**
 * The shape a node is drawn as: `process` a box, `decision` a diamond,
 * `terminator` a pill, and `plain` the rounded box of a node without a role.
 * A role outside the closed set, and any role on a block older than the
 * diagram-styles version, draws as `plain`.
 */
export type CanvasDiagramNodeShape = "plain" | "process" | "decision" | "terminator";

export function canvasDiagramNodeShape(role: string | undefined): CanvasDiagramNodeShape {
  return isCanvasDiagramNodeRole(role) ? role : "plain";
}

export interface CanvasDiagramNodeBox {
  readonly nodeId: string;
  readonly label: string;
  readonly role?: string;
  readonly shape: CanvasDiagramNodeShape;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasDiagramEdgeRoute {
  readonly edgeId: string;
  readonly label?: string;
  /** Absent on the wire reads as `line`, the drawing every older diagram had. */
  readonly style: CanvasDiagramEdgeStyle;
  readonly tone?: CanvasDiagramTone;
  /**
   * The drawn path, start to end. Two points for a straight edge; four when
   * the straight line would cross another node, so the edge steps out beside
   * the column and back rather than running under boxes it does not join.
   * `x1`..`y2` are its first and last points.
   */
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>;
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
  readonly tone?: CanvasDiagramTone;
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
/** Room between two bands of a grouped diagram: both frames' padding and a name. */
const BAND_GAP = GROUP_PADDING * 2 + GROUP_LABEL_HEIGHT;
/** Room between a detouring edge and the boxes it steps around. */
const DETOUR_GAP = 20;

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
 * Where each node sits across the flow: its slot, counted from the near edge,
 * and how many band gaps precede it.
 *
 * Without groups a node takes the next free slot in its rank. With groups,
 * each group is a band of slots of its own across every rank, after a band of
 * the ungrouped nodes, so two groups never share a slot range and their frames
 * cannot overlap even when their members sit in different ranks: a zone map
 * reads as regions rather than as frames drawn over each other.
 */
function acrossFlowSlots(
  block: CanvasDiagramBlock,
  ranks: ReadonlyMap<string, number>,
): ReadonlyMap<string, { readonly slot: number; readonly band: number }> {
  const groups = block.groups ?? [];
  const bandOf = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const nodeId of group.nodeIds) bandOf.set(String(nodeId), index + 1);
  });
  const bandCount = groups.length + 1;
  // How many slots each band needs: its most crowded rank.
  const counts = new Map<string, number>();
  const widths = Array.from({ length: bandCount }, () => 0);
  const order: Array<{ readonly nodeId: string; readonly band: number; readonly index: number }> =
    [];
  for (const node of block.nodes) {
    const nodeId = String(node.nodeId);
    const band = bandOf.get(nodeId) ?? 0;
    const key = `${String(band)}:${String(ranks.get(nodeId) ?? 0)}`;
    const index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    widths[band] = Math.max(widths[band] ?? 0, index + 1);
    order.push({ nodeId, band, index });
  }
  const placements = new Map<string, { readonly slot: number; readonly band: number }>();
  for (const { nodeId, band, index } of order) {
    let start = 0;
    let gaps = 0;
    for (let earlier = 0; earlier < band; earlier += 1) {
      const width = widths[earlier] ?? 0;
      start += width;
      if (width > 0) gaps += 1;
    }
    placements.set(nodeId, { slot: start + index, band: groups.length === 0 ? 0 : gaps });
  }
  return placements;
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
  const across = acrossFlowSlots(block, ranks);
  // Groups need room above their nodes for a frame and a name, so a grouped
  // diagram starts that much further in rather than drawing its first frame
  // above the picture's edge.
  const origin =
    MARGIN + ((block.groups ?? []).length > 0 ? GROUP_PADDING + GROUP_LABEL_HEIGHT : 0);
  // Before the diagram-styles version a role was free text, so an older
  // block that happened to write `decision` meant nothing by it and keeps the
  // plain box rather than being redrawn as a shape it never asked for.
  const styled = block.schemaVersion >= CANVAS_DIAGRAM_STYLES_SCHEMA_VERSION;
  const boxes = block.nodes.map((node) => {
    const nodeId = String(node.nodeId);
    const rank = ranks.get(nodeId) ?? 0;
    const placement = across.get(nodeId) ?? { slot: 0, band: 0 };
    const alongFlow = origin + rank * (rankExtent(flow) + RANK_GAP);
    const acrossFlow =
      origin + placement.slot * (siblingExtent(flow) + SIBLING_GAP) + placement.band * BAND_GAP;
    const authoredX = autoLayout ? undefined : node.x;
    const authoredY = autoLayout ? undefined : node.y;
    return {
      nodeId,
      label: node.label,
      ...(node.role === undefined ? {} : { role: node.role }),
      shape: styled ? canvasDiagramNodeShape(node.role) : "plain",
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
        ...(group.tone === undefined ? {} : { tone: group.tone }),
        x: left - GROUP_PADDING,
        y: top - GROUP_PADDING - GROUP_LABEL_HEIGHT,
        width: right - left + GROUP_PADDING * 2,
        height: bottom - top + GROUP_PADDING * 2 + GROUP_LABEL_HEIGHT,
      },
    ];
  });

  const edges = block.edges.flatMap((edge): ReadonlyArray<CanvasDiagramEdgeRoute> => {
    const source = byId.get(String(edge.source));
    const target = byId.get(String(edge.target));
    if (source === undefined || target === undefined) return [];
    const from = center(source);
    const to = center(target);
    const common = {
      edgeId: String(edge.edgeId),
      ...(edge.label === undefined ? {} : { label: edge.label }),
      style: edge.style ?? "line",
      ...(edge.tone === undefined ? {} : { tone: edge.tone }),
    } as const;
    const blockers = boxes.filter(
      (box) => box !== source && box !== target && crosses(box, from, to),
    );
    if (blockers.length === 0) {
      const ends = borderToBorder(source, target, from, to);
      return [
        {
          ...common,
          ...ends,
          points: [
            { x: ends.x1, y: ends.y1 },
            { x: ends.x2, y: ends.y2 },
          ],
          labelX: (from.x + to.x) / 2,
          labelY: (from.y + to.y) / 2,
        },
      ];
    }
    // Step out past every box the straight line would cross, on the side away
    // from the flow: right of a column that reads down, below a row that
    // reads right.
    const spanned = [source, target, ...blockers];
    const points =
      flow === "down"
        ? (() => {
            const lane = Math.max(...spanned.map((box) => box.x + box.width)) + DETOUR_GAP;
            return [
              { x: source.x + source.width, y: from.y },
              { x: lane, y: from.y },
              { x: lane, y: to.y },
              { x: target.x + target.width, y: to.y },
            ];
          })()
        : (() => {
            const lane = Math.max(...spanned.map((box) => box.y + box.height)) + DETOUR_GAP;
            return [
              { x: from.x, y: source.y + source.height },
              { x: from.x, y: lane },
              { x: to.x, y: lane },
              { x: to.x, y: target.y + target.height },
            ];
          })();
    const first = points[0] ?? from;
    const last = points.at(-1) ?? to;
    const bendA = points[1] ?? from;
    const bendB = points[2] ?? to;
    return [
      {
        ...common,
        x1: first.x,
        y1: first.y,
        x2: last.x,
        y2: last.y,
        points,
        labelX: (bendA.x + bendB.x) / 2,
        labelY: (bendA.y + bendB.y) / 2,
      },
    ];
  });

  const extents = [
    ...edges.flatMap((edge) =>
      edge.points.map((point) => ({ right: point.x + DETOUR_GAP, bottom: point.y + DETOUR_GAP })),
    ),
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

/**
 * Whether the straight line between two centres runs through a box. Sampled
 * at fixed steps, so the answer is the same on every machine; the inset keeps
 * a line that only grazes a corner from counting as a crossing.
 */
function crosses(
  box: CanvasDiagramNodeBox,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): boolean {
  const inset = 4;
  for (let step = 1; step < 32; step += 1) {
    const t = step / 32;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    if (
      x > box.x + inset &&
      x < box.x + box.width - inset &&
      y > box.y + inset &&
      y < box.y + box.height - inset
    ) {
      return true;
    }
  }
  return false;
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
  // A diamond's border is where |dx|/half-width + |dy|/half-height reaches 1,
  // so an edge meets its slanted side rather than the box it sits in.
  if (box.shape === "decision") {
    const scale = 1 / (Math.abs(dx) / (box.width / 2) + Math.abs(dy) / (box.height / 2));
    return { x: from.x + dx * scale, y: from.y + dy * scale };
  }
  const scaleX = dx === 0 ? Infinity : box.width / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : box.height / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}
