import type { CanvasCommentAnchor } from "@octant/contracts/canvas-board";

/**
 * What the pointer does on a Canvas in the workspace. `select` is the Canvas
 * as it always was; the others take the pointer from the blocks, so a control
 * inside one cannot fire while a person is panning or pointing.
 */
export type CanvasTool = "select" | "hand" | "comment" | "area" | "pen" | "text";

/** The part of a Canvas a person pointed at to comment on. */
export interface CanvasCommentPick {
  readonly blockId: string;
  readonly part?: {
    readonly kind: "row" | "node" | "edge";
    readonly id: string;
  };
}

/**
 * A freeform area of one block, in percent of the block's drawn box from its
 * top-left corner. Percent keeps the area on the same part of a block that
 * scales with the pane, which pixels would not.
 */
export interface CanvasCommentArea {
  readonly blockId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What a person drew on one block and has not commented on yet: a box, a
 * freehand line, or a point a note will be pinned to. Every coordinate is
 * percent of the block's drawn box.
 */
export type CanvasCommentMark =
  | ({ readonly kind: "area" } & CanvasCommentArea)
  | {
      readonly kind: "stroke";
      readonly blockId: string;
      readonly points: ReadonlyArray<CanvasMarkPoint>;
    }
  | ({ readonly kind: "note"; readonly blockId: string } & CanvasMarkPoint);

export interface CanvasMarkPoint {
  readonly x: number;
  readonly y: number;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** The id the comments drawer gives the anchor a pick names. */
export function canvasCommentChoiceId(pick: CanvasCommentPick): string {
  return pick.part === undefined
    ? `block:${pick.blockId}`
    : `${pick.part.kind}:${pick.blockId}:${pick.part.id}`;
}

const BLOCK_SELECTOR = "section.canvas-block[data-block-id]";
const PART_ATTRIBUTES = [
  ["data-node-id", "node"],
  ["data-edge-id", "edge"],
  ["data-row-id", "row"],
] as const;

/**
 * The comment anchor under an element: the nearest node, edge, or row around
 * it that the Canvas takes comments on, otherwise its block, otherwise the
 * block around that one. A treemap cell, a heatmap row, or a mockup part
 * without a callout carries an id the drawer has no anchor for, so `isAnchor`
 * decides: the pick moves out to the next part (a callout pinned to a mockup
 * container is picked from anything inside it) and then to the block, rather
 * than naming an anchor the drawer cannot show.
 */
export function canvasCommentPickAt(
  target: Element,
  isAnchor: (choiceId: string) => boolean,
): { readonly pick: CanvasCommentPick; readonly element: Element } | undefined {
  const section = target.closest(BLOCK_SELECTOR);
  if (section === null) return undefined;
  const blockId = section.getAttribute("data-block-id") ?? "";
  for (const [attribute, kind] of PART_ATTRIBUTES) {
    let element = target.closest(`[${attribute}]`);
    while (element !== null && element !== section && section.contains(element)) {
      const pick = { blockId, part: { kind, id: element.getAttribute(attribute) ?? "" } };
      if (isAnchor(canvasCommentChoiceId(pick))) return { pick, element };
      element = element.parentElement?.closest(`[${attribute}]`) ?? null;
    }
  }
  if (isAnchor(canvasCommentChoiceId({ blockId }))) return { pick: { blockId }, element: section };
  const outer = section.parentElement;
  return outer === null ? undefined : canvasCommentPickAt(outer, isAnchor);
}

/** A drag shorter than this on either side is a click, not an area. */
const AREA_MIN_PIXELS = 8;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const tenth = (value: number) => Math.round(value * 10) / 10;

/**
 * The area a drag marked on a block, kept inside the block's box. Undefined
 * for a drag too small to mean an area, so a stray click leaves no comment.
 */
export function canvasAreaOfDrag(
  block: Box,
  from: Point,
  to: Point,
): Omit<CanvasCommentArea, "blockId"> | undefined {
  if (block.width <= 0 || block.height <= 0) return undefined;
  const left = clamp(Math.min(from.x, to.x), block.left, block.left + block.width);
  const right = clamp(Math.max(from.x, to.x), block.left, block.left + block.width);
  const top = clamp(Math.min(from.y, to.y), block.top, block.top + block.height);
  const bottom = clamp(Math.max(from.y, to.y), block.top, block.top + block.height);
  if (right - left < AREA_MIN_PIXELS || bottom - top < AREA_MIN_PIXELS) return undefined;
  return {
    x: tenth(((left - block.left) / block.width) * 100),
    y: tenth(((top - block.top) / block.height) * 100),
    width: tenth(((right - left) / block.width) * 100),
    height: tenth(((bottom - top) / block.height) * 100),
  };
}

/** Where a click landed on a block, in percent of its box and kept inside it. */
export function canvasPointInBlock(block: Box, at: Point): CanvasMarkPoint | undefined {
  if (block.width <= 0 || block.height <= 0) return undefined;
  return {
    x: tenth(
      ((clamp(at.x, block.left, block.left + block.width) - block.left) / block.width) * 100,
    ),
    y: tenth(((clamp(at.y, block.top, block.top + block.height) - block.top) / block.height) * 100),
  };
}

/**
 * The line a drag drew on a block: kept inside the block's box, without the
 * repeats a slow pointer leaves, and thinned evenly to `maxPoints` with both
 * ends kept, so a long scribble still fits the comment contract. Undefined
 * for a drag that never left an 8px square, which is a click.
 */
export function canvasStrokeOfDrag(
  block: Box,
  path: ReadonlyArray<Point>,
  maxPoints: number,
): ReadonlyArray<CanvasMarkPoint> | undefined {
  const first = path[0];
  if (first === undefined || path.length < 2) return undefined;
  // Folded rather than spread into Math.max: a long scribble is more points
  // than a call takes arguments.
  let [left, right, top, bottom] = [first.x, first.x, first.y, first.y];
  for (const at of path) {
    left = Math.min(left, at.x);
    right = Math.max(right, at.x);
    top = Math.min(top, at.y);
    bottom = Math.max(bottom, at.y);
  }
  if (Math.max(right - left, bottom - top) < AREA_MIN_PIXELS) return undefined;
  const points: CanvasMarkPoint[] = [];
  for (const at of path) {
    const point = canvasPointInBlock(block, at);
    if (point === undefined) return undefined;
    const last = points.at(-1);
    if (last?.x !== point.x || last.y !== point.y) points.push(point);
  }
  if (points.length < 2) return undefined;
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => points[Math.round(index * step)]).filter(
    (point): point is CanvasMarkPoint => point !== undefined,
  );
}

/** The box a stroke stays inside, which is how an agent is told where it is. */
export function canvasStrokeBounds(
  points: ReadonlyArray<CanvasMarkPoint>,
): Omit<CanvasCommentArea, "blockId"> {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: tenth(Math.max(...xs) - x), height: tenth(Math.max(...ys) - y) };
}

