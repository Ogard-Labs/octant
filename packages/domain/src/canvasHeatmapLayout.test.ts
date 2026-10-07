import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commitsByHourBlock, testFailuresCalendarBlock } from "./canvasHeatmapExamples";
import {
  heatmapRowTotals,
  heatmapValueDomain,
  layoutCanvasHeatmapCalendar,
  layoutCanvasHeatmapMatrix,
} from "./canvasHeatmapLayout";

const snapshot = JSON.parse(
  readFileSync(new URL("./canvasHeatmapLayout.snapshot.json", import.meta.url), "utf8"),
) as {
  readonly matrix: ReturnType<typeof layoutCanvasHeatmapMatrix>;
  readonly calendar: ReturnType<typeof layoutCanvasHeatmapCalendar>;
};

const MATRIX_OPTIONS = { width: 420, height: 120 } as const;

describe("heatmap layout", () => {
  it("lays a matrix out the same way every time", () => {
    const layout = layoutCanvasHeatmapMatrix(commitsByHourBlock, MATRIX_OPTIONS);

    expect(layout).toEqual(snapshot.matrix);
    expect(layoutCanvasHeatmapMatrix(commitsByHourBlock, MATRIX_OPTIONS)).toEqual(layout);
    expect(layout.rows.map((row) => row.rowId)).toEqual(["mon", "tue", "wed"]);
    expect(layout.cells).toHaveLength(3 * 5);
  });

  it("keeps a coordinate a matrix does not list as a missing cell", () => {
    const layout = layoutCanvasHeatmapMatrix(commitsByHourBlock, MATRIX_OPTIONS);
    const listed = layout.cells.find((cell) => cell.rowId === "mon" && cell.columnId === "h09");
    const missing = layout.cells.find((cell) => cell.rowId === "mon" && cell.columnId === "h15");

    expect(listed?.value).toBe(3);
    expect(missing?.value).toBeUndefined();
  });

  it("reorders rows for a total sort without changing the readings", () => {
    const layout = layoutCanvasHeatmapMatrix(commitsByHourBlock, {
      ...MATRIX_OPTIONS,
      rowOrder: ["wed", "tue", "mon"],
    });

    expect(layout.rows.map((row) => row.rowId)).toEqual(["wed", "tue", "mon"]);
    expect(layout.rows.map((row) => row.total)).toEqual([20, 14, 17]);
    const wed = layout.cells.find((cell) => cell.rowId === "wed" && cell.columnId === "h15");
    expect(wed?.value).toBe(6);
  });

  it("totals a row from its present cells only", () => {
    const totals = heatmapRowTotals(commitsByHourBlock);

    expect(totals.get("mon")).toBe(17);
    expect(totals.get("tue")).toBe(14);
  });

  it("lays a calendar out from the week start it is given", () => {
    const layout = layoutCanvasHeatmapCalendar(testFailuresCalendarBlock, { weekStartsOn: 1 });

    expect(layout).toEqual(snapshot.calendar);
    expect(layout.weekStartsOn).toBe(1);
    expect(layout.weekdayRows.map((row) => row.label)).toEqual([
      "Mo",
      "Tu",
      "We",
      "Th",
      "Fr",
      "Sa",
      "Su",
    ]);
    const shifted = layoutCanvasHeatmapCalendar(testFailuresCalendarBlock, { weekStartsOn: 0 });
    expect(shifted.weekdayRows.map((row) => row.label)[0]).toBe("Su");
  });

  it("draws a calendar day with no reading as a missing cell", () => {
    const layout = layoutCanvasHeatmapCalendar(testFailuresCalendarBlock, { weekStartsOn: 1 });
    const gap = layout.days.find((day) => day.date === "2026-09-05");
    const reading = layout.days.find((day) => day.date === "2026-09-01");

    expect(gap?.value).toBeUndefined();
    expect(reading?.value).toBe(0);
  });

  it("gives a single reading a domain that does not collapse to a point", () => {
    const block = { ...commitsByHourBlock, cells: commitsByHourBlock.cells.slice(0, 1) };

    expect(heatmapValueDomain(block)).toEqual({ min: 0, max: 4 });
  });
});
