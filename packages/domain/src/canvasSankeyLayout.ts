import type { CanvasChartLink } from "@octant/contracts/canvas";

/**
 * Where a sankey's nodes and bands sit, worked out from its flows alone.
 *
 * Nodes are named by the flows, listed in the order they first appear. A node
 * with nothing flowing in starts at the left; every other node sits one column
 * right of the furthest node that feeds it, and a node nothing leaves is pushed
 * to the last column so every ending lines up. A node is as tall as the larger
 * of what enters and what leaves it, and one scale serves every column so a
 * band keeps its width from end to end. The layout is deterministic and reads
 * no state, so the screen renderer and the static SVG export draw the same
 * picture. Flows that would loop are refused by the domain policy before they
 * reach here; a loop that does arrive is laid out in a final column rather than
 * spinning.
 */

export interface CanvasSankeyNodeLayout {
  readonly label: string;
  /** The node's position in first-appearance order, which picks its hue. */
  readonly index: number;
  readonly column: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly inflow: number;
  readonly outflow: number;
}

export interface CanvasSankeyLinkLayout {
  readonly source: string;
  readonly target: string;
  readonly value: number;
  /** The link's position in the block as declared. */
  readonly index: number;
  /** The source node's index, so a band takes the hue of where it came from. */
  readonly sourceIndex: number;
  /** A closed band from the source's right edge to the target's left edge. */
  readonly path: string;
  /** Where the band's centre leaves the source and enters the target. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly thickness: number;
}

export interface CanvasSankeyLayout {
  readonly nodes: ReadonlyArray<CanvasSankeyNodeLayout>;
  readonly links: ReadonlyArray<CanvasSankeyLinkLayout>;
  readonly columns: number;
}

export interface CanvasSankeyLayoutOptions {
  readonly width: number;
  readonly height: number;
  readonly nodeWidth?: number;
  /** The gap between two nodes stacked in one column. */
  readonly nodeGap?: number;
}

const DEFAULT_NODE_WIDTH = 10;
const DEFAULT_NODE_GAP = 10;

/** The nodes a set of flows names, in the order they first appear. */
export function sankeyNodeLabels(
  links: ReadonlyArray<Pick<CanvasChartLink, "source" | "target">>,
): ReadonlyArray<string> {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    for (const label of [link.source, link.target]) {
      if (seen.has(label)) continue;
      seen.add(label);
      labels.push(label);
    }
  }
  return labels;
}

export function layoutCanvasSankey(
  links: ReadonlyArray<CanvasChartLink>,
  options: CanvasSankeyLayoutOptions,
): CanvasSankeyLayout {
  const nodeWidth = options.nodeWidth ?? DEFAULT_NODE_WIDTH;
  const nodeGap = options.nodeGap ?? DEFAULT_NODE_GAP;
  const labels = sankeyNodeLabels(links);
  const indexOf = new Map(labels.map((label, index) => [label, index]));
  const inflow = labels.map(() => 0);
  const outflow = labels.map(() => 0);
  const incoming = labels.map((): number[] => []);
  const outgoing = labels.map((): number[] => []);
  links.forEach((link, linkIndex) => {
    const source = indexOf.get(link.source) ?? 0;
    const target = indexOf.get(link.target) ?? 0;
    const value = Math.max(0, link.value);
    outflow[source] = (outflow[source] ?? 0) + value;
    inflow[target] = (inflow[target] ?? 0) + value;
    outgoing[source]?.push(linkIndex);
    incoming[target]?.push(linkIndex);
  });

  const column = columnsByLongestPath(links, labels, indexOf, incoming);
  const lastColumn = Math.max(0, ...column);
  // An ending lines up at the right, so a reader compares outcomes in one place.
  labels.forEach((_label, index) => {
    if ((outgoing[index]?.length ?? 0) === 0 && (incoming[index]?.length ?? 0) > 0) {
      column[index] = lastColumn;
    }
  });
  const columns = lastColumn + 1;

  const byColumn = Array.from({ length: columns }, (): number[] => []);
  labels.forEach((_label, index) => byColumn[column[index] ?? 0]?.push(index));
  const size = labels.map((_label, index) => Math.max(inflow[index] ?? 0, outflow[index] ?? 0));
  // One scale for every column: the fullest column fills the height, and a
  // band's width means the same quantity wherever it is drawn.
  const scale = Math.min(
    ...byColumn.map((members) => {
      const total = members.reduce((sum, index) => sum + (size[index] ?? 0), 0);
      const room = options.height - nodeGap * Math.max(0, members.length - 1);
      return total > 0 ? Math.max(0, room) / total : Number.POSITIVE_INFINITY;
    }),
  );
  const unit = Number.isFinite(scale) ? scale : 0;
  const span = Math.max(0, options.width - nodeWidth);
  const nodes: CanvasSankeyNodeLayout[] = labels.map((label, index) => ({
    label,
    index,
    column: column[index] ?? 0,
    x: columns <= 1 ? 0 : ((column[index] ?? 0) / (columns - 1)) * span,
    y: 0,
    width: nodeWidth,
    height: Math.max(1, (size[index] ?? 0) * unit),
    inflow: inflow[index] ?? 0,
    outflow: outflow[index] ?? 0,
  }));
  // Each column is centred in the height, members in first-appearance order.
  for (const members of byColumn) {
    const used =
      members.reduce((sum, index) => sum + (nodes[index]?.height ?? 0), 0) +
      nodeGap * Math.max(0, members.length - 1);
    let cursor = Math.max(0, (options.height - used) / 2);
    for (const index of members) {
      const node = nodes[index];
      if (node === undefined) continue;
      nodes[index] = { ...node, y: cursor };
      cursor += node.height + nodeGap;
    }
  }

  // Bands leave a node in the order of their targets, top to bottom, and enter
  // one in the order of their sources, so bands do not cross at a node.
  const sourceOffset = new Map<number, number>();
  const targetOffset = new Map<number, number>();
  labels.forEach((_label, index) => {
    const node = nodes[index];
    if (node === undefined) return;
    let out = node.y;
    for (const linkIndex of [...(outgoing[index] ?? [])].sort(
      (a, b) => centreOf(nodes, links, a, "target") - centreOf(nodes, links, b, "target") || a - b,
    )) {
      sourceOffset.set(linkIndex, out);
      out += Math.max(0, links[linkIndex]?.value ?? 0) * unit;
    }
    let into = node.y;
    for (const linkIndex of [...(incoming[index] ?? [])].sort(
      (a, b) => centreOf(nodes, links, a, "source") - centreOf(nodes, links, b, "source") || a - b,
    )) {
      targetOffset.set(linkIndex, into);
      into += Math.max(0, links[linkIndex]?.value ?? 0) * unit;
    }
  });

  const laid: CanvasSankeyLinkLayout[] = links.map((link, index) => {
    const sourceIndex = indexOf.get(link.source) ?? 0;
    const source = nodes[sourceIndex];
    const target = nodes[indexOf.get(link.target) ?? 0];
    const thickness = Math.max(0, link.value) * unit;
    const x0 = (source?.x ?? 0) + nodeWidth;
    const x1 = target?.x ?? 0;
    const top0 = sourceOffset.get(index) ?? 0;
    const top1 = targetOffset.get(index) ?? 0;
    return {
      source: link.source,
      target: link.target,
      value: link.value,
      index,
      sourceIndex,
      path: bandPath(x0, top0, x1, top1, Math.max(1, thickness)),
      x0,
      y0: top0 + thickness / 2,
      x1,
      y1: top1 + thickness / 2,
      thickness,
    };
  });

  return { nodes, links: laid, columns };
}

