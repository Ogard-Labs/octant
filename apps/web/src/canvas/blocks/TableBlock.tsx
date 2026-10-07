import { useMemo, useState } from "react";
import type {
  CanvasBlock,
  CanvasTableCell,
  CanvasTableColumn,
  CanvasTableColumnDisplay,
} from "@octant/contracts/canvas";
import { CHART_SEQUENTIAL_STEPS, chartScaleRoleId, chartScaleStep } from "@octant/theme";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantCheckbox } from "../../ui/base/OctantCheckbox";
import { OctantInput } from "../../ui/base/OctantInput";
import { formatCanvasValue } from "../canvasRuntime";
import { PathLabel } from "./ReferenceBlocks";

type TableBlockShape = Extract<CanvasBlock, { readonly kind: "table" }>;
type ColumnId = CanvasTableColumn["id"];

type SortDirection = "ascending" | "descending";

interface SortState {
  readonly columnId: ColumnId;
  readonly direction: SortDirection;
}

interface ColumnStats {
  readonly min: number;
  readonly max: number;
  /** The largest reading at or above zero, the bar's full-length anchor. */
  readonly largest: number;
}

interface ColumnView {
  readonly column: CanvasTableColumn;
  readonly index: number;
}

// The scale roles are theme tokens applied at runtime, so the bar fill and the
// heat tint read them from the same TS source the bar list draws its bars from.
const BAR_SCALE_ROLE = chartScaleRoleId("sequential", CHART_SEQUENTIAL_STEPS - 2);

/** The sequential-scale tint a heat step paints, kept readable over its text. */
function heatTint(step: number): string {
  return `color-mix(in oklab, var(--octant-${chartScaleRoleId("sequential", step)}) 40%, transparent)`;
}

/**
 * A Canvas table as a small spreadsheet view: sortable headers, a text filter,
 * and columns that hide and show.
 *
 * The sort, the filter, and the hidden set are view state, held here and never
 * journaled, so the definition the agent wrote is unchanged and the exported
 * and static forms keep its order. The disclosed numbers are still the
 * reading: a `bar` or a `heat` column draws its mark behind the value, never
 * instead of it, and an absent or `text` display reads as plain text.
 */
