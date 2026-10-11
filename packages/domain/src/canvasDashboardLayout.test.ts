import { describe, expect, it } from "vitest";
import { opsDashboardExample } from "./canvasDashboardExamples";
import {
  canvasDashboardCellSpan,
  canvasDashboardCellWidth,
  canvasReadingOrder,
  packCanvasDashboardGrid,
} from "./canvasDashboardLayout";

describe("dashboard reading order", () => {
  it("reads a dashboard's cells where it sits and skips placed blocks at their own positions", () => {
    const intro = { blockId: "intro", kind: "rich-text" };
    const outro = { blockId: "outro", kind: "rich-text" };
    const items = canvasReadingOrder([intro, ...opsDashboardExample, outro]);
    expect(items.map((item) => item.kind)).toEqual(["block", "dashboard", "block"]);
    const dashboard = items[1];
    if (dashboard?.kind !== "dashboard") throw new Error("expected a dashboard");
    expect(dashboard.cells.map((cell) => cell.block.blockId)).toEqual(
      opsDashboardExample[0].cells.map((cell) => cell.blockId),
    );
    expect(dashboard.columns).toBe(4);
  });

  it("reads a block a dashboard placed before the dashboard inside the grid, not twice", () => {
    const tile = { blockId: "a", kind: "metric" };
    const board = { blockId: "b", kind: "dashboard", title: "B", cells: [{ blockId: "a" }] };
    const items = canvasReadingOrder([tile, board]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("dashboard");
  });

  it("leaves a block in place when a cell names a kind a dashboard does not draw", () => {
    const heading = { blockId: "h", kind: "heading" };
    const board = { blockId: "b", kind: "dashboard", title: "B", cells: [{ blockId: "h" }] };
    const items = canvasReadingOrder([board, heading]);
    expect(items.map((item) => item.kind)).toEqual(["dashboard", "block"]);
  });
});

describe("dashboard cell spans", () => {
  it("gives a tile one column and a chart or table two unless the author says otherwise", () => {
    expect(canvasDashboardCellSpan("metric", undefined, 4)).toBe(1);
    expect(canvasDashboardCellSpan("chart", undefined, 4)).toBe(2);
    expect(canvasDashboardCellSpan("table", undefined, 1)).toBe(1);
    expect(canvasDashboardCellSpan("metric", 3, 4)).toBe(3);
  });

  it("packs cells into rows in order, wrapping a cell that does not fit", () => {
    const packed = packCanvasDashboardGrid(
      [
        { block: "a", span: 1 },
        { block: "b", span: 2 },
        { block: "c", span: 2 },
        { block: "d", span: 3 },
      ],
      3,
    );
    expect(packed.map(({ block, row, column }) => [block, row, column])).toEqual([
      ["a", 0, 0],
      ["b", 0, 1],
      ["c", 1, 0],
      ["d", 2, 0],
    ]);
  });
});

describe("dashboard cell widths", () => {
  it("draws a cell across the whole grid at dock width and at its span on a wide one", () => {
    const at = (gridWidth: number, span: number) =>
      canvasDashboardCellWidth({ gridWidth, columns: 4, span, kind: "chart" });
    expect(at(400, 1)).toBe(374);
    expect(at(700, 1)).toBe((700 - 12) / 2 - 26);
    expect(at(1000, 1)).toBe((1000 - 36) / 4 - 26);
    expect(at(1000, 4)).toBe(1000 - 26);
    expect(canvasDashboardCellWidth({ gridWidth: 400, columns: 4, span: 1, kind: "metric" })).toBe(
      400,
    );
  });
});
