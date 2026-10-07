import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import type {
  CanvasHeatmapBlock,
  CanvasHeatmapCalendarBlock,
  CanvasHeatmapMatrixBlock,
} from "@octant/contracts/canvas";

/**
 * The grids an agent is shown when it asks how to draw one.
 * Wire shape, not a branded block: describe returns these objects as-is. The
 * agent gathers the numbers with its own tools; a Canvas reads nothing, so the
 * example carries only the structure and the readings.
 */

/** Commits by weekday and hour: rows are days, columns are hours of the day. */
export const commitsByHourExample = {
  blockId: "commits-by-hour",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "heatmap" as const,
  layout: "matrix" as const,
  valueLabel: "Commits",
  format: "number" as const,
  scale: "sequential" as const,
  rows: [
    { rowId: "mon", label: "Mon" },
    { rowId: "tue", label: "Tue" },
    { rowId: "wed", label: "Wed" },
  ],
  columns: [
    { columnId: "h09", label: "09" },
    { columnId: "h10", label: "10" },
    { columnId: "h11", label: "11" },
    { columnId: "h14", label: "14" },
    { columnId: "h15", label: "15" },
  ],
  cells: [
    { rowId: "mon", columnId: "h09", value: 3 },
    { rowId: "mon", columnId: "h10", value: 7 },
    { rowId: "mon", columnId: "h11", value: 5 },
    { rowId: "mon", columnId: "h14", value: 2, note: "After the review" },
    { rowId: "tue", columnId: "h10", value: 4 },
    { rowId: "tue", columnId: "h11", value: 9 },
    { rowId: "tue", columnId: "h15", value: 1 },
    { rowId: "wed", columnId: "h09", value: 6 },
    { rowId: "wed", columnId: "h14", value: 8 },
    { rowId: "wed", columnId: "h15", value: 6 },
  ],
} as const;

/** Test failures per day: a calendar with one reading per date. */
export const testFailuresCalendarExample = {
  blockId: "test-failures-calendar",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "heatmap" as const,
  layout: "calendar" as const,
  valueLabel: "Test failures",
  format: "number" as const,
  scale: "diverging" as const,
  days: [
    { date: "2026-09-01", value: 0 },
    { date: "2026-09-02", value: 2 },
    { date: "2026-09-03", value: 1 },
    { date: "2026-09-04", value: 0 },
    { date: "2026-09-07", value: 5, note: "Flaky suite" },
    { date: "2026-09-08", value: 3 },
    { date: "2026-09-09", value: 0 },
    { date: "2026-09-10", value: 4 },
    { date: "2026-09-11", value: 1 },
    { date: "2026-09-14", value: 0 },
    { date: "2026-09-15", value: 6 },
    { date: "2026-09-16", value: 2 },
  ],
} as const;

export const heatmapExamples = [commitsByHourExample, testFailuresCalendarExample] as const;

function heatmapBlock(value: unknown): CanvasHeatmapBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "heatmap") {
    throw new Error("Heatmap example did not decode as a heatmap block.");
  }
  return block;
}

function matrixBlock(value: unknown): CanvasHeatmapMatrixBlock {
  const block = heatmapBlock(value);
  if (block.layout !== "matrix") {
    throw new Error("Heatmap example did not decode as a matrix layout.");
  }
  return block;
}

function calendarBlock(value: unknown): CanvasHeatmapCalendarBlock {
  const block = heatmapBlock(value);
  if (block.layout !== "calendar") {
    throw new Error("Heatmap example did not decode as a calendar layout.");
  }
  return block;
}

export const heatmapExampleBlocks: ReadonlyArray<CanvasHeatmapBlock> =
  heatmapExamples.map(heatmapBlock);
export const commitsByHourBlock = matrixBlock(commitsByHourExample);
export const testFailuresCalendarBlock = calendarBlock(testFailuresCalendarExample);
