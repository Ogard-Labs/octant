import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  CanvasHeatmapBlock,
  CanvasHeatmapScale,
  CanvasNumberFormat,
} from "@octant/contracts/canvas";
import {
  CHART_DIVERGING_STEPS,
  CHART_SEQUENTIAL_STEPS,
  chartScaleRoleId,
  chartScaleStep,
} from "@octant/theme";
import { OctantButton } from "../../ui/base/OctantButton";
import { ChartTooltip, type ChartTooltipAnchor } from "../ChartTooltip";
import { formatCanvasValue } from "../canvasRuntime";
import {
  HEATMAP_COLUMN_LABEL_GUTTER,
  HEATMAP_ROW_LABEL_GUTTER,
  HEATMAP_WEEKDAY_GUTTER,
  heatmapRowTotals,
  layoutCanvasHeatmapCalendar,
  layoutCanvasHeatmapMatrix,
  type CanvasHeatmapCalendarLayout,
  type CanvasHeatmapCellBox,
  type CanvasHeatmapDomain,
  type CanvasHeatmapMatrixLayout,
} from "@octant/domain/canvas-heatmap-layout";

const MATRIX_WIDTH = 420;
const MATRIX_ROW_HEIGHT = 20;
const MATRIX_MIN_HEIGHT = 80;
const LABEL_COLUMN_MIN_WIDTH = 12;

type RowSort = "declared" | "total-desc" | "total-asc";

/**
 * A grid coloured by value.
 *
 * A matrix divides a fixed plot into rows and columns; a calendar lays a range
 * of days on a week grid. Both read a value through the shared scale roles and
 * a legend with a scale bar, and both draw a coordinate the block does not
 * list apart from a zero reading. The row sort and the keyboard focus are view
 * state: they are never journaled and never revise the Canvas. The disclosed
 * table is the accessible reading of the same data.
 */
export function HeatmapBlock({ block }: { readonly block: CanvasHeatmapBlock }) {
  return (
    <figure className="canvas-block__heatmap" data-layout={block.layout}>
      {block.layout === "matrix" ? (
        <MatrixHeatmap block={block} />
      ) : (
        <CalendarHeatmap block={block} />
      )}
    </figure>
  );
}

function scaleSteps(scale: CanvasHeatmapScale): number {
  return scale === "diverging" ? CHART_DIVERGING_STEPS : CHART_SEQUENTIAL_STEPS;
}

/** The theme role a reading paints, or undefined for a missing coordinate. */
function fillFor(
  value: number | undefined,
  domain: CanvasHeatmapDomain,
  scale: CanvasHeatmapScale,
): string | undefined {
  if (value === undefined) return undefined;
  const step = chartScaleStep(value, domain, scaleSteps(scale));
  return `var(--octant-${chartScaleRoleId(scale, step)})`;
}

function localeWeekStartsOn(): number {
  // A calendar week starts where the locale says; a locale whose week info the
  // runtime cannot read falls back to Monday rather than to an arbitrary day.
  try {
    const language = typeof navigator === "undefined" ? "en-US" : navigator.language;
    const locale = new Intl.Locale(language) as Intl.Locale & {
      getWeekInfo?: () => { readonly firstDay: number };
    };
    const first = locale.getWeekInfo?.().firstDay;
    if (typeof first === "number" && Number.isFinite(first)) return first % 7;
  } catch {
    // fall through to the default
  }
  return 1;
}

