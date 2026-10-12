import { describe, expect, it } from "vitest";
import {
  boundedFrameReading,
  boundedScriptErrors,
  designFrameReadings,
} from "./canvasPreviewFrames";
import { canvasPreviewDesignWarnings } from "./canvasPreviewWarnings";

describe("a design frame's reading", () => {
  it("keeps an overflow and the worst text of a frame as the page reported them", () => {
    expect(
      boundedFrameReading({
        overflow: [{ frameId: "home", overflowPx: 119.6 }],
        contrast: [
          {
            frameId: "home",
            text: "Fine print",
            foreground: "#bbbbbb",
            background: "#ffffff",
            ratio: 1.92,
            target: 4.5,
          },
        ],
      }),
    ).toEqual({
      overflow: [{ frameId: "home", overflowPx: 120 }],
      contrast: [
        {
          frameId: "home",
          text: "Fine print",
          foreground: "#bbbbbb",
          background: "#ffffff",
          ratio: 1.92,
          target: 4.5,
        },
      ],
    });
  });

  it("drops whatever a running design's script could have forged out of shape or bounds", () => {
    const reading = boundedFrameReading({
      overflow: [
        { frameId: "home", overflowPx: Number.POSITIVE_INFINITY },
        { frameId: "<img src=x>", overflowPx: 10 },
        { frameId: "home", overflowPx: -4 },
        "not a record",
      ],
      contrast: [
        // Markup where a colour belongs, a ratio no page can have, and text
        // that already clears its target.
        {
          frameId: "a",
          text: "x",
          foreground: "<b>",
          background: "#ffffff",
          ratio: 2,
          target: 4.5,
        },
        {
          frameId: "a",
          text: "x",
          foreground: "#000000",
          background: "#ffffff",
          ratio: 40,
          target: 4.5,
        },
        {
          frameId: "a",
          text: "x",
          foreground: "#000000",
          background: "#ffffff",
          ratio: 21,
          target: 4.5,
        },
        {
          frameId: "a",
          text: "x",
          foreground: "#777777",
          background: "#ffffff",
          ratio: 2,
          target: 7,
        },
        {
          frameId: "a",
          text: "y".repeat(500),
          foreground: "#bbbbbb",
          background: "#ffffff",
          ratio: 2,
          target: 3,
        },
      ],
    });
    expect(reading.overflow).toEqual([]);
    expect(reading.contrast).toHaveLength(1);
    expect(reading.contrast[0]?.text).toHaveLength(60);
  });

  it("reads a frame that did not answer as nothing measured", () => {
    expect(boundedFrameReading(undefined)).toEqual({ overflow: [], contrast: [] });
    expect(boundedFrameReading("hung")).toEqual({ overflow: [], contrast: [] });
  });
});

describe("a preview's script errors", () => {
  it("keeps the first errors of each design, which is where the root cause is", () => {
    const recorded = JSON.stringify({
      cart: Array.from({ length: 12 }, (_unused, index) => `error ${String(index + 1)}`),
      form: ["x".repeat(1_000)],
    });
    const errors = boundedScriptErrors(recorded);
    expect(errors.get("cart")).toEqual([
      "error 1",
      "error 2",
      "error 3",
      "error 4",
      "error 5",
      "error 6",
      "error 7",
      "error 8",
    ]);
    expect(errors.get("form")?.[0]).toHaveLength(280);
  });

  it("reads a record that is missing, malformed, or the wrong shape as no errors", () => {
    expect(boundedScriptErrors(null).size).toBe(0);
    expect(boundedScriptErrors("{not json").size).toBe(0);
    expect(boundedScriptErrors('["cart"]').size).toBe(0);
    expect(boundedScriptErrors('{"cart": [1, null, {"message": "x"}]}').size).toBe(0);
  });
});

describe("a design the look could not finish reading", () => {
  it("is reported as not measured instead of being left out as if it were clean", () => {
    expect(
      canvasPreviewDesignWarnings([
        { blockId: "late", measured: false, scriptErrors: ["boom"], overflow: [], contrast: [] },
      ]),
    ).toEqual([
      { kind: "design-script-error", blockId: "late", message: "boom" },
      { kind: "design-not-measured", blockId: "late" },
    ]);
  });

  it("is not measured when one of its frames did not answer, and keeps what the others found", () => {
    const reading = designFrameReadings([
      { overflow: [{ frameId: "home", overflowPx: 40 }], contrast: [] },
      undefined,
    ]);
    expect(reading).toEqual({
      measured: false,
      overflow: [{ frameId: "home", overflowPx: 40 }],
      contrast: [],
    });
    expect(
      canvasPreviewDesignWarnings([{ blockId: "half", scriptErrors: [], ...reading }]),
    ).toEqual([
      { kind: "design-not-measured", blockId: "half" },
      { kind: "design-frame-overflow", blockId: "half", frameId: "home", overflowPx: 40 },
    ]);
  });

  it("is measured when every frame answered", () => {
    expect(designFrameReadings([{ overflow: [], contrast: [] }]).measured).toBe(true);
  });
});