/**
 * Each node's column: one right of the furthest node that feeds it, by a
 * topological walk. A node left over once the walk stalls sits in a cycle,
 * which the policy refuses; it takes the column after the last one reached.
 */
function columnsByLongestPath(
  links: ReadonlyArray<CanvasChartLink>,
  labels: ReadonlyArray<string>,
  indexOf: ReadonlyMap<string, number>,
  incoming: ReadonlyArray<ReadonlyArray<number>>,
): number[] {
  const column = labels.map(() => 0);
  const pending = labels.map((_label, index) => incoming[index]?.length ?? 0);
  const queue = labels.map((_label, index) => index).filter((index) => pending[index] === 0);
  const placed = new Set<number>();
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    if (node === undefined) continue;
    placed.add(node);
    for (const link of links) {
      if (indexOf.get(link.source) !== node) continue;
      const target = indexOf.get(link.target) ?? 0;
      column[target] = Math.max(column[target] ?? 0, (column[node] ?? 0) + 1);
      pending[target] = (pending[target] ?? 0) - 1;
      if (pending[target] === 0) queue.push(target);
    }
  }
  const reached = Math.max(0, ...column);
  labels.forEach((_label, index) => {
    if (!placed.has(index)) column[index] = reached + 1;
  });
  return column;
}

function centreOf(
  nodes: ReadonlyArray<CanvasSankeyNodeLayout>,
  links: ReadonlyArray<CanvasChartLink>,
  linkIndex: number,
  end: "source" | "target",
): number {
  const link = links[linkIndex];
  if (link === undefined) return 0;
  const label = end === "source" ? link.source : link.target;
  const node = nodes.find((candidate) => candidate.label === label);
  return node === undefined ? 0 : node.y + node.height / 2;
}

function bandPath(x0: number, top0: number, x1: number, top1: number, thickness: number): string {
  const mid = (x0 + x1) / 2;
  const r = (value: number) => String(Math.round(value * 100) / 100);
  return [
    `M ${r(x0)} ${r(top0)}`,
    `C ${r(mid)} ${r(top0)} ${r(mid)} ${r(top1)} ${r(x1)} ${r(top1)}`,
    `L ${r(x1)} ${r(top1 + thickness)}`,
    `C ${r(mid)} ${r(top1 + thickness)} ${r(mid)} ${r(top0 + thickness)} ${r(x0)} ${r(top0 + thickness)}`,
    "Z",
  ].join(" ");
}
