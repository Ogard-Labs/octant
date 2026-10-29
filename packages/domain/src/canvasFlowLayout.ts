import {
  CANVAS_DESIGN_VIEWPORT,
  CANVAS_FLOW_HOTSPOT_COMPONENTS,
  CANVAS_MOCKUP_DEVICE_SIZE,
  type CanvasDiagramTone,
} from "@octant/contracts/canvas";

/**
 * Where a flow's screens sit, worked out from the flow and the screens it
 * names.
 *
 * Layout is a pure reading of the block, so every surface that draws a flow —
 * the thread board, the artifact SVG sidecar, an export — draws the same
 * picture from the same data. The functions read loose shapes so a live
 * definition and a sanitized share document ask the same question.
 */

const FLOW_HOTSPOT_COMPONENTS: ReadonlySet<string> = new Set(CANVAS_FLOW_HOTSPOT_COMPONENTS);

/** Whether a mockup component may start a flow edge: it is a control a person taps. */
export function isCanvasFlowHotspotComponent(component: string): boolean {
  return FLOW_HOTSPOT_COMPONENTS.has(component);
}

interface BlockShape {
  readonly kind: string;
  readonly blockId: string;
}

/** A mockup the flow may place, as a live definition or a share carries it. */
export interface CanvasFlowMockupSource extends BlockShape {
  readonly kind: "mockup";
  readonly title: string;
  readonly device: string;
  readonly size?: { readonly width: number; readonly height: number } | undefined;
  readonly variants?:
    | ReadonlyArray<{ readonly variantId: string; readonly label: string }>
    | undefined;
  readonly nodes: ReadonlyArray<{
    readonly nodeId: string;
    readonly component: string;
    readonly label: string;
  }>;
}

/** A static design the flow may place, as a live definition or a share carries it. */
export interface CanvasFlowDesignSource extends BlockShape {
  readonly kind: "design";
  readonly title: string;
  readonly size: string;
  readonly runsScript?: boolean | undefined;
  readonly frames: ReadonlyArray<{ readonly frameId: string; readonly title: string }>;
}

export type CanvasFlowScreenSourceBlock = CanvasFlowMockupSource | CanvasFlowDesignSource;

/** A dock panel has no height of its own; on a board it draws at a nominal portrait height. */
const DOCK_PANEL_NOMINAL_HEIGHT = 720;

/**
 * How wide a screen is drawn on the board before the board runs out of room.
 * The design board uses the same caps, so a screen reads at the same size
 * wherever it is placed.
 */
const SCREEN_BOARD_WIDTH: Readonly<Record<string, number>> = {
  phone: 200,
  tablet: 260,
  desktop: 440,
  browser: 440,
  slide: 440,
  "dock-panel": 360,
};

/** The widest screen any board draws, whatever the device. */
const MAX_SCREEN_BOARD_WIDTH = 440;

const RANK_GAP_X = 48;
const STACK_GAP_Y = 32;
/** A transition that runs backward drops below the screens it passes. */
const BACK_EDGE_DROP = 48;

/**
 * The intrinsic size of the screen a flow screen names: a mockup's device
 * viewport (or its own frame), or a design frame's declared viewport. The
 * policy refuses every screen this cannot answer for, so a caller that holds
 * a validated definition always finds its block here.
 */
export function canvasFlowScreenIntrinsicSize(block: CanvasFlowScreenSourceBlock): {
  readonly width: number;
  readonly height: number;
} {
  if (block.kind === "mockup") {
    if (block.size !== undefined) return { width: block.size.width, height: block.size.height };
    const device =
      CANVAS_MOCKUP_DEVICE_SIZE[
        block.device as Exclude<keyof typeof CANVAS_MOCKUP_DEVICE_SIZE, "custom">
      ];
    if (device !== undefined) {
      return { width: device.width, height: device.height ?? DOCK_PANEL_NOMINAL_HEIGHT };
    }
    return { width: MAX_SCREEN_BOARD_WIDTH, height: DOCK_PANEL_NOMINAL_HEIGHT };
  }
  const viewport =
    CANVAS_DESIGN_VIEWPORT[block.size as keyof typeof CANVAS_DESIGN_VIEWPORT] ??
    CANVAS_DESIGN_VIEWPORT.desktop;
  return { width: viewport.width, height: viewport.height };
}

/** One screen, placed on the board. */
export interface CanvasFlowScreenBox {
  readonly screenId: string;
  readonly label: string;
  readonly source: "mockup" | "design";
  readonly blockId: string;
  readonly variantId?: string | undefined;
  readonly frameId?: string | undefined;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The drawn screen over its intrinsic size, so a renderer scales the real thing. */
  readonly scale: number;
}

