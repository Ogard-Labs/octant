import {
  CANVAS_DIAGRAM_STYLES_SCHEMA_VERSION,
  isCanvasDiagramNodeRole,
  type CanvasDiagramBlock,
  type CanvasDiagramEdgeStyle,
  type CanvasDiagramFlow,
  type CanvasDiagramNodeIcon,
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
  readonly icon?: CanvasDiagramNodeIcon;
  /** The full subtitle; draw `canvasDiagramNodeContent(node).detail`, which fits the box. */
  readonly detail?: string;
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
  /** The group this one sits inside, when that group is drawn too. */
  readonly parentGroupId?: string;
  /** 1 for a top-level group, 2 for a group inside it, and so on. */
  readonly depth: number;
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
 * The groups as a forest, parents before their children, each group's
 * children in declaration order. An unknown parent makes a group top-level and
 * a cycle is cut at its first group in declaration order: the policy refuses
 * both, but a layout is a pure reading and must not lose a group to bad data.
 */
function groupForest(block: CanvasDiagramBlock): {
  readonly preorder: ReadonlyArray<string>;
  readonly parentOf: ReadonlyMap<string, string>;
  readonly depthOf: ReadonlyMap<string, number>;
} {
  const groups = (block.groups ?? []).map((group) => String(group.groupId));
  const known = new Set(groups);
  const parentOf = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const group of block.groups ?? []) {
    const id = String(group.groupId);
    const parent = group.parentGroupId === undefined ? undefined : String(group.parentGroupId);
    if (parent === undefined || parent === id || !known.has(parent)) continue;
    parentOf.set(id, parent);
    children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  const preorder: string[] = [];
  const depthOf = new Map<string, number>();
  const visit = (id: string, depth: number): void => {
    if (depthOf.has(id)) return;
    depthOf.set(id, depth);
    preorder.push(id);
    for (const child of children.get(id) ?? []) visit(child, depth + 1);
  };
  for (const id of groups) if (!parentOf.has(id)) visit(id, 1);
  for (const id of groups) {
    if (depthOf.has(id)) continue;
    parentOf.delete(id);
    visit(id, 1);
  }
  return { preorder, parentOf, depthOf };
}

/**
 * Where each node sits across the flow: its slot, counted from the near edge,
 * and the extra room in pixels that precedes its band.
 *
 * Without groups a node takes a slot in its rank. With groups, each group is a
 * band of slots of its own across every rank — a parent's own nodes, then each
 * child group's band — after a band of the ungrouped nodes, so two groups never
 * share a slot range and their frames cannot overlap even when their members
 * sit in different ranks: a zone map reads as regions rather than as frames
 * drawn over each other. A band is followed by room for every frame that
 * closes after it and every frame that opens before the next one.
 */
function acrossFlowSlots(
  block: CanvasDiagramBlock,
  ranks: ReadonlyMap<string, number>,
  forest: ReturnType<typeof groupForest>,
): ReadonlyMap<string, { readonly slot: number; readonly offset: number }> {
  const bandOfGroup = new Map(forest.preorder.map((id, index) => [id, index + 1]));
  const bandOf = new Map<string, number>();
  for (const group of block.groups ?? []) {
    const band = bandOfGroup.get(String(group.groupId)) ?? 0;
    for (const nodeId of group.nodeIds) bandOf.set(String(nodeId), band);
  }
  const bandCount = forest.preorder.length + 1;
  const members = Array.from({ length: bandCount }, () => 0);
  for (const node of block.nodes) {
    const band = bandOf.get(String(node.nodeId)) ?? 0;
    members[band] = (members[band] ?? 0) + 1;
  }
  const order = orderWithinCells(block, ranks, bandOf, bandCount);
  const widths = Array.from({ length: bandCount }, () => 0);
  for (const { band, index } of order.values()) {
    widths[band] = Math.max(widths[band] ?? 0, index + 1);
  }

  // Frames that are drawn: a group holding a node, directly or through a
  // child. `last` is the final band of a group's subtree.
  const lastBand = new Map<string, number>();
  const holds = new Map<string, boolean>();
  for (const id of [...forest.preorder].reverse()) {
    const own = bandOfGroup.get(id) ?? 0;
    holds.set(id, (holds.get(id) ?? false) || (members[own] ?? 0) > 0);
    lastBand.set(id, Math.max(lastBand.get(id) ?? own, own));
    const parent = forest.parentOf.get(id);
    if (parent !== undefined) {
      lastBand.set(parent, Math.max(lastBand.get(parent) ?? 0, lastBand.get(id) ?? own));
      holds.set(parent, (holds.get(parent) ?? false) || (holds.get(id) ?? false));
    }
  }
  const framed = forest.preorder.filter((id) => holds.get(id) === true);

  const start = Array.from({ length: bandCount }, () => 0);
  const offset = Array.from({ length: bandCount }, () => 0);
  let slots = 0;
  let previous: number | undefined;
  for (let band = 0; band < bandCount; band += 1) {
    start[band] = slots;
    slots += widths[band] ?? 0;
    if ((widths[band] ?? 0) === 0) continue;
    if (previous !== undefined && forest.preorder.length > 0) {
      let opens = 0;
      let closes = 0;
      for (const id of framed) {
        const opened = bandOfGroup.get(id) ?? 0;
        const closed = lastBand.get(id) ?? opened;
        if (opened > previous && opened <= band) opens += 1;
        if (closed >= previous && closed < band) closes += 1;
      }
      const room = closes * GROUP_PADDING + opens * (GROUP_PADDING + GROUP_LABEL_HEIGHT);
      offset[band] = (offset[previous] ?? 0) + Math.max(BAND_GAP, room);
    } else {
      offset[band] = previous === undefined ? 0 : (offset[previous] ?? 0);
    }
    previous = band;
  }
  const placements = new Map<string, { readonly slot: number; readonly offset: number }>();
  for (const [nodeId, { band, index }] of order) {
    placements.set(nodeId, { slot: (start[band] ?? 0) + index, offset: offset[band] ?? 0 });
  }
  return placements;
}

/** How many times the order is swept down and up the ranks before it is kept. */
const CROSSING_SWEEPS = 12;

/**
 * The order of the nodes inside each (band, rank) cell, as an index per node.
 *
 * The first order is declaration order. Barycenter sweeps then move each node
 * toward the mean position of its neighbours on the ranks before it (down), or
 * after it (up), and the order with the fewest crossings seen is kept, so a
 * sweep can only help: a diagram already free of crossings keeps the order its
 * author wrote. Only nodes inside one cell trade places; the bands of a grouped
 * diagram keep the order the groups were declared in. Sweeps, and the pair
 * count inside each, are bounded by the contract's edge limit.
 */
function orderWithinCells(
  block: CanvasDiagramBlock,
  ranks: ReadonlyMap<string, number>,
  bandOf: ReadonlyMap<string, number>,
  bandCount: number,
): ReadonlyMap<string, { readonly band: number; readonly index: number }> {
  const cells = new Map<string, string[]>();
  const band = new Map<string, number>();
  for (const node of block.nodes) {
    const nodeId = String(node.nodeId);
    const own = bandOf.get(nodeId) ?? 0;
    const key = `${String(own)}:${String(ranks.get(nodeId) ?? 0)}`;
    const cell = cells.get(key) ?? [];
    cell.push(nodeId);
    cells.set(key, cell);
    band.set(nodeId, own);
  }
  const index = new Map<string, number>();
  const reindex = (cell: ReadonlyArray<string>): void =>
    cell.forEach((nodeId, position) => index.set(nodeId, position));
  for (const cell of cells.values()) reindex(cell);

  const widths = Array.from({ length: bandCount }, () => 0);
  for (const [nodeId, position] of index) {
    const own = band.get(nodeId) ?? 0;
    widths[own] = Math.max(widths[own] ?? 0, position + 1);
  }
  const start: number[] = [];
  let slots = 0;
  for (const width of widths) {
    start.push(slots);
    slots += width;
  }
  const slotOf = (nodeId: string): number =>
    (start[band.get(nodeId) ?? 0] ?? 0) + (index.get(nodeId) ?? 0);

  // Each edge once, from its lower rank to its higher one.
  const spans: Array<{ readonly low: string; readonly high: string }> = [];
  const before = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  for (const edge of block.edges) {
    const source = String(edge.source);
    const target = String(edge.target);
    const sourceRank = ranks.get(source);
    const targetRank = ranks.get(target);
    if (sourceRank === undefined || targetRank === undefined || sourceRank === targetRank) continue;
    const [low, high] = sourceRank < targetRank ? [source, target] : [target, source];
    spans.push({ low, high });
    before.set(high, [...(before.get(high) ?? []), low]);
    after.set(low, [...(after.get(low) ?? []), high]);
  }
  const snapshot = (): ReadonlyMap<string, { readonly band: number; readonly index: number }> =>
    new Map(
      [...index].map(([nodeId, position]) => [
        nodeId,
        { band: band.get(nodeId) ?? 0, index: position },
      ]),
    );
  let best = snapshot();
  let fewest = countCrossings(spans, ranks, slotOf);
  if (fewest === 0) return best;

  const cellsByRank = new Map<number, string[][]>();
  for (const [key, cell] of cells) {
    const rank = Number(key.slice(key.indexOf(":") + 1));
    cellsByRank.set(rank, [...(cellsByRank.get(rank) ?? []), cell]);
  }
  const rankOrder = [...cellsByRank.keys()].sort((a, b) => a - b);
  for (let sweep = 0; sweep < CROSSING_SWEEPS; sweep += 1) {
    const down = sweep % 2 === 0;
    for (const rank of down ? rankOrder : [...rankOrder].reverse()) {
      for (const cell of cellsByRank.get(rank) ?? []) {
        const keyed = cell.map((nodeId, position) => {
          const neighbours = (down ? before : after).get(nodeId) ?? [];
          const barycenter =
            neighbours.length === 0
              ? slotOf(nodeId)
              : neighbours.reduce((sum, other) => sum + slotOf(other), 0) / neighbours.length;
          return { nodeId, barycenter, position };
        });
        keyed.sort((a, b) => a.barycenter - b.barycenter || a.position - b.position);
        const ordered = keyed.map((entry) => entry.nodeId);
        cell.splice(0, cell.length, ...ordered);
        reindex(cell);
      }
    }
    const crossings = countCrossings(spans, ranks, slotOf);
    if (crossings < fewest) {
      fewest = crossings;
      best = snapshot();
      if (fewest === 0) break;
    }
  }
  return best;
}

/**
 * How many pairs of edges cross, each edge drawn straight from its slot on one
 * rank to its slot on another. Two edges that meet at a shared node do not.
 */
function countCrossings(
  spans: ReadonlyArray<{ readonly low: string; readonly high: string }>,
  ranks: ReadonlyMap<string, number>,
  slotOf: (nodeId: string) => number,
): number {
  const lines = spans.map(({ low, high }) => ({
    fromRank: ranks.get(low) ?? 0,
    toRank: ranks.get(high) ?? 0,
    fromSlot: slotOf(low),
    toSlot: slotOf(high),
  }));
  const slotAt = (line: (typeof lines)[number], rank: number): number =>
    line.fromSlot +
    ((line.toSlot - line.fromSlot) * (rank - line.fromRank)) / (line.toRank - line.fromRank);
  let crossings = 0;
  for (let first = 0; first < lines.length; first += 1) {
    const a = lines[first];
    if (a === undefined) continue;
    for (let second = first + 1; second < lines.length; second += 1) {
      const b = lines[second];
      if (b === undefined) continue;
      const from = Math.max(a.fromRank, b.fromRank);
      const to = Math.min(a.toRank, b.toRank);
      if (from >= to) continue;
      const atStart = slotAt(a, from) - slotAt(b, from);
      const atEnd = slotAt(a, to) - slotAt(b, to);
      if (atStart * atEnd < 0) crossings += 1;
    }
  }
  return crossings;
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
  const forest = groupForest(block);
  const across = acrossFlowSlots(block, ranks, forest);
  // Groups need room above their nodes for a frame and a name, so a grouped
  // diagram starts that much further in, once per level of nesting, rather
  // than drawing its first frame above the picture's edge.
  const origin =
    MARGIN + Math.max(0, ...forest.depthOf.values()) * (GROUP_PADDING + GROUP_LABEL_HEIGHT);
  // Before the diagram-styles version a role was free text, so an older
  // block that happened to write `decision` meant nothing by it and keeps the
  // plain box rather than being redrawn as a shape it never asked for.
  const styled = block.schemaVersion >= CANVAS_DIAGRAM_STYLES_SCHEMA_VERSION;
  const boxes = block.nodes.map((node) => {
    const nodeId = String(node.nodeId);
    const rank = ranks.get(nodeId) ?? 0;
    const placement = across.get(nodeId) ?? { slot: 0, offset: 0 };
    const alongFlow = origin + rank * (rankExtent(flow) + RANK_GAP);
    const acrossFlow =
      origin + placement.slot * (siblingExtent(flow) + SIBLING_GAP) + placement.offset;
    const authoredX = autoLayout ? undefined : node.x;
    const authoredY = autoLayout ? undefined : node.y;
    return {
      nodeId,
      label: node.label,
      ...(node.role === undefined ? {} : { role: node.role }),
      ...(node.icon === undefined ? {} : { icon: node.icon }),
      ...(node.detail === undefined ? {} : { detail: node.detail }),
      shape: styled ? canvasDiagramNodeShape(node.role) : "plain",
      x: authoredX ?? (flow === "down" ? acrossFlow : alongFlow),
      y: authoredY ?? (flow === "down" ? alongFlow : acrossFlow),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  const byId = new Map(boxes.map((box) => [box.nodeId, box]));

  // A group's frame wraps its own nodes and the frames of its child groups, so
  // a child sits inside its parent whatever the author placed by hand. Children
  // are framed first; the result is read back parents first so a parent is
  // painted beneath the groups it holds.
  const declared = new Map((block.groups ?? []).map((group) => [String(group.groupId), group]));
  const framed = new Map<string, CanvasDiagramGroupBox>();
  for (const groupId of [...forest.preorder].reverse()) {
    const group = declared.get(groupId);
    if (group === undefined) continue;
    const parts: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    for (const nodeId of group.nodeIds) {
      const member = byId.get(String(nodeId));
      if (member !== undefined) {
        parts.push({
          left: member.x,
          top: member.y,
          right: member.x + member.width,
          bottom: member.y + member.height,
        });
      }
    }
    for (const [childId, parentId] of forest.parentOf) {
      const child = parentId === groupId ? framed.get(childId) : undefined;
      if (child !== undefined) {
        parts.push({
          left: child.x,
          top: child.y,
          right: child.x + child.width,
          bottom: child.y + child.height,
        });
      }
    }
    if (parts.length === 0) continue;
    const left = Math.min(...parts.map((part) => part.left));
    const top = Math.min(...parts.map((part) => part.top));
    const right = Math.max(...parts.map((part) => part.right));
    const bottom = Math.max(...parts.map((part) => part.bottom));
    const parent = forest.parentOf.get(groupId);
    framed.set(groupId, {
      groupId,
      label: group.label,
      ...(group.tone === undefined ? {} : { tone: group.tone }),
      ...(parent === undefined ? {} : { parentGroupId: parent }),
      depth: forest.depthOf.get(groupId) ?? 1,
      x: left - GROUP_PADDING,
      y: top - GROUP_PADDING - GROUP_LABEL_HEIGHT,
      width: right - left + GROUP_PADDING * 2,
      height: bottom - top + GROUP_PADDING * 2 + GROUP_LABEL_HEIGHT,
    });
  }
  const groups = forest.preorder.flatMap((groupId) => framed.get(groupId) ?? []);

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

  // Frames grow left and up by their padding and name, so a hand-placed node
  // near the origin pushes the outermost frame to a negative coordinate, where
  // a renderer's viewport clips its label. Slide the whole picture right and
  // down by that overshoot. Every part moves by the same amount, so
  // hand-placed nodes keep their positions relative to each other.
  const shiftX = Math.max(0, -Math.min(...boxes.map((box) => box.x), ...groups.map((g) => g.x)));
  const shiftY = Math.max(0, -Math.min(...boxes.map((box) => box.y), ...groups.map((g) => g.y)));
  const moved = shiftX !== 0 || shiftY !== 0;
  const slide = <T extends { readonly x: number; readonly y: number }>(item: T): T =>
    moved ? { ...item, x: item.x + shiftX, y: item.y + shiftY } : item;
  const nodes = boxes.map(slide);
  const frames = groups.map(slide);
  const routes = moved
    ? edges.map((edge) => ({
        ...edge,
        x1: edge.x1 + shiftX,
        y1: edge.y1 + shiftY,
        x2: edge.x2 + shiftX,
        y2: edge.y2 + shiftY,
        points: edge.points.map((point) => ({ x: point.x + shiftX, y: point.y + shiftY })),
        labelX: edge.labelX + shiftX,
        labelY: edge.labelY + shiftY,
      }))
    : edges;

  const extents = [
    ...routes.flatMap((edge) =>
      edge.points.map((point) => ({ right: point.x + DETOUR_GAP, bottom: point.y + DETOUR_GAP })),
    ),
    ...nodes.map((box) => ({ right: box.x + box.width, bottom: box.y + box.height })),
    ...frames.map((group) => ({ right: group.x + group.width, bottom: group.y + group.height })),
  ];
  return {
    width: Math.max(...extents.map((extent) => extent.right), MARGIN) + MARGIN,
    height: Math.max(...extents.map((extent) => extent.bottom), MARGIN) + MARGIN,
    flow,
    nodes,
    edges: routes,
    groups: frames,
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

/** An icon is drawn at one of the app's icon steps. */
export const CANVAS_DIAGRAM_ICON_SIZE = 16;
const ICON_INSET = 12;
const ICON_GAP = 6;
const TEXT_INSET = 8;
/** Room a 12px-high character takes, so a subtitle is cut where it would leave the box. */
const DETAIL_CHARACTER_WIDTH = 5.8;
/** The label's line sits this far above a two-line node's middle, the subtitle below it. */
const LABEL_RISE = 7;
const DETAIL_DROP = 8;

/** Where a node's icon, label, and subtitle sit inside its box. */
export interface CanvasDiagramNodeContent {
  /** The icon's top-left corner and side; absent when the node draws none. */
  readonly icon?: {
    readonly name: CanvasDiagramNodeIcon;
    readonly x: number;
    readonly y: number;
    readonly size: number;
  };
  /** Where the label is centred. */
  readonly labelX: number;
  readonly labelY: number;
  /** The subtitle cut to fit the box, centred under the label. */
  readonly detail?: { readonly text: string; readonly x: number; readonly y: number };
}

/**
 * Where the parts of a node's contents sit, shared by every drawing of a
 * diagram so the board, the preview, and an export place an icon and a
 * subtitle alike. The icon takes the left of the box and the text centres in
 * what is left. A diamond has no room at its corners for either, so a decision
 * draws its label alone.
 */
export function canvasDiagramNodeContent(node: CanvasDiagramNodeBox): CanvasDiagramNodeContent {
  const roomy = node.shape !== "decision";
  const icon = roomy ? node.icon : undefined;
  const detail = roomy ? node.detail : undefined;
  const left =
    node.x + (icon === undefined ? TEXT_INSET : ICON_INSET + CANVAS_DIAGRAM_ICON_SIZE + ICON_GAP);
  const right = node.x + node.width - TEXT_INSET;
  const x = (left + right) / 2;
  const middle = node.y + node.height / 2;
  const fits = Math.floor((right - left) / DETAIL_CHARACTER_WIDTH);
  const text =
    detail === undefined
      ? undefined
      : detail.length <= fits
        ? detail
        : `${detail.slice(0, Math.max(1, fits - 1)).trimEnd()}…`;
  return {
    ...(icon === undefined
      ? {}
      : {
          icon: {
            name: icon,
            x: node.x + ICON_INSET,
            y: middle - CANVAS_DIAGRAM_ICON_SIZE / 2,
            size: CANVAS_DIAGRAM_ICON_SIZE,
          },
        }),
    labelX: x,
    labelY: text === undefined ? middle : middle - LABEL_RISE,
    ...(text === undefined ? {} : { detail: { text, x, y: middle + DETAIL_DROP } }),
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