export function TableBlock({ block }: { readonly block: TableBlockShape }) {
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<ReadonlySet<ColumnId>>(new Set());

  const columnViews = useMemo<ReadonlyArray<ColumnView>>(
    () => block.columns.map((column, index) => ({ column, index })),
    [block.columns],
  );
  const visible = useMemo(
    () => columnViews.filter((view) => !hidden.has(view.column.id)),
    [columnViews, hidden],
  );
  const stats = useMemo<ReadonlyArray<ColumnStats>>(
    () => block.columns.map((_column, index) => columnStats(block, index)),
    [block],
  );
  // A text column whose values carry a separator is read as a path: the shared
  // path style dims the directory and keeps the file name at full ink.
  const pathColumns = useMemo<ReadonlySet<ColumnId>>(() => {
    const ids = new Set<ColumnId>();
    for (const { column, index } of columnViews) {
      if (
        column.type === "text" &&
        block.rows.some((row) => {
          const value = row[index];
          return typeof value === "string" && /[\\/]/.test(value);
        })
      ) {
        ids.add(column.id);
      }
    }
    return ids;
  }, [block.rows, columnViews]);

  const ordered = useMemo<
    ReadonlyArray<{ readonly cells: ReadonlyArray<CanvasTableCell>; readonly index: number }>
  >(() => {
    const indexed = block.rows.map((cells, index) => ({ cells, index }));
    const needle = query.trim().toLowerCase();
    const matched =
      needle === ""
        ? indexed
        : indexed.filter(({ cells }) =>
            visible.some(({ index: columnIndex }) =>
              reading(cells[columnIndex] ?? null)
                .toLowerCase()
                .includes(needle),
            ),
          );
    if (sort === undefined) return matched;
    const sortIndex = columnViews.find((view) => view.column.id === sort.columnId)?.index;
    if (sortIndex === undefined) return matched;
    const factor = sort.direction === "descending" ? -1 : 1;
    // A tie keeps the author's order, so a stable sort of the indexed rows is
    // the reading rather than an incidental shuffle.
    return [...matched].sort((left, right) => {
      const order = compareCells(left.cells[sortIndex] ?? null, right.cells[sortIndex] ?? null);
      return order === 0 ? left.index - right.index : order * factor;
    });
  }, [block.rows, columnViews, query, sort, visible]);

  const toggleSort = (columnId: ColumnId) => {
    setSort((current) =>
      current !== undefined && current.columnId === columnId
        ? {
            columnId,
            direction: current.direction === "ascending" ? "descending" : "ascending",
          }
        : { columnId, direction: "ascending" },
    );
  };

  const toggleColumn = (columnId: ColumnId) => {
    // Hiding the sorted column also drops the sort: its header carries the only
    // aria-sort and sort mark, so a hidden sort would order rows unexplained.
    const hiding = !hidden.has(columnId) && block.columns.length - hidden.size > 1;
    if (hiding) {
      setSort((current) =>
        current !== undefined && String(current.columnId) === String(columnId)
          ? undefined
          : current,
      );
    }
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(columnId)) {
        next.delete(columnId);
      } else {
        // Keep at least one column: a table with none draws no reading at all.
        if (block.columns.length - next.size <= 1) return current;
        next.add(columnId);
      }
      return next;
    });
  };

  return (
    <div className="canvas-block__table">
      <div className="canvas-block__table-toolbar">
        <OctantInput
          aria-label="Filter rows"
          className="canvas-block__table-filter"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter rows"
          type="search"
          value={query}
        />
        <details className="canvas-block__table-columns">
          <summary>Columns</summary>
          <ul>
            {columnViews.map(({ column }) => {
              const shown = !hidden.has(column.id);
              return (
                <li key={String(column.id)}>
                  <label>
                    <OctantCheckbox
                      checked={shown}
                      disabled={shown && block.columns.length - hidden.size === 1}
                      onChange={() => toggleColumn(column.id)}
                    />
                    {column.label}
                  </label>
                </li>
              );
            })}
          </ul>
        </details>
      </div>
      <div
        aria-label="Table data"
        className="canvas-block__table-scroll"
        role="region"
        tabIndex={0}
      >
        <table className="ds-table canvas-block__table-grid">
          <thead>
            <tr>
              {visible.map(({ column }) => {
                const active = sort !== undefined && sort.columnId === column.id;
                return (
                  <th
                    key={String(column.id)}
                    scope="col"
                    {...(active ? { "aria-sort": sort?.direction } : {})}
                  >
                    <OctantButton
                      className="canvas-block__table-sort"
                      onClick={() => toggleSort(column.id)}
                      type="button"
                      variant="bare"
                    >
                      {column.label}
                      {active ? (
                        <span aria-hidden="true" className="canvas-block__table-sortmark">
                          {sort?.direction === "descending" ? "↓" : "↑"}
                        </span>
                      ) : null}
                    </OctantButton>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {ordered.length === 0 ? (
              <tr>
                <td className="canvas-block__table-empty" colSpan={Math.max(1, visible.length)}>
                  {block.rows.length === 0 ? "No rows." : "No matching rows."}
                </td>
              </tr>
            ) : (
              ordered.map(({ cells, index }) => (
                <tr key={index}>
                  {visible.map(({ column, index: columnIndex }) => {
                    const value = cells[columnIndex] ?? null;
                    const heatStep =
                      column.display === "heat" &&
                      typeof value === "number" &&
                      Number.isFinite(value)
                        ? chartScaleStep(
                            value,
                            {
                              min: stats[columnIndex]?.min ?? 0,
                              max: stats[columnIndex]?.max ?? 0,
                            },
                            CHART_SEQUENTIAL_STEPS,
                          )
                        : undefined;
                    return (
                      <td
                        key={String(column.id)}
                        className={cellClass(column, pathColumns.has(column.id))}
                        {...(heatStep === undefined
                          ? {}
                          : {
                              "data-heat-step": String(heatStep),
                              // The scale roles are theme tokens applied at
                              // runtime, so their value is read from the same
                              // TS source the bar list draws its bars from.
                              style: { background: heatTint(heatStep) },
                            })}
                      >
                        <TableCell
                          column={column}
                          isPath={pathColumns.has(column.id)}
                          stats={stats[columnIndex]}
                          value={value}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TableCell({
  value,
  column,
  isPath,
  stats,
}: {
  readonly value: CanvasTableCell;
  readonly column: CanvasTableColumn;
  readonly isPath: boolean;
  readonly stats: ColumnStats | undefined;
}) {
  const text = formatCanvasValue(value, column.format);
  const display: CanvasTableColumnDisplay = column.display ?? "text";
  if (display === "status") {
    return <span className="badge">{text}</span>;
  }
  if (
    display === "bar" &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    stats !== undefined &&
    stats.largest > 0
  ) {
    const fraction = Math.max(0, Math.min(1, value / stats.largest));
    return (
      <span className="canvas-block__table-bar-cell">
        <span className="canvas-block__table-value">{text}</span>
        <span aria-hidden="true" className="canvas-block__table-bar">
          <span
            className="canvas-block__table-bar-fill"
            style={{
              background: `var(--octant-${BAR_SCALE_ROLE})`,
              width: `${String(Math.round(fraction * 100))}%`,
            }}
          />
        </span>
      </span>
    );
  }
  if (isPath && typeof value === "string") {
    return <PathLabel label={value} />;
  }
  return <span className="canvas-block__table-value">{text}</span>;
}

function cellClass(column: CanvasTableColumn, isPath: boolean): string {
  const parts = ["canvas-block__table-cell"];
  if (column.type === "number") parts.push("num-col");
  if (isPath) parts.push("canvas-block__table-path");
  if (column.display !== undefined && column.display !== "text") {
    parts.push(`canvas-block__table-cell--${column.display}`);
  }
  return parts.join(" ");
}

function reading(value: CanvasTableCell): string {
  return typeof value === "string" ? value : formatCanvasValue(value);
}

/**
 * A column's sorted reading: numbers by value, booleans false before true,
 * everything else by a numeric-aware, case-insensitive string order. A null
 * sorts last in both directions, so an empty cell never heads a sort.
 */
function compareCells(left: CanvasTableCell, right: CanvasTableCell): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === "number" && typeof right === "number") {
    if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return (left ? 1 : 0) - (right ? 1 : 0);
  }
  return reading(left).localeCompare(reading(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function columnStats(block: TableBlockShape, index: number): ColumnStats {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of block.rows) {
    const value = row[index];
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  const resolvedMin = min === Number.POSITIVE_INFINITY ? 0 : min;
  const resolvedMax = max === Number.NEGATIVE_INFINITY ? 0 : max;
  return { min: resolvedMin, max: resolvedMax, largest: Math.max(0, resolvedMax) };
}