/** One transition, routed between two placed screens. */
export interface CanvasFlowEdgeRoute {
  readonly edgeId: string;
  /** The screens the transition joins, with the labels the board draws. */
  readonly from: { readonly screenId: string; readonly label: string };
  readonly to: { readonly screenId: string; readonly label: string };
  readonly label?: string | undefined;
  readonly tone?: CanvasDiagramTone | undefined;
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  /**
   * The control the person taps, as the author named it: a node of the
   * from-screen's mockup from the interactive list. The renderer draws the
   * link from the control itself, so the reading survives a revision.
   */
  readonly hotspot?:
    | { readonly nodeId: string; readonly component: string; readonly label: string }
    | undefined;
}

export interface CanvasFlowLayout {
  readonly width: number;
  readonly height: number;
  readonly screens: ReadonlyArray<CanvasFlowScreenBox>;
  readonly edges: ReadonlyArray<CanvasFlowEdgeRoute>;
}

/** A flow as a live definition or a sanitized share carries it. */
export interface CanvasFlowShape {
  readonly title: string;
  readonly layout?: "auto" | "manual" | undefined;
  readonly screens: ReadonlyArray<{
    readonly screenId: string;
    readonly blockId: string;
    readonly variantId?: string | undefined;
    readonly frameId?: string | undefined;
    readonly x?: number | undefined;
    readonly y?: number | undefined;
    readonly positioned?: boolean | undefined;
  }>;
  readonly edges: ReadonlyArray<{
    readonly edgeId: string;
    readonly fromScreenId: string;
    readonly toScreenId: string;
    readonly fromNodeId?: string | undefined;
    readonly label?: string | undefined;
    readonly tone?: CanvasDiagramTone | undefined;
  }>;
}

function screenLabel(
  screen: { readonly variantId?: string | undefined; readonly frameId?: string | undefined },
  block: CanvasFlowScreenSourceBlock,
): string {
  if (block.kind === "mockup") {
    const variant =
      screen.variantId === undefined
        ? undefined
        : block.variants?.find(
            (candidate) => String(candidate.variantId) === String(screen.variantId),
          );
    return variant?.label ?? block.title;
  }
  const frame =
    screen.frameId === undefined
      ? undefined
      : block.frames.find((candidate) => String(candidate.frameId) === String(screen.frameId));
  return frame?.title ?? block.title;
}

/**
 * The rank a screen reads at: one column per step of the flow. Screens with
 * no incoming edge start the flow, and a screen sits one step past the first
 * screen that reaches it (a breadth-first walk, so every screen is placed
 * once). A cycle has no rank to settle into, so its screens share one column
 * after the flow's, which draws the loop as the author can untangle by
 * dragging.
 */
