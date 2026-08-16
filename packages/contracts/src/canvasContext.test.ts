import { describe, expect, it } from "vitest";
import {
  CanvasContextSelection,
  decodeCanvasContextSelection,
  decodeCanvasContextSelectionId,
  MAX_CHAT_TURN_CANVAS_SELECTIONS,
} from "./canvasContext";

const selectionId = "11111111-2222-4333-8444-555555555555";
const canvasId = "22222222-3333-4444-8555-666666666666";
const versionId = "33333333-4444-4555-8666-777777777777";

describe("CanvasContextSelection", () => {
  it("decodes a whole-canvas context selection with opaque version identity", () => {
    const selection = decodeCanvasContextSelection({
      id: selectionId,
      canvasId,
      versionId,
      sequence: 3,
      displayName: "Quarterly summary",
      scope: "whole-canvas",
    });
    expect(selection).toMatchObject({
      id: decodeCanvasContextSelectionId(selectionId),
      canvasId,
      versionId,
      sequence: 3,
      displayName: "Quarterly summary",
      scope: "whole-canvas",
    });
  });

  it("rejects excess properties and invalid scope literals", () => {
    expect(() =>
      decodeCanvasContextSelection({
        id: selectionId,
        canvasId,
        versionId,
        sequence: 1,
        displayName: "Quarterly summary",
        scope: "whole-canvas",
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasContextSelection({
        id: selectionId,
        canvasId,
        versionId,
        sequence: 1,
        displayName: "Quarterly summary",
        scope: "block-range",
      }),
    ).toThrow();
  });

  it("exposes a bounded maximum for composer canvas selections", () => {
    expect(MAX_CHAT_TURN_CANVAS_SELECTIONS).toBe(16);
  });
});
