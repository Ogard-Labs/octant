/**
 * What the pointer does on a Canvas in the workspace. `select` is the Canvas
 * as it always was; the others take the pointer from the blocks, so a control
 * inside one cannot fire while a person is panning or pointing.
 */
export type CanvasTool = "select" | "hand" | "comment" | "area";

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
