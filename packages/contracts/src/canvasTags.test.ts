import { describe, expect, it } from "vitest";
import {
  CANVAS_MAX_TAGS_PER_CANVAS,
  CANVAS_TAG_MAX_CHARS,
  decodeCanvasTagAdded,
  decodeCanvasTagCommandResult,
  decodeCanvasTagRemoved,
} from "./canvasTags";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
} as const;

describe("Canvas tag contracts", () => {
  it("decodes a tag fact the journal records", () => {
    const added = decodeCanvasTagAdded({
      canvasId: ids.canvas,
      tag: "Launch",
      addedAt: "2026-08-01T21:00:00.000Z",
      sequence: 1,
    });
    expect(added.tag).toBe("Launch");
    expect(
      decodeCanvasTagRemoved({
        canvasId: ids.canvas,
        tag: "Launch",
        removedAt: "2026-08-01T21:30:00.000Z",
        sequence: 2,
      }).sequence,
    ).toBe(2);
  });

  it("keeps a tag a short, non-empty label", () => {
    expect(() =>
      decodeCanvasTagAdded({
        canvasId: ids.canvas,
        tag: "x".repeat(CANVAS_TAG_MAX_CHARS + 1),
        addedAt: "2026-08-01T21:00:00.000Z",
        sequence: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasTagAdded({
        canvasId: ids.canvas,
        tag: "  ",
        addedAt: "2026-08-01T21:00:00.000Z",
        sequence: 1,
      }),
    ).toThrow();
  });

  it("answers an accepted tag change with the tags the Canvas holds", () => {
    const result = decodeCanvasTagCommandResult({
      kind: "accepted",
      canvasId: ids.canvas,
      sequence: 1,
      tags: ["Launch"],
    });
    expect(result.kind).toBe("accepted");

    expect(() =>
      decodeCanvasTagCommandResult({
        kind: "accepted",
        canvasId: ids.canvas,
        sequence: 1,
        tags: Array.from({ length: CANVAS_MAX_TAGS_PER_CANVAS + 1 }, (_, index) => `tag-${index}`),
      }),
    ).toThrow();
  });
});