function screenRanks(
  screens: ReadonlyArray<{ readonly screenId: string }>,
  edges: ReadonlyArray<{ readonly fromScreenId: string; readonly toScreenId: string }>,
): Map<string, number> {
  const rank = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const screen of screens) incoming.set(String(screen.screenId), 0);
  for (const edge of edges) {
    const id = String(edge.toScreenId);
    incoming.set(id, (incoming.get(id) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const screen of screens) {
    const id = String(screen.screenId);
    if ((incoming.get(id) ?? 0) === 0) {
      rank.set(id, 0);
      queue.push(id);
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const from = queue[index];
    if (from === undefined) break;
    const fromRank = rank.get(from) ?? 0;
    for (const edge of edges) {
      if (String(edge.fromScreenId) !== from) continue;
      const to = String(edge.toScreenId);
      if (rank.has(to)) continue;
      rank.set(to, fromRank + 1);
      queue.push(to);
    }
  }
  let cycleRank = -1;
  for (const settled of rank.values()) cycleRank = Math.max(cycleRank, settled);
  for (const screen of screens) {
    const id = String(screen.screenId);
    if (!rank.has(id)) {
      rank.set(id, cycleRank + 1);
    }
  }
  return rank;
}

/**
 * The flow's one layout. A screen a person has dragged sits where the drag put
 * it; every other screen joins its rank's column, stacked in the order the
 * author wrote. Edges elbow between the screens they join, and one that runs
 * backward steps below them, so the forward flow keeps its left-to-right
 * reading. The result needs no measured value, so the board, the sidecar, and
 * an export draw the same picture.
 */
export function layoutCanvasFlow(
  flow: CanvasFlowShape,
  blocks: ReadonlyArray<CanvasFlowScreenSourceBlock>,
): CanvasFlowLayout {
  const byBlockId = new Map(blocks.map((block) => [String(block.blockId), block]));
  const sources = new Map<string, CanvasFlowScreenSourceBlock>();
  for (const screen of flow.screens) {
    const block = byBlockId.get(String(screen.blockId));
    if (block !== undefined) sources.set(String(screen.screenId), block);
  }

  const ranks = screenRanks(flow.screens, flow.edges);
  const boxes: Array<{
    screenId: string;
    label: string;
    source: "mockup" | "design";
    blockId: string;
    variantId?: string | undefined;
    frameId?: string | undefined;
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
  }> = flow.screens.map((screen) => {
    const block = sources.get(String(screen.screenId));
    const intrinsic =
      block === undefined
        ? { width: MAX_SCREEN_BOARD_WIDTH, height: DOCK_PANEL_NOMINAL_HEIGHT }
        : canvasFlowScreenIntrinsicSize(block);
    const device =
      block?.kind === "mockup" ? block.device : block?.kind === "design" ? block.size : "desktop";
    const cap = SCREEN_BOARD_WIDTH[device] ?? MAX_SCREEN_BOARD_WIDTH;
    const width = Math.min(cap, intrinsic.width);
    const scale = intrinsic.width === 0 ? 1 : width / intrinsic.width;
    const height = intrinsic.height * scale;
    return {
      screenId: String(screen.screenId),
      label: block === undefined ? flow.title : screenLabel(screen, block),
      source: block?.kind === "design" ? "design" : "mockup",
      blockId: String(screen.blockId),
      ...(screen.variantId === undefined ? {} : { variantId: String(screen.variantId) }),
      ...(screen.frameId === undefined ? {} : { frameId: String(screen.frameId) }),
      x: screen.x ?? 0,
      y: screen.y ?? 0,
      width,
      height,
      scale,
    };
  });

  // A dragged screen keeps its journaled place; the rest stack in their rank.
  // The columns are worked out with every screen in them, dragged or not, so
  // nudging one screen leaves its slot behind instead of pulling its
  // neighbours onto it.
  const manual = flow.screens.filter((screen) => screen.positioned === true);
  const manualIds = new Set(manual.map((screen) => String(screen.screenId)));
  const rankColumns = new Map<number, CanvasFlowScreenBox[]>();
  for (const box of boxes) {
    const rank = ranks.get(box.screenId) ?? 0;
    rankColumns.set(rank, [...(rankColumns.get(rank) ?? []), box]);
  }

  let columnX = 0;
  let autoPlaced = 0;
  for (const rank of [...rankColumns.keys()].sort((left, right) => left - right)) {
    const column = rankColumns.get(rank) ?? [];
    if (column.length === 0) continue;
    const columnWidth = Math.max(...column.map((box) => box.width));
    if (autoPlaced > 0) columnX += RANK_GAP_X;
    autoPlaced += 1;
    let y = 0;
    for (const box of column) {
      const target = boxes.find((candidate) => candidate.screenId === box.screenId);
      if (target !== undefined && !manualIds.has(box.screenId)) {
        target.x = columnX;
        target.y = y;
      }
      y += box.height + STACK_GAP_Y;
    }
    columnX += columnWidth;
  }

  let width = 0;
  let height = 0;
  for (const box of boxes) {
    width = Math.max(width, box.x + box.width);
    height = Math.max(height, box.y + box.height);
  }

  const boxById = new Map(boxes.map((box) => [box.screenId, box]));
  const edges = flow.edges.map((edge) => {
    const from = boxById.get(String(edge.fromScreenId));
    const to = boxById.get(String(edge.toScreenId));
    const points: Array<{ x: number; y: number }> = [];
    if (from !== undefined && to !== undefined) {
      const fromRight = from.x + from.width;
      const forward = to.x >= fromRight;
      if (forward) {
        const midX = (fromRight + to.x) / 2;
        points.push(
          { x: fromRight, y: from.y + from.height / 2 },
          { x: midX, y: from.y + from.height / 2 },
          { x: midX, y: to.y + to.height / 2 },
          { x: to.x, y: to.y + to.height / 2 },
        );
      } else {
        const below = Math.max(from.y + from.height, to.y + to.height) + BACK_EDGE_DROP;
        points.push(
          { x: from.x + from.width / 2, y: from.y + from.height },
          { x: from.x + from.width / 2, y: below },
          { x: to.x + to.width / 2, y: below },
          { x: to.x + to.width / 2, y: to.y + to.height },
        );
        height = Math.max(height, below);
      }
    }
    let hotspot: CanvasFlowEdgeRoute["hotspot"];
    if (edge.fromNodeId !== undefined) {
      const source = sources.get(String(edge.fromScreenId));
      const node =
        source?.kind === "mockup"
          ? source.nodes.find((candidate) => String(candidate.nodeId) === String(edge.fromNodeId))
          : undefined;
      if (node !== undefined) {
        hotspot = { nodeId: String(node.nodeId), component: node.component, label: node.label };
      }
    }
    return {
      edgeId: String(edge.edgeId),
      from: {
        screenId: String(edge.fromScreenId),
        label: from?.label ?? flow.title,
      },
      to: {
        screenId: String(edge.toScreenId),
        label: to?.label ?? flow.title,
      },
      ...(edge.label === undefined ? {} : { label: edge.label }),
      ...(edge.tone === undefined ? {} : { tone: edge.tone }),
      points,
      ...(hotspot === undefined ? {} : { hotspot }),
    };
  });

  return { width, height, screens: boxes, edges };
}