/**
 * The mark a comment's anchor draws on its block, if it is a drawn one. A
 * region of no size is a point, which is how a note is stored.
 */
export function canvasMarkOfAnchor(anchor: CanvasCommentAnchor): CanvasCommentMark | undefined {
  const blockId = String(anchor.blockId);
  if (anchor.kind === "stroke") return { kind: "stroke", blockId, points: anchor.points };
  if (anchor.kind !== "region") return undefined;
  return anchor.width === 0 && anchor.height === 0
    ? { kind: "note", blockId, x: anchor.x, y: anchor.y }
    : {
        kind: "area",
        blockId,
        x: anchor.x,
        y: anchor.y,
        width: anchor.width,
        height: anchor.height,
      };
}

/** The anchor a comment on a mark is sent with, before the contract decodes it. */
export function canvasAnchorInputOfMark(mark: CanvasCommentMark, id: string): unknown {
  if (mark.kind === "stroke") {
    return { kind: "stroke", blockId: mark.blockId, strokeId: id, points: mark.points };
  }
  return {
    kind: "region",
    blockId: mark.blockId,
    regionId: id,
    x: mark.x,
    y: mark.y,
    width: mark.kind === "area" ? mark.width : 0,
    height: mark.kind === "area" ? mark.height : 0,
  };
}

/** How the drawer names a mark: by what it is and the block it is on. */
export function canvasMarkLabel(kind: CanvasCommentMark["kind"], blockLabel: string): string {
  const name = kind === "area" ? "Area" : kind === "stroke" ? "Pen mark" : "Note";
  return `${name} · ${blockLabel}`;
}
