import type { CanvasTreemapBlock, CanvasTreemapNode } from "@octant/contracts/canvas";

/**
 * Where a treemap's rectangles sit, worked out from the block alone.
 *
 * Squarified treemap (Bruls, Huizing, van Wijk): rectangles are packed so each
 * keeps an aspect ratio near one, which is what makes area readable. The
 * ordering is deterministic — children are sorted by their size for the
 * chosen measure, then by node id — so the same input always gives the same
 * rectangles on every surface. Nothing here reads state or decides what the
 * numbers mean; a caller passes the measure and (optionally) the node to start
 * from, which is what a zoom or a static export changes.
 */

export interface CanvasTreemapRect {
  readonly nodeId: string;
  readonly label: string;
  readonly parentId: string | undefined;
  readonly sourceId: string | undefined;
  readonly depth: number;
  readonly isGroup: boolean;
  /** Whether a group reserved a header band above its children. */
  readonly showsHeader: boolean;
  /** The node's reading for the layout measure: a leaf's value, a group's sum. */
  readonly value: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasTreemapLayout {
  readonly width: number;
  readonly height: number;
  readonly rootId: string;
  /** Pre-order: a group appears before the nodes it holds. */
  readonly nodes: ReadonlyArray<CanvasTreemapRect>;
}

export interface CanvasTreemapLayoutOptions {
  readonly width: number;
  readonly height: number;
  /** Which measure sizes the rectangles; defaults to the block's `sizeBy`. */
  readonly measureId?: string;
  /** Which node to lay out from; defaults to the block's `startNodeId`, else the root. */
  readonly rootId?: string;
}

/** The band a group reserves at its top for its header label. */
export const TREEMAP_GROUP_HEADER = 16;

interface TreemapIndex {
  readonly nodeOf: ReadonlyMap<string, CanvasTreemapNode>;
  readonly parentOf: ReadonlyMap<string, string | undefined>;
  readonly childrenOf: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly rootId: string;
}

function indexTreemap(block: CanvasTreemapBlock): TreemapIndex {
  const nodeOf = new Map<string, CanvasTreemapNode>();
  const parentOf = new Map<string, string | undefined>();
  const children = new Map<string, string[]>();
  let rootId = "";
  for (const node of block.nodes) {
    const id = String(node.nodeId);
    nodeOf.set(id, node);
    const parentId = node.parentId === undefined ? undefined : String(node.parentId);
    parentOf.set(id, parentId);
    if (parentId === undefined && rootId === "") rootId = id;
    if (parentId === undefined) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(id);
    children.set(parentId, siblings);
  }
  return { nodeOf, parentOf, childrenOf: children, rootId };
}

/** A leaf's reading for one measure, read by name so no branded index is minted. */
function leafReading(node: CanvasTreemapNode | undefined, measure: string): number {
  const values = node?.values;
  if (values === undefined) return 0;
  for (const [key, value] of Object.entries(values)) {
    if (key === measure) return value;
  }
  return 0;
}

/** A group's reading for one measure: the sum of the leaves beneath it. */
function totalsFor(index: TreemapIndex, measure: string): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  const visiting = new Set<string>();
  const total = (nodeId: string): number => {
    const cached = totals.get(nodeId);
    if (cached !== undefined) return cached;
    if (visiting.has(nodeId)) return 0;
    visiting.add(nodeId);
    const kids = index.childrenOf.get(nodeId) ?? [];
    const value =
      kids.length === 0
        ? leafReading(index.nodeOf.get(nodeId), measure)
        : kids.reduce((sum, child) => sum + total(child), 0);
    visiting.delete(nodeId);
    totals.set(nodeId, value);
    return value;
  };
  for (const nodeId of index.nodeOf.keys()) total(nodeId);
  return totals;
}

interface SizedItem {
  readonly nodeId: string;
  readonly value: number;
}