function MatrixHeatmap({
  block,
}: {
  readonly block: Extract<CanvasHeatmapBlock, { readonly layout: "matrix" }>;
}) {
  const scale: CanvasHeatmapScale = block.scale ?? "sequential";
  const [sort, setSort] = useState<RowSort>("declared");
  const [active, setActive] = useState<string | undefined>(undefined);
  const [anchor, setAnchor] = useState<ChartTooltipAnchor | undefined>(undefined);

  const layout: CanvasHeatmapMatrixLayout = useMemo(() => {
    const totals = heatmapRowTotals(block);
    const declared = block.rows.map((row) => String(row.rowId));
    const rowOrder =
      sort === "declared"
        ? declared
        : [...declared].sort((left, right) => {
            const difference = (totals.get(left) ?? 0) - (totals.get(right) ?? 0);
            return sort === "total-desc" ? -difference : difference;
          });
    const height = Math.max(
      MATRIX_MIN_HEIGHT,
      block.rows.length * MATRIX_ROW_HEIGHT + HEATMAP_COLUMN_LABEL_GUTTER,
    );
    return layoutCanvasHeatmapMatrix(block, { width: MATRIX_WIDTH, height, rowOrder });
  }, [block, sort]);

  const cells = layout.cells;
  const activeCell =
    active === undefined ? undefined : cells.find((cell) => cellKey(cell) === active);

  const show = (cell: CanvasHeatmapCellBox) => {
    setActive(cellKey(cell));
    setAnchor({
      seriesLabel: `${rowLabel(layout, cell.rowId)} · ${columnLabel(layout, cell.columnId)}`,
      valueLabel: cellLabel(block.valueLabel, cell.value, cell.note, block.format),
      x: clamp01((cell.x + cell.width / 2) / layout.width),
      y: clamp01(cell.y / layout.height),
    });
  };

  const move = (rowDelta: number, columnDelta: number) => {
    if (cells.length === 0) return;
    // The first arrow picks the first cell; a later arrow steps from the one
    // already chosen, so the keyboard never skips a cell at the start.
    if (activeCell === undefined) {
      const first = cells[0];
      if (first !== undefined) show(first);
      return;
    }
    const rows = layout.rows.length;
    const columns = layout.columns.length;
    const rowIndex = (activeCell.rowIndex + rowDelta + rows) % rows;
    const columnIndex = (activeCell.columnIndex + columnDelta + columns) % columns;
    const next = cells.find(
      (cell) => cell.rowIndex === rowIndex && cell.columnIndex === columnIndex,
    );
    if (next !== undefined) show(next);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        move(0, 1);
        return;
      case "ArrowLeft":
        event.preventDefault();
        move(0, -1);
        return;
      case "ArrowDown":
        event.preventDefault();
        move(1, 0);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(-1, 0);
        return;
      case "Escape":
        event.preventDefault();
        setActive(undefined);
        setAnchor(undefined);
        return;
      default:
        return;
    }
  };

  return (
    <>
      <div className="canvas-block__heatmap-header">
        <OctantButton
          aria-pressed={sort !== "declared"}
          onClick={() =>
            setSort((current) =>
              current === "declared"
                ? "total-desc"
                : current === "total-desc"
                  ? "total-asc"
                  : "declared",
            )
          }
          type="button"
          variant="bare"
        >
          {sort === "declared"
            ? "Sort rows by total"
            : sort === "total-desc"
              ? "Rows: total ↓"
              : "Rows: total ↑"}
        </OctantButton>
      </div>
      <div
        aria-label={matrixLabel(block)}
        className="canvas-block__heatmap-plot"
        onKeyDown={onKeyDown}
        role="group"
        tabIndex={0}
      >
        <svg
          aria-hidden="true"
          className="canvas-block__heatmap-svg"
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
        >
          {layout.columns
            .filter((column) => column.width >= LABEL_COLUMN_MIN_WIDTH)
            .map((column) => (
              <text
                key={column.columnId}
                className="canvas-block__heatmap-axis"
                textAnchor="middle"
                x={column.x + column.width / 2}
                y={12}
              >
                {shortLabel(column.label, column.width)}
              </text>
            ))}
          {layout.rows.map((row) => (
            <text
              key={row.rowId}
              className="canvas-block__heatmap-axis"
              dominantBaseline="middle"
              textAnchor="end"
              x={HEATMAP_ROW_LABEL_GUTTER - 6}
              y={row.y + row.height / 2}
            >
              {row.label}
            </text>
          ))}
          {layout.cells.map((cell) => {
            const fill = fillFor(cell.value, layout.domain, scale);
            return (
              <rect
                key={cellKey(cell)}
                className={`canvas-block__heatmap-mark${cell.value === undefined ? " is-missing" : ""}${cellKey(cell) === active ? " is-active" : ""}`}
                data-column-id={cell.columnId}
                data-row-id={cell.rowId}
                height={Math.max(1, cell.height - 1)}
                onPointerEnter={() => show(cell)}
                onPointerLeave={() => {
                  setActive(undefined);
                  setAnchor(undefined);
                }}
                {...(fill === undefined ? {} : { fill })}
                width={Math.max(1, cell.width - 1)}
                x={cell.x}
                y={cell.y}
              />
            );
          })}
        </svg>
        <ChartTooltip anchor={anchor} />
      </div>
      <HeatmapLegend block={block} domain={layout.domain} scale={scale} />
      <details className="canvas-block__heatmap-data">
        <summary>View heatmap data</summary>
        <div
          aria-label="Heatmap data"
          className="canvas-block__heatmap-table"
          role="region"
          tabIndex={0}
        >
          <table aria-label="Heatmap readings" className="ds-table">
            <thead>
              <tr>
                <th scope="col">Row</th>
                {layout.columns.map((column) => (
                  <th key={column.columnId} scope="col">
                    {column.label}
                  </th>
                ))}
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {layout.rows.map((row) => (
                <tr key={row.rowId}>
                  <th scope="row">{row.label}</th>
                  {layout.columns.map((column) => {
                    const cell = cells.find(
                      (entry) => entry.rowId === row.rowId && entry.columnId === column.columnId,
                    );
                    return (
                      <td key={column.columnId}>
                        {cell?.value === undefined
                          ? "—"
                          : formatCanvasValue(cell.value, block.format)}
                      </td>
                    );
                  })}
                  <td>{formatCanvasValue(row.total, block.format)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function CalendarHeatmap({
  block,
}: {
  readonly block: Extract<CanvasHeatmapBlock, { readonly layout: "calendar" }>;
}) {
  const scale: CanvasHeatmapScale = block.scale ?? "sequential";
  const [active, setActive] = useState<string | undefined>(undefined);
  const [anchor, setAnchor] = useState<ChartTooltipAnchor | undefined>(undefined);
  const layout: CanvasHeatmapCalendarLayout = useMemo(
    () => layoutCanvasHeatmapCalendar(block, { weekStartsOn: localeWeekStartsOn() }),
    [block],
  );

  const show = (index: number) => {
    const day = layout.days[index];
    if (day === undefined) return;
    setActive(day.date);
    setAnchor({
      seriesLabel: day.date,
      valueLabel: cellLabel(block.valueLabel, day.value, day.note, block.format),
      x: clamp01((day.x + day.width / 2) / layout.width),
      y: clamp01(day.y / layout.height),
    });
  };

  const move = (delta: number) => {
    if (layout.days.length === 0) return;
    if (active === undefined) {
      show(0);
      return;
    }
    const index = layout.days.findIndex((day) => day.date === active);
    const next = (Math.max(0, index) + delta + layout.days.length) % layout.days.length;
    show(next);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        move(1);
        return;
      case "ArrowLeft":
        event.preventDefault();
        move(-1);
        return;
      case "ArrowDown":
        event.preventDefault();
        move(7);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(-7);
        return;
      case "Escape":
        event.preventDefault();
        setActive(undefined);
        setAnchor(undefined);
        return;
      default:
        return;
    }
  };

  return (
    <>
      <div
        aria-label={calendarLabel(block, layout)}
        className="canvas-block__heatmap-plot"
        onKeyDown={onKeyDown}
        role="group"
        tabIndex={0}
      >
        <svg
          aria-hidden="true"
          className="canvas-block__heatmap-svg canvas-block__heatmap-svg--calendar"
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
        >
          {layout.weekdayRows.map((row) => (
            <text
              key={row.label}
              className="canvas-block__heatmap-axis"
              dominantBaseline="middle"
              textAnchor="end"
              x={HEATMAP_WEEKDAY_GUTTER - 6}
              y={row.y}
            >
              {row.label}
            </text>
          ))}
          {layout.monthLabels.map((month, index) => (
            <text
              key={`${month.label}-${String(index)}`}
              className="canvas-block__heatmap-axis"
              x={month.x}
              y={12}
            >
              {month.label}
            </text>
          ))}
          {layout.days.map((day) => {
            const fill = fillFor(day.value, layout.domain, scale);
            return (
              <rect
                key={day.date}
                className={`canvas-block__heatmap-mark${day.value === undefined ? " is-missing" : ""}${day.date === active ? " is-active" : ""}`}
                data-date={day.date}
                height={day.height}
                onPointerEnter={() => {
                  const index = layout.days.findIndex((entry) => entry.date === day.date);
                  if (index >= 0) show(index);
                }}
                onPointerLeave={() => {
                  setActive(undefined);
                  setAnchor(undefined);
                }}
                {...(fill === undefined ? {} : { fill })}
                width={day.width}
                x={day.x}
                y={day.y}
              />
            );
          })}
        </svg>
        <ChartTooltip anchor={anchor} />
      </div>
      <HeatmapLegend block={block} domain={layout.domain} scale={scale} />
      <details className="canvas-block__heatmap-data">
        <summary>View heatmap data</summary>
        <div
          aria-label="Heatmap data"
          className="canvas-block__heatmap-table"
          role="region"
          tabIndex={0}
        >
          <table aria-label="Heatmap readings" className="ds-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">{block.valueLabel ?? "Value"}</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {block.days.map((day) => (
                <tr key={day.date}>
                  <th scope="row">{day.date}</th>
                  <td>{formatCanvasValue(day.value, block.format)}</td>
                  <td>{day.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function HeatmapLegend({
  block,
  domain,
  scale,
}: {
  readonly block: CanvasHeatmapBlock;
  readonly domain: CanvasHeatmapDomain;
  readonly scale: CanvasHeatmapScale;
}) {
  const steps = Array.from({ length: scaleSteps(scale) }, (_value, index) => index);
  return (
    <div className="canvas-block__heatmap-legend" aria-label="Colour legend">
      <span className="canvas-block__heatmap-legend-title">{block.valueLabel ?? "Value"}</span>
      <ol className="canvas-block__heatmap-scale">
        {steps.map((step) => (
          <li
            key={step}
            className="canvas-block__heatmap-scale-step"
            style={{ background: `var(--octant-${chartScaleRoleId(scale, step)})` }}
          />
        ))}
      </ol>
      <span className="canvas-block__heatmap-scale-bound">
        {formatCanvasValue(domain.min, block.format)}
      </span>
      <span className="canvas-block__heatmap-scale-bound">
        {formatCanvasValue(domain.max, block.format)}
      </span>
      <span className="canvas-block__heatmap-missing">
        <span
          aria-hidden="true"
          className="canvas-block__heatmap-swatch canvas-block__heatmap-mark is-missing"
        />
        No reading
      </span>
    </div>
  );
}

function cellKey(cell: CanvasHeatmapCellBox): string {
  return `${cell.rowId}\u0000${cell.columnId}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function rowLabel(layout: CanvasHeatmapMatrixLayout, rowId: string): string {
  return layout.rows.find((row) => row.rowId === rowId)?.label ?? rowId;
}

function columnLabel(layout: CanvasHeatmapMatrixLayout, columnId: string): string {
  return layout.columns.find((column) => column.columnId === columnId)?.label ?? columnId;
}

function cellLabel(
  valueLabel: string | undefined,
  value: number | undefined,
  note: string | undefined,
  format: CanvasNumberFormat | undefined,
): string {
  const name = valueLabel ?? "Value";
  if (value === undefined) return `${name}: no reading`;
  const reading = `${name}: ${formatCanvasValue(value, format)}`;
  return note === undefined ? reading : `${reading} — ${note}`;
}

function shortLabel(label: string, width: number): string {
  const fits = Math.max(3, Math.floor(width / 7));
  return label.length <= fits ? label : `${label.slice(0, Math.max(1, fits - 1))}…`;
}

function matrixLabel(block: Extract<CanvasHeatmapBlock, { readonly layout: "matrix" }>): string {
  return `Heatmap with ${String(block.rows.length)} rows and ${String(block.columns.length)} columns. Use the arrow keys to move between cells.`;
}

function calendarLabel(
  block: Extract<CanvasHeatmapBlock, { readonly layout: "calendar" }>,
  layout: CanvasHeatmapCalendarLayout,
): string {
  return `Calendar heatmap from ${layout.startDate} to ${layout.endDate} with ${String(block.days.length)} readings. Use the arrow keys to move between days.`;
}
