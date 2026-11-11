/**
 * Sizes for the dock's graph. The dock is a narrow column and an agent
 * commonly hands off three or four pieces at once, so a card gives up width to
 * keep a row on screen, down to the least that still reads as a task and a
 * state. Past that the row scrolls sideways rather than cutting a task to a
 * word.
 */
export const AGENT_RUN_LAYER_CARD_WIDTH = 172;
export const AGENT_RUN_LAYER_MIN_CARD_WIDTH = 116;
/** A two-line task, the model, the effort and role, and the state, without clipping. */
export const AGENT_RUN_LAYER_CARD_HEIGHT = 128;
export const AGENT_RUN_LAYER_HORIZONTAL_GAP = 12;
export const AGENT_RUN_LAYER_VERTICAL_GAP = 36;
/** Room for a selected card's outline, which would otherwise be clipped. */
export const AGENT_RUN_LAYER_MARGIN = 4;

export interface AgentRunLayerNode {
  readonly id: string;
  /** The runs this one waits for. */
  readonly after: ReadonlyArray<string>;
  /** The run that started this one, when it is not the thread's own agent. */
  readonly startedBy?: string;
}

export interface AgentRunLayerBox {
  readonly id: string;
  /** Row from the top: 0 for a run that waits for nothing listed. */
  readonly layer: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AgentRunLayerEdge {
  readonly fromId: string;
  readonly toId: string;
  /** `after`: the later run waits for the earlier. `started`: the earlier run launched the later. */
  readonly kind: "after" | "started";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface AgentRunLayerLayout {
  readonly width: number;
  readonly height: number;
  readonly boxes: ReadonlyArray<AgentRunLayerBox>;
  readonly edges: ReadonlyArray<AgentRunLayerEdge>;
}

/**
 * Place one thread's runs in rows: a run sits one row below the lowest run it
 * waits for or was started by, so every arrow points down.
 *
 * The first row keeps the order given, which the caller makes the order the
 * runs were requested in. Each later row is sorted by where the runs above it
 * sit, which keeps most arrows from crossing without a full crossing search:
 * a thread holds a handful of runs.
 *
 * A link to a run that is not listed is dropped, and a loop (which the host
 * cannot journal, but a reader must not hang on) is cut where it closes.
 *
 * `availableWidth` is the room the graph has; without it (before the first
 * measurement) cards take their full width.
 */
export function layoutAgentRunLayers(
  nodes: ReadonlyArray<AgentRunLayerNode>,
  options: { readonly availableWidth?: number } = {},
): AgentRunLayerLayout {
  if (nodes.length === 0) return { width: 0, height: 0, boxes: [], edges: [] };

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links = new Map<string, ReadonlyArray<{ readonly from: string; readonly kind: Kind }>>();
  for (const node of nodes) links.set(node.id, linksInto(node, byId));

  const layerOf = new Map<string, number>();
  const open = new Set<string>();
  const resolveLayer = (id: string): number => {
    const known = layerOf.get(id);
    if (known !== undefined) return known;
    // Reached again while still being placed: the links loop. Treat this end
    // as the top so the walk ends.
    if (open.has(id)) return -1;
    open.add(id);
    let layer = 0;
    for (const link of links.get(id) ?? []) layer = Math.max(layer, resolveLayer(link.from) + 1);
    open.delete(id);
    layerOf.set(id, layer);
    return layer;
  };
  for (const node of nodes) resolveLayer(node.id);

  const rows: string[][] = [];
  for (const node of nodes) {
    const layer = layerOf.get(node.id) ?? 0;
    (rows[layer] ??= []).push(node.id);
  }

  const mostInARow = Math.max(...rows.map((row) => row?.length ?? 0));
  const cardWidth = cardWidthFor(mostInARow, options.availableWidth);
  const rowWidth = (count: number): number =>
    count === 0 ? 0 : count * cardWidth + (count - 1) * AGENT_RUN_LAYER_HORIZONTAL_GAP;
  const widest = rowWidth(mostInARow);
  const placed = new Map<string, AgentRunLayerBox>();
  for (const [layer, row] of rows.entries()) {
    if (row === undefined) continue;
    const ordered = layer === 0 ? row : sortUnderWhatItFollows(row, links, placed);
    const left = AGENT_RUN_LAYER_MARGIN + Math.round((widest - rowWidth(ordered.length)) / 2);
    const y =
      AGENT_RUN_LAYER_MARGIN + layer * (AGENT_RUN_LAYER_CARD_HEIGHT + AGENT_RUN_LAYER_VERTICAL_GAP);
    for (const [index, id] of ordered.entries()) {
      placed.set(id, {
        id,
        layer,
        x: left + index * (cardWidth + AGENT_RUN_LAYER_HORIZONTAL_GAP),
        y,
        width: cardWidth,
        height: AGENT_RUN_LAYER_CARD_HEIGHT,
      });
    }
  }

  const boxes: AgentRunLayerBox[] = [];
  const edges: AgentRunLayerEdge[] = [];
  for (const node of nodes) {
    const box = placed.get(node.id);
    if (box === undefined) continue;
    boxes.push(box);
    for (const link of links.get(node.id) ?? []) {
      const from = placed.get(link.from);
      // A link cut from a loop would point up or sideways; leave it out.
      if (from === undefined || from.layer >= box.layer) continue;
      edges.push({
        fromId: from.id,
        toId: box.id,
        kind: link.kind,
        x1: from.x + from.width / 2,
        y1: from.y + from.height,
        x2: box.x + box.width / 2,
        y2: box.y,
      });
    }
  }

  return {
    width: widest + AGENT_RUN_LAYER_MARGIN * 2,
    height:
      rows.length * AGENT_RUN_LAYER_CARD_HEIGHT +
      (rows.length - 1) * AGENT_RUN_LAYER_VERTICAL_GAP +
      AGENT_RUN_LAYER_MARGIN * 2,
    boxes,
    edges,
  };
}

type Kind = AgentRunLayerEdge["kind"];

function linksInto(
  node: AgentRunLayerNode,
  byId: ReadonlyMap<string, AgentRunLayerNode>,
): ReadonlyArray<{ readonly from: string; readonly kind: Kind }> {
  const seen = new Set<string>([node.id]);
  const result: { from: string; kind: Kind }[] = [];
  for (const from of node.after) {
    if (seen.has(from) || !byId.has(from)) continue;
    seen.add(from);
    result.push({ from, kind: "after" });
  }
  const starter = node.startedBy;
  if (starter !== undefined && !seen.has(starter) && byId.has(starter)) {
    result.push({ from: starter, kind: "started" });
  }
  return result;
}

function cardWidthFor(mostInARow: number, availableWidth: number | undefined): number {
  if (availableWidth === undefined || mostInARow === 0) return AGENT_RUN_LAYER_CARD_WIDTH;
  const forCards =
    availableWidth - AGENT_RUN_LAYER_MARGIN * 2 - (mostInARow - 1) * AGENT_RUN_LAYER_HORIZONTAL_GAP;
  return Math.min(
    AGENT_RUN_LAYER_CARD_WIDTH,
    Math.max(AGENT_RUN_LAYER_MIN_CARD_WIDTH, Math.floor(forCards / mostInARow)),
  );
}

function sortUnderWhatItFollows(
  row: ReadonlyArray<string>,
  links: ReadonlyMap<string, ReadonlyArray<{ readonly from: string }>>,
  placed: ReadonlyMap<string, AgentRunLayerBox>,
): ReadonlyArray<string> {
  const centre = (id: string): number => {
    const above = (links.get(id) ?? []).flatMap((link) => {
      const box = placed.get(link.from);
      return box === undefined ? [] : [box.x + box.width / 2];
    });
    if (above.length === 0) return Number.POSITIVE_INFINITY;
    return above.reduce((sum, x) => sum + x, 0) / above.length;
  };
  return row
    .map((id, index) => ({ id, index, centre: centre(id) }))
    .sort((a, b) => (a.centre === b.centre ? a.index - b.index : a.centre - b.centre))
    .map((entry) => entry.id);
}
