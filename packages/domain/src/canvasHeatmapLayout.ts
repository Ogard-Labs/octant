import type {
  CanvasHeatmapBlock,
  CanvasHeatmapCalendarBlock,
  CanvasHeatmapMatrixBlock,
} from "@octant/contracts/canvas";

/**
 * Where a heatmap's cells sit, worked out from the block alone.
 *
 * A matrix fills a fixed plot area: rows and columns divide it and every
 * coordinate the block lists gets a cell. A calendar lays days out on a
 * seven-row week grid whose columns are weeks. Both are deterministic given
 * the block and their options, so the screen renderer and the static SVG
 * export draw the same picture. Nothing here reads state or decides what the
 * numbers mean; the row order and the calendar's week start are the caller's
 * view choices, passed in rather than stored.
 */

export interface CanvasHeatmapDomain {
  readonly min: number;
  readonly max: number;
}

export interface CanvasHeatmapCellBox {
  readonly rowId: string;
  readonly columnId: string;
  readonly rowIndex: number;
  readonly columnIndex: number;
  /** Absent when the block lists no reading here; drawn apart from zero. */
  readonly value: number | undefined;
  readonly note: string | undefined;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasHeatmapMatrixRow {
  readonly rowId: string;
  readonly label: string;
  /** The row's total of its present cells, for a sort or a footer. */
  readonly total: number;
  readonly y: number;
  readonly height: number;
}

export interface CanvasHeatmapMatrixColumn {
  readonly columnId: string;
  readonly label: string;
  readonly total: number;
  readonly x: number;
  readonly width: number;
}

export interface CanvasHeatmapMatrixLayout {
  readonly width: number;
  readonly height: number;
  /** The cell grid, inset from the plot by the label gutters. */
  readonly grid: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly rows: ReadonlyArray<CanvasHeatmapMatrixRow>;
  readonly columns: ReadonlyArray<CanvasHeatmapMatrixColumn>;
  readonly cells: ReadonlyArray<CanvasHeatmapCellBox>;
  readonly domain: CanvasHeatmapDomain;
}

export interface CanvasHeatmapDayBox {
  readonly date: string;
  readonly value: number | undefined;
  readonly note: string | undefined;
  /** 0 is the first weekday of the locale's week. */
  readonly weekday: number;
  readonly week: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasHeatmapCalendarMonth {
  readonly week: number;
  readonly label: string;
  readonly x: number;
}

export interface CanvasHeatmapCalendarWeekday {
  /** The weekday's short name, drawn down the left edge. */
  readonly label: string;
  readonly y: number;
}

export interface CanvasHeatmapCalendarLayout {
  readonly width: number;
  readonly height: number;
  readonly weekStartsOn: number;
  readonly weeks: number;
  readonly days: ReadonlyArray<CanvasHeatmapDayBox>;
  /** Weekday labels in the week's own order, with where each one sits. */
  readonly weekdayRows: ReadonlyArray<CanvasHeatmapCalendarWeekday>;
  readonly monthLabels: ReadonlyArray<CanvasHeatmapCalendarMonth>;
  readonly domain: CanvasHeatmapDomain;
  readonly startDate: string;
  readonly endDate: string;
}

export interface CanvasHeatmapMatrixLayoutOptions {
  readonly width: number;
  readonly height: number;
  /** Row order for the picture; defaults to the block's declared order. */
  readonly rowOrder?: ReadonlyArray<string>;
}

export interface CanvasHeatmapCalendarLayoutOptions {
  /** 0 = Sunday .. 6 = Saturday; a renderer reads it from the locale. */
  readonly weekStartsOn: number;
}

/** A matrix leaves room for a row label on the left and a column label on top. */
export const HEATMAP_ROW_LABEL_GUTTER = 96;
export const HEATMAP_COLUMN_LABEL_GUTTER = 20;

/** A calendar cell is a fixed square; a calendar reads best at one size. */
export const HEATMAP_DAY_SIZE = 12;
export const HEATMAP_DAY_GAP = 3;
export const HEATMAP_WEEKDAY_GUTTER = 28;
export const HEATMAP_MONTH_GUTTER = 16;

const WEEKDAYS_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const MS_PER_DAY = 86_400_000;

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00.000Z`) / MS_PER_DAY);
}

function dateFromDayNumber(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The span of present readings, for scaling a colour.
 *
 * A measure with a single reading gets a span that does not collapse to a
 * point, so a scale still has a domain to divide; an empty one spans 0..1.
 */
export function heatmapValueDomain(block: CanvasHeatmapBlock): CanvasHeatmapDomain {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  if (block.layout === "matrix") {
    for (const cell of block.cells) {
      if (cell.value < min) min = cell.value;
      if (cell.value > max) max = cell.value;
    }
  } else {
    for (const day of block.days) {
      if (day.value < min) min = day.value;
      if (day.value > max) max = day.value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: Math.min(0, min), max: max + 1 };
  return { min, max };
}

/** The sum of a row's present cells, for a total sort or a footer. */
export function heatmapRowTotals(block: CanvasHeatmapMatrixBlock): ReadonlyMap<string, number> {
  const totals = new Map<string, number>(block.rows.map((row) => [String(row.rowId), 0]));
  for (const cell of block.cells) {
    const rowId = String(cell.rowId);
    totals.set(rowId, (totals.get(rowId) ?? 0) + cell.value);
  }
  return totals;
}

/** The sum of a column's present cells. */
function heatmapColumnTotals(block: CanvasHeatmapMatrixBlock): ReadonlyMap<string, number> {
  const totals = new Map<string, number>(
    block.columns.map((column) => [String(column.columnId), 0]),
  );
  for (const cell of block.cells) {
    const columnId = String(cell.columnId);
    totals.set(columnId, (totals.get(columnId) ?? 0) + cell.value);
  }
  return totals;
}

/** The order rows are drawn in: the caller's order, else the declared one. */
function orderedRowIds(
  block: CanvasHeatmapMatrixBlock,
  rowOrder: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  const declared = block.rows.map((row) => String(row.rowId));
  if (rowOrder === undefined) return declared;
  const known = new Set(declared);
  const requested = rowOrder.filter((rowId) => known.has(rowId));
  const seen = new Set(requested);
  return [...requested, ...declared.filter((rowId) => !seen.has(rowId))];
}

export function layoutCanvasHeatmapMatrix(
  block: CanvasHeatmapMatrixBlock,
  options: CanvasHeatmapMatrixLayoutOptions,
): CanvasHeatmapMatrixLayout {
  const rowIds = orderedRowIds(block, options.rowOrder);
  const columnIds = block.columns.map((column) => String(column.columnId));
  const rowTotals = heatmapRowTotals(block);
  const columnTotals = heatmapColumnTotals(block);
  const rowById = new Map(block.rows.map((row) => [String(row.rowId), row]));
  const columnById = new Map(block.columns.map((column) => [String(column.columnId), column]));

  const gridX = HEATMAP_ROW_LABEL_GUTTER;
  const gridY = HEATMAP_COLUMN_LABEL_GUTTER;
  const gridWidth = Math.max(1, options.width - gridX);
  const gridHeight = Math.max(1, options.height - gridY);
  const cellWidth = columnIds.length === 0 ? gridWidth : gridWidth / columnIds.length;
  const cellHeight = rowIds.length === 0 ? gridHeight : gridHeight / rowIds.length;
  const rowIndex = new Map(rowIds.map((rowId, index) => [rowId, index]));
  const columnIndex = new Map(columnIds.map((columnId, index) => [columnId, index]));

  const rows: CanvasHeatmapMatrixRow[] = rowIds.map((rowId, index) => ({
    rowId,
    label: rowById.get(rowId)?.label ?? rowId,
    total: rowTotals.get(rowId) ?? 0,
    y: gridY + index * cellHeight,
    height: cellHeight,
  }));
  const columns: CanvasHeatmapMatrixColumn[] = columnIds.map((columnId, index) => ({
    columnId,
    label: columnById.get(columnId)?.label ?? columnId,
    total: columnTotals.get(columnId) ?? 0,
    x: gridX + index * cellWidth,
    width: cellWidth,
  }));

  // Every coordinate is a cell, present or missing, so a gap in the data is a
  // gap in the picture rather than a row that silently shifts its neighbours.
  const byCoordinate = new Map(
    block.cells.map((cell) => [`${String(cell.rowId)}\u0000${String(cell.columnId)}`, cell]),
  );
  const cells: CanvasHeatmapCellBox[] = [];
  for (const rowId of rowIds) {
    for (const columnId of columnIds) {
      const cell = byCoordinate.get(`${rowId}\u0000${columnId}`);
      cells.push({
        rowId,
        columnId,
        rowIndex: rowIndex.get(rowId) ?? 0,
        columnIndex: columnIndex.get(columnId) ?? 0,
        value: cell?.value,
        note: cell?.note,
        x: gridX + (columnIndex.get(columnId) ?? 0) * cellWidth,
        y: gridY + (rowIndex.get(rowId) ?? 0) * cellHeight,
        width: cellWidth,
        height: cellHeight,
      });
    }
  }

  return {
    width: options.width,
    height: options.height,
    grid: { x: gridX, y: gridY, width: gridWidth, height: gridHeight },
    rows,
    columns,
    cells,
    domain: heatmapValueDomain(block),
  };
}

/** The weekday names in the week's own order, starting at `weekStartsOn`. */
function heatmapWeekdayOrder(weekStartsOn: number): ReadonlyArray<string> {
  const start = Number.isFinite(weekStartsOn) ? Math.floor(weekStartsOn) : 0;
  return Array.from({ length: 7 }, (_value, index) => WEEKDAYS_SHORT[(start + index) % 7] ?? "");
}

export function layoutCanvasHeatmapCalendar(
  block: CanvasHeatmapCalendarBlock,
  options: CanvasHeatmapCalendarLayoutOptions,
): CanvasHeatmapCalendarLayout {
  const weekStartsOn =
    (((Number.isFinite(options.weekStartsOn) ? Math.floor(options.weekStartsOn) : 0) % 7) + 7) % 7;
  const byDate = new Map(block.days.map((day) => [day.date, day]));
  const sortedDates = block.days.map((day) => day.date).sort();
  const startDate = sortedDates[0] ?? "1970-01-01";
  const endDate = sortedDates[sortedDates.length - 1] ?? startDate;
  const startDay = dayNumber(startDate);
  const endDay = dayNumber(endDate);
  const startWeekday = (startDay + 4) % 7; // 1970-01-01 (day 0) was a Thursday.
  const startShift = (((startWeekday - weekStartsOn) % 7) + 7) % 7;
  const firstWeekDay = startDay - startShift;
  const weeks = Math.floor((endDay - firstWeekDay) / 7) + 1;

  const step = HEATMAP_DAY_SIZE + HEATMAP_DAY_GAP;
  const gridX = HEATMAP_WEEKDAY_GUTTER;
  const gridY = HEATMAP_MONTH_GUTTER;
  const days: CanvasHeatmapDayBox[] = [];
  const monthLabels: CanvasHeatmapCalendarMonth[] = [];
  let lastMonth = -1;
  for (let day = startDay; day <= endDay; day += 1) {
    const date = dateFromDayNumber(day);
    const weekday = (day + 4) % 7;
    const week = Math.floor((day - firstWeekDay) / 7);
    const record = byDate.get(date);
    days.push({
      date,
      value: record?.value,
      note: record?.note,
      weekday: (weekday - weekStartsOn + 7) % 7,
      week,
      x: gridX + week * step,
      y: gridY + ((weekday - weekStartsOn + 7) % 7) * step,
      width: HEATMAP_DAY_SIZE,
      height: HEATMAP_DAY_SIZE,
    });
    const month = Number(date.slice(5, 7)) - 1;
    if (month !== lastMonth) {
      lastMonth = month;
      monthLabels.push({
        week,
        label: MONTHS_SHORT[month] ?? "",
        x: gridX + week * step,
      });
    }
  }

  return {
    width: gridX + Math.max(1, weeks) * step,
    height: gridY + 7 * step,
    weekStartsOn,
    weeks,
    days,
    weekdayRows: heatmapWeekdayOrder(weekStartsOn).map((label, index) => ({
      label,
      y: gridY + index * step + HEATMAP_DAY_SIZE / 2,
    })),
    monthLabels,
    domain: heatmapValueDomain(block),
    startDate,
    endDate,
  };
}