interface SizedBox {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Worst aspect ratio of a row of rectangles laid along `length`. */
function worstRatio(row: ReadonlyArray<number>, length: number): number {
  if (row.length === 0 || length <= 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const value of row) {
    sum += value;
    if (value > max) max = value;
    if (value < min) min = value;
  }
  if (sum <= 0 || min <= 0) return Number.POSITIVE_INFINITY;
  const side = length * length;
  const squared = sum * sum;
  return Math.max((side * max) / squared, squared / (side * min));
}

/**
 * Squarify `items` into the rectangle at `(x, y)` sized `width` by `height`.
 * Items keep their given order; the caller sorts first, so the result is
 * deterministic.
 */
function squarify(
  items: ReadonlyArray<SizedItem>,
  x: number,
  y: number,
  width: number,
  height: number,
): ReadonlyArray<SizedBox> {
  const placed: SizedBox[] = [];
  if (items.length === 0) return placed;
  if (width <= 0 || height <= 0) return placed;

  // A rectangle with no total still lays out: every cell takes an equal share,
  // so an empty reading is a picture rather than a blank.
  const positiveTotal = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  const weights =
    positiveTotal > 0 ? items.map((item) => Math.max(0, item.value)) : items.map(() => 1);
  let remaining = weights.map((value, index) => {
    const item = items[index];
    return { value, nodeId: item?.nodeId ?? "" };
  });

  let rx = x;
  let ry = y;
  let rw = width;
  let rh = height;

  while (remaining.length > 0) {
    const remainingTotal = remaining.reduce((sum, item) => sum + item.value, 0);
    if (remainingTotal <= 0) break;
    const short = Math.min(rw, rh);
    const scale = (rw * rh) / remainingTotal;

    const row: Array<{ value: number; nodeId: string }> = [];
    let rowSum = 0;
    for (const item of remaining) {
      const trial = [...row, item];
      const trialWorst = worstRatio(
        trial.map((entry) => entry.value * scale),
        short,
      );
      if (
        row.length > 0 &&
        trialWorst >
          worstRatio(
            row.map((entry) => entry.value * scale),
            short,
          )
      ) {
        break;
      }
      row.push(item);
      rowSum += item.value;
    }

    if (row.length === 0) {
      // Degenerate weights: take one item so the loop always progresses.
      const first = remaining[0];
      if (first === undefined) break;
      row.push(first);
      rowSum += first.value;
    }

    const rowArea = rowSum * scale;
    if (rw >= rh) {
      const rowWidth = rowArea / rh;
      let oy = ry;
      for (const entry of row) {
        const itemHeight = (entry.value * scale) / rowWidth;
        placed.push({ nodeId: entry.nodeId, x: rx, y: oy, width: rowWidth, height: itemHeight });
        oy += itemHeight;
      }
      rx += rowWidth;
      rw -= rowWidth;
    } else {
      const rowHeight = rowArea / rw;
      let ox = rx;
      for (const entry of row) {
        const itemWidth = (entry.value * scale) / rowHeight;
        placed.push({ nodeId: entry.nodeId, x: ox, y: ry, width: itemWidth, height: rowHeight });
        ox += itemWidth;
      }
      ry += rowHeight;
      rh -= rowHeight;
    }
    const placedIds = new Set(row.map((entry) => entry.nodeId));
    remaining = remaining.filter((entry) => !placedIds.has(entry.nodeId));
    if (rw <= 0 || rh <= 0) break;
  }
  return placed;
}

export function layoutCanvasTreemap(
  block: CanvasTreemapBlock,
  options: CanvasTreemapLayoutOptions,
): CanvasTreemapLayout {
  const index = indexTreemap(block);
  const measure = options.measureId ?? String(block.sizeBy);
  const requested =
    options.rootId ?? (block.startNodeId === undefined ? undefined : String(block.startNodeId));
  const rootId = requested !== undefined && index.nodeOf.has(requested) ? requested : index.rootId;
  const totals = totalsFor(index, measure);

  const nodes: CanvasTreemapRect[] = [];
  const describe = (
    nodeId: string,
    depth: number,
    box: { x: number; y: number; width: number; height: number },
  ): void => {
    const node = index.nodeOf.get(nodeId);
    const kids = index.childrenOf.get(nodeId) ?? [];
    // A group only reserves a header band when it has room for one above its
    // children; a sliver of a group otherwise loses almost all its area to a
    // label it could not read.
    const showsHeader =
      depth !== 0 && kids.length > 0 && box.height >= TREEMAP_GROUP_HEADER * 2 + 8;
    nodes.push({
      nodeId,
      label: node?.label ?? nodeId,
      parentId: depth === 0 ? undefined : index.parentOf.get(nodeId),
      sourceId: node?.sourceId === undefined ? undefined : String(node.sourceId),
      depth,
      isGroup: kids.length > 0,
      showsHeader,
      value: totals.get(nodeId) ?? 0,
      ...box,
    });
    if (kids.length === 0) return;
    const header = showsHeader ? TREEMAP_GROUP_HEADER : 0;
    const innerHeight = Math.max(1, box.height - header);
    const ordered = kids
      .map((childId) => ({ nodeId: childId, value: totals.get(childId) ?? 0 }))
      .sort(
        (left, right) =>
          right.value - left.value ||
          (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0),
      );
    const children = squarify(ordered, box.x, box.y + header, box.width, innerHeight);
    for (const child of children) describe(child.nodeId, depth + 1, child);
  };

  if (rootId !== "") {
    describe(rootId, 0, { x: 0, y: 0, width: options.width, height: options.height });
  }

  return { width: options.width, height: options.height, rootId, nodes };
}

/** The label path from the root to a node, for a tooltip's full path. */
export function treemapPath(block: CanvasTreemapBlock, nodeId: string): ReadonlyArray<string> {
  const index = indexTreemap(block);
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = nodeId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const node = index.nodeOf.get(current);
    if (node === undefined) break;
    path.unshift(node.label);
    current = index.parentOf.get(current);
  }
  return path;
}

