import { markupInk } from "../theme/markupInk";
import type { Mark, MarkupPoint } from "./markupModel";

/**
 * What a mark draws, as plain shapes in picture pixels. The drawing layer turns
 * these into SVG and the export paints them on a canvas, so what the person
 * sees while drawing is what is attached: there is one description of each mark.
 */
export type MarkShape =
  | {
      readonly kind: "line";
      readonly points: ReadonlyArray<MarkupPoint>;
      readonly stroke: string;
      readonly width: number;
    }
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly stroke: string;
      readonly width: number;
    }
  | {
      readonly kind: "text";
      /** Left edge and alphabetic baseline. */
      readonly x: number;
      readonly y: number;
      readonly text: string;
      readonly size: number;
      readonly fill: string;
      readonly outline: string;
      readonly outlineWidth: number;
    };

/** Text reads at the picture's scale: its size follows the stroke width chosen. */
export function markTextSize(width: number): number {
  return width * 7;
}

/** The top of a line of text sits this far above its baseline, in em. */
const TEXT_ASCENT = 0.85;
/** A glyph is about this wide, in em; enough to place a click on a line of text. */
const TEXT_ADVANCE = 0.6;

export function markShapes(mark: Mark): ReadonlyArray<MarkShape> {
  const ink = markupInk(mark.ink);
  switch (mark.kind) {
    case "pen":
      return [{ kind: "line", points: mark.points, stroke: ink.value, width: mark.width }];
    case "box":
      return [
        {
          kind: "rect",
          // A box being dragged up and to the left has a negative size until it is kept.
          x: Math.min(mark.x, mark.x + mark.w),
          y: Math.min(mark.y, mark.y + mark.h),
          w: Math.abs(mark.w),
          h: Math.abs(mark.h),
          stroke: ink.value,
          width: mark.width,
        },
      ];
    case "arrow": {
      const angle = Math.atan2(mark.to.y - mark.from.y, mark.to.x - mark.from.x);
      const head = mark.width * 4 + 8;
      const wing = (side: number): MarkupPoint => ({
        x: mark.to.x - head * Math.cos(angle + side * ARROW_HEAD_SPREAD),
        y: mark.to.y - head * Math.sin(angle + side * ARROW_HEAD_SPREAD),
      });
      return [
        { kind: "line", points: [mark.from, mark.to], stroke: ink.value, width: mark.width },
        {
          kind: "line",
          points: [wing(-1), mark.to, wing(1)],
          stroke: ink.value,
          width: mark.width,
        },
      ];
    }
    case "text": {
      const size = markTextSize(mark.width);
      return [
        {
          kind: "text",
          x: mark.x,
          y: mark.y + size * TEXT_ASCENT,
          text: mark.text,
          size,
          fill: ink.value,
          outline: ink.outline,
          outlineWidth: Math.max(2, size / 6),
        },
      ];
    }
  }
}

const ARROW_HEAD_SPREAD = Math.PI / 7;

export interface MarkBounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The box a selected mark is outlined with. */
export function markBounds(mark: Mark): MarkBounds {
  const pad = mark.width / 2;
  switch (mark.kind) {
    case "pen":
      return boundsOf(mark.points, pad);
    case "arrow":
      return boundsOf([mark.from, mark.to], pad + mark.width * 2);
    case "box":
      return { x: mark.x - pad, y: mark.y - pad, w: mark.w + mark.width, h: mark.h + mark.width };
    case "text": {
      const size = markTextSize(mark.width);
      return { x: mark.x, y: mark.y, w: mark.text.length * size * TEXT_ADVANCE, h: size };
    }
  }
}

function boundsOf(points: ReadonlyArray<MarkupPoint>, pad: number): MarkBounds {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

/** Whether a point is on a mark, within `slop` picture pixels of its line. */
export function markHit(mark: Mark, point: MarkupPoint, slop: number): boolean {
  const reach = mark.width / 2 + slop;
  switch (mark.kind) {
    case "pen":
      return polylineDistance(mark.points, point) <= reach;
    case "arrow":
      return polylineDistance([mark.from, mark.to], point) <= reach;
    case "box": {
      const corners: ReadonlyArray<MarkupPoint> = [
        { x: mark.x, y: mark.y },
        { x: mark.x + mark.w, y: mark.y },
        { x: mark.x + mark.w, y: mark.y + mark.h },
        { x: mark.x, y: mark.y + mark.h },
        { x: mark.x, y: mark.y },
      ];
      return polylineDistance(corners, point) <= reach;
    }
    case "text": {
      const box = markBounds(mark);
      return (
        point.x >= box.x - slop &&
        point.x <= box.x + box.w + slop &&
        point.y >= box.y - slop &&
        point.y <= box.y + box.h + slop
      );
    }
  }
}

function polylineDistance(points: ReadonlyArray<MarkupPoint>, point: MarkupPoint): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a === undefined || b === undefined) continue;
    nearest = Math.min(nearest, segmentDistance(a, b, point));
  }
  return nearest;
}

function segmentDistance(a: MarkupPoint, b: MarkupPoint, p: MarkupPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
