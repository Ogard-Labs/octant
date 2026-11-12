import type { Mark } from "./markupModel";
import { markShapes, type MarkShape } from "./markupShapes";

export const MARKUP_FILE_NAME = "browser-markup.png";

export interface MarkupPicture {
  /** The picture's natural size: the export is not scaled to the screen. */
  readonly width: number;
  readonly height: number;
}

export interface MarkupExportPlan extends MarkupPicture {
  readonly fontFamily: string;
  /** Painted over the still, first mark first. */
  readonly shapes: ReadonlyArray<MarkShape>;
}

/** What the export paints: the same shapes the drawing layer shows, in order. */
export function planMarkupExport(
  picture: MarkupPicture,
  marks: ReadonlyArray<Mark>,
  fontFamily: string,
): MarkupExportPlan {
  return {
    width: picture.width,
    height: picture.height,
    fontFamily,
    shapes: marks.flatMap(markShapes),
  };
}

/** The part of a 2D canvas context the export uses. */
export type MarkupPainter = Pick<
  CanvasRenderingContext2D,
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "stroke"
  | "strokeRect"
  | "strokeText"
  | "fillText"
  | "lineWidth"
  | "lineCap"
  | "lineJoin"
  | "strokeStyle"
  | "fillStyle"
  | "font"
  | "textBaseline"
>;

export function paintMarkupShapes(
  painter: MarkupPainter,
  shapes: ReadonlyArray<MarkShape>,
  fontFamily: string,
): void {
  for (const shape of shapes) {
    switch (shape.kind) {
      case "line": {
        const [first, ...rest] = shape.points;
        if (first === undefined) break;
        painter.strokeStyle = shape.stroke;
        painter.lineWidth = shape.width;
        painter.lineCap = "round";
        painter.lineJoin = "round";
        painter.beginPath();
        painter.moveTo(first.x, first.y);
        for (const point of rest) painter.lineTo(point.x, point.y);
        painter.stroke();
        break;
      }
      case "rect":
        painter.strokeStyle = shape.stroke;
        painter.lineWidth = shape.width;
        painter.lineJoin = "miter";
        painter.strokeRect(shape.x, shape.y, shape.w, shape.h);
        break;
      case "text":
        painter.font = `${String(shape.size)}px ${fontFamily}`;
        painter.textBaseline = "alphabetic";
        painter.lineJoin = "round";
        painter.lineWidth = shape.outlineWidth;
        painter.strokeStyle = shape.outline;
        painter.strokeText(shape.text, shape.x, shape.y);
        painter.fillStyle = shape.fill;
        painter.fillText(shape.text, shape.x, shape.y);
        break;
    }
  }
}

export interface MarkupContext extends MarkupPainter {
  drawImage(image: CanvasImageSource, x: number, y: number): void;
}

/** The part of a canvas element the export uses, so a test can stand in for it. */
export interface MarkupCanvas {
  width: number;
  height: number;
  getContext(kind: "2d"): MarkupContext | null;
  toBlob(done: (blob: Blob | null) => void, type: string): void;
}

/**
 * The still with the marks painted on it, as a PNG at the still's own size.
 * Undefined when the browser gave no canvas to draw on or no PNG back: the
 * caller says so rather than attaching an unmarked picture.
 */
export async function exportMarkedPicture(input: {
  readonly image: CanvasImageSource;
  readonly picture: MarkupPicture;
  readonly marks: ReadonlyArray<Mark>;
  readonly fontFamily: string;
  readonly createCanvas?: () => MarkupCanvas;
}): Promise<Blob | undefined> {
  const plan = planMarkupExport(input.picture, input.marks, input.fontFamily);
  const canvas = (input.createCanvas ?? defaultCanvas)();
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext("2d");
  if (context === null) return undefined;
  context.drawImage(input.image, 0, 0);
  paintMarkupShapes(context, plan.shapes, plan.fontFamily);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? undefined), "image/png"));
}

function defaultCanvas(): MarkupCanvas {
  return document.createElement("canvas");
}