export interface CanvasTreemapDomain {
  readonly min: number;
  readonly max: number;
}

/**
 * The range a measure spans across the leaves, for scaling a colour.
 *
 * A measure with no leaves or a single reading gets a span that does not
 * collapse to a point, so a scale still has a domain to divide.
 */
export function treemapMeasureDomain(
  block: CanvasTreemapBlock,
  measureId: string,
): CanvasTreemapDomain {
  const index = indexTreemap(block);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const [nodeId, node] of index.nodeOf) {
    if ((index.childrenOf.get(nodeId)?.length ?? 0) > 0) continue;
    const value = leafReading(node, measureId);
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: Math.min(0, min), max: max + 1 };
  return { min, max };
}

export function treemapRootId(block: CanvasTreemapBlock): string {
  return indexTreemap(block).rootId;
}

/** Direct children of every node, in declared order. */
export function treemapChildren(
  block: CanvasTreemapBlock,
): ReadonlyMap<string, ReadonlyArray<string>> {
  return indexTreemap(block).childrenOf;
}

/** The reading of every node for a measure: a leaf's value, a group's sum. */
export function treemapTotals(
  block: CanvasTreemapBlock,
  measureId: string,
): ReadonlyMap<string, number> {
  return totalsFor(indexTreemap(block), measureId);
}

/** The parent of every node; the root's parent is `undefined`. */
export function treemapParentOf(
  block: CanvasTreemapBlock,
): ReadonlyMap<string, string | undefined> {
  return indexTreemap(block).parentOf;
}

/** A leaf's own reading for a measure, without summing ancestors. */
export function treemapLeafReading(
  block: CanvasTreemapBlock,
  nodeId: string,
  measureId: string,
): number {
  const index = indexTreemap(block);
  return leafReading(index.nodeOf.get(nodeId), measureId);
}

export function treemapMaxDepth(block: CanvasTreemapBlock): number {
  const index = indexTreemap(block);
  let deepest = 0;
  const depthOf = (nodeId: string, seen: ReadonlySet<string>): number => {
    if (seen.has(nodeId)) return 0;
    const next = new Set(seen);
    next.add(nodeId);
    const kids = index.childrenOf.get(nodeId) ?? [];
    if (kids.length === 0) return 1;
    return 1 + Math.max(...kids.map((child) => depthOf(child, next)));
  };
  for (const nodeId of index.nodeOf.keys()) deepest = Math.max(deepest, depthOf(nodeId, new Set()));
  return deepest;
}
