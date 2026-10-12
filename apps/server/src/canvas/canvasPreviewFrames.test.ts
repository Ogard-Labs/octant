import { describe, expect, it } from "vitest";
import { boundedFrameReading } from "./canvasPreviewFrames";

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
