import { describe, expect, it } from "vitest";
import {
  exportMarkedPicture,
  planMarkupExport,
  type MarkupCanvas,
  type MarkupContext,
} from "./markupExport";
import type { Mark } from "./markupModel";
import { markHit, markShapes } from "./markupShapes";

const marks: ReadonlyArray<Mark> = [
  { id: "a", kind: "box", ink: "red", width: 3, x: 10, y: 20, w: 100, h: 50 },
  { id: "b", kind: "arrow", ink: "blue", width: 3, from: { x: 0, y: 0 }, to: { x: 80, y: 0 } },
  { id: "c", kind: "text", ink: "white", width: 3, x: 5, y: 5, text: "Wrong colour" },
];

// jsdom has no 2D canvas context, so these tests check the composition plan and
// the calls made on a stand-in context. Whether the pixels come out right is
// seen in a real window.
function recordingCanvas(blob: Blob | null) {
  const calls: string[] = [];
  const context = new Proxy(
    {},
    {
      get:
        (_target, name: string) =>
        (...args: unknown[]) => {
          calls.push(`${name}(${args.length})`);
        },
      set: (_target, name: string, value: unknown) => {
        calls.push(`${name}=${String(value)}`);
        return true;
      },
    },
  ) as MarkupContext;
  const canvas: MarkupCanvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (done) => done(blob),
  };
  return { canvas, calls };
}

describe("composing a marked-up picture", () => {
  it("plans the picture at its natural size with the same shapes the drawing layer shows", () => {
    const plan = planMarkupExport({ width: 1280, height: 720 }, marks, "Inter");
    expect(plan.width).toBe(1280);
    expect(plan.height).toBe(720);
    expect(plan.shapes).toEqual(marks.flatMap(markShapes));
  });

  it("draws an arrow as a shaft and a head, and text with an outline that contrasts with its ink", () => {
    const [arrow, text] = [marks[1], marks[2]].map((mark) =>
      mark === undefined ? [] : markShapes(mark),
    );
    expect(arrow).toHaveLength(2);
    expect(text?.[0]).toMatchObject({ kind: "text", fill: "#ffffff", outline: "#111111" });
  });

  it("paints the still first and then each mark, and answers a PNG blob", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const { canvas, calls } = recordingCanvas(png);
    const blob = await exportMarkedPicture({
      image: {} as CanvasImageSource,
      picture: { width: 640, height: 360 },
      marks,
      fontFamily: "Inter",
      createCanvas: () => canvas,
    });
    expect(blob).toBe(png);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
    expect(calls[0]).toBe("drawImage(3)");
    expect(calls).toContain("strokeRect(4)");
    expect(calls).toContain("fillText(3)");
  });

  it("answers nothing when the canvas gives no picture back", async () => {
    const { canvas } = recordingCanvas(null);
    await expect(
      exportMarkedPicture({
        image: {} as CanvasImageSource,
        picture: { width: 10, height: 10 },
        marks: [],
        fontFamily: "Inter",
        createCanvas: () => canvas,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("picking a mark", () => {
  it("picks a box by its edge and not by its empty middle", () => {
    const boxMark = marks[0];
    if (boxMark === undefined) throw new Error("missing mark");
    expect(markHit(boxMark, { x: 10, y: 40 }, 2)).toBe(true);
    expect(markHit(boxMark, { x: 60, y: 45 }, 2)).toBe(false);
  });
});
