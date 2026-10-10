import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, MessageSquare, Pin } from "lucide-react";
import {
  canvasTableRowCells,
  canvasTableRowId,
  type CanvasBlock,
  type CanvasTableCell,
  type CanvasTableColumn,
  type CanvasTableColumnDisplay,
} from "@octant/contracts/canvas";
import { CHART_SEQUENTIAL_STEPS, chartScaleRoleId, chartScaleStep } from "@octant/theme";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantCheckbox } from "../../ui/base/OctantCheckbox";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantSelectField, type OctantSelectOption } from "../../ui/base/OctantSelect";
import { formatCanvasValue } from "../canvasRuntime";
import { PathLabel } from "./ReferenceBlocks";

type TableBlockShape = Extract<CanvasBlock, { readonly kind: "table" }>;
type ColumnId = CanvasTableColumn["id"];

type SortDirection = "ascending" | "descending";

interface SortState {
  readonly columnId: ColumnId;
  readonly direction: SortDirection;
}

type GroupSummaryKind = "count" | "sum" | "average";

interface GroupSummary {
  readonly kind: GroupSummaryKind;
  readonly columnId: ColumnId;
}

/** Rows that share one value of the grouped column, in the order drawn. */
interface RowGroup {
  /** The value's identity: equal cells of different types never share a group. */
  readonly key: string;
  readonly value: CanvasTableCell;
  readonly rows: ReadonlyArray<RowView>;
}

const NO_GROUP = "";
const NO_SUMMARY = "";
const SUMMARY_LABEL: Readonly<Record<GroupSummaryKind, string>> = {
  count: "Count",
  sum: "Sum",
  average: "Average",
};

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

interface RowView {
  readonly cells: ReadonlyArray<CanvasTableCell>;
  /** The author's position, the tie-break that keeps a sort stable. */
  readonly index: number;
  readonly rowId: string | undefined;
}

/**
 * Comment markers on the rows that carry a stable id. Offered only when the
 * host journals comments; `openCounts` holds the unresolved threads anchored
 * to each row id.
 */
export interface TableRowComments {
  readonly openCounts: ReadonlyMap<string, number>;
  readonly onOpen: (rowId: string) => void;
}

/** What a reader would call a row: its first cell, as the table draws it. */
export function canvasTableRowLabel(block: TableBlockShape, cells: ReadonlyArray<CanvasTableCell>) {
  const text = formatCanvasValue(cells[0] ?? null, block.columns[0]?.format).trim();
  return text === "" ? "Untitled row" : text;
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
 * columns that hide, show, and pin to the leading edge, and rows grouped by a
 * column's value.
 *
 * The sort, the filter, the hidden and pinned sets, the grouping, its summary,
 * and which groups are collapsed are view state, held here and never journaled,
 * so the definition the agent wrote is unchanged and the exported and static
 * forms keep its order. A grouping is a reader's question of the data rather
 * than part of what the agent authored, which is why no default is stored. The disclosed numbers are still the
 * reading: a `bar` or a `heat` column draws its mark behind the value, never
 * instead of it, and an absent or `text` display reads as plain text.
 */
export function TableBlock({
  block,
  rowComments,
}: {
  readonly block: TableBlockShape;
  readonly rowComments?: TableRowComments;
}) {
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<ReadonlySet<ColumnId>>(new Set());
  const [pinned, setPinned] = useState<ReadonlySet<ColumnId>>(new Set());
  const [groupBy, setGroupBy] = useState<ColumnId | undefined>(undefined);
  const [summary, setSummary] = useState<GroupSummary | undefined>(undefined);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const headerCells = useRef(new Map<string, HTMLTableCellElement>());
  const commentHeader = useRef<HTMLTableCellElement>(null);
  const grid = useRef<HTMLTableElement>(null);
  const [pinOffsets, setPinOffsets] = useState<ReadonlyMap<string, number>>(new Map());

  const columnViews = useMemo<ReadonlyArray<ColumnView>>(
    () => block.columns.map((column, index) => ({ column, index })),
    [block.columns],
  );
  // Pinned columns lead in the author's order, then the rest: a pinned column
  // stays put only while every column before it is pinned too.
  const visible = useMemo(() => {
    const shown = columnViews.filter((view) => !hidden.has(view.column.id));
    return [
      ...shown.filter((view) => pinned.has(view.column.id)),
      ...shown.filter((view) => !pinned.has(view.column.id)),
    ];
  }, [columnViews, hidden, pinned]);
  const pinnedVisible = visible.filter((view) => pinned.has(view.column.id));
  const lastPinnedId =
    pinnedVisible.length === 0 ? undefined : String(pinnedVisible.at(-1)?.column.id);
  const stats = useMemo<ReadonlyArray<ColumnStats>>(
    () => block.columns.map((_column, index) => columnStats(block, index)),
    [block],
  );
  // A text column whose values carry a separator is read as a path: the shared
  // path style dims the directory and keeps the file name at full ink.
  const rows = useMemo<ReadonlyArray<RowView>>(
    () =>
      block.rows.map((row, index) => ({
        cells: canvasTableRowCells(row),
        index,
        rowId: canvasTableRowId(row),
      })),
    [block.rows],
  );
  // The comment gutter is drawn only when some row can take a comment: a row
  // without an id has nothing a comment could stay on through a sort. It leads
  // the row so its marker stays in view when a wide table scrolls sideways.
  const commentable = rowComments !== undefined && rows.some((row) => row.rowId !== undefined);
  const pathColumns = useMemo<ReadonlySet<ColumnId>>(() => {
    const ids = new Set<ColumnId>();
    for (const { column, index } of columnViews) {
      if (
        column.type === "text" &&
        rows.some(({ cells }) => {
          const value = cells[index];
          return typeof value === "string" && /[\\/]/.test(value);
        })
      ) {
        ids.add(column.id);
      }
    }
    return ids;
  }, [rows, columnViews]);

  const ordered = useMemo<ReadonlyArray<RowView>>(() => {
    const needle = query.trim().toLowerCase();
    const matched =
      needle === ""
        ? rows
        : rows.filter(({ cells }) =>
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
  }, [rows, columnViews, query, sort, visible]);

  const groupIndex =
    groupBy === undefined
      ? undefined
      : columnViews.find((view) => String(view.column.id) === String(groupBy))?.index;
  const grouped = useMemo<ReadonlyArray<RowGroup> | undefined>(() => {
    if (groupIndex === undefined) return undefined;
    const byKey = new Map<string, { value: CanvasTableCell; rows: Array<RowView> }>();
    for (const row of ordered) {
      const value = row.cells[groupIndex] ?? null;
      const key = JSON.stringify(value);
      const group = byKey.get(key);
      if (group === undefined) byKey.set(key, { value, rows: [row] });
      else group.rows.push(row);
    }
    // Groups read in the grouped column's order, following its direction when
    // that column is also the sort; rows keep the sort within their group.
    const factor =
      sort !== undefined &&
      String(sort.columnId) === String(groupBy) &&
      sort.direction === "descending"
        ? -1
        : 1;
    return [...byKey.entries()]
      .map(([key, group]) => ({ key, value: group.value, rows: group.rows }))
      .sort((left, right) => {
        if (left.value === null) return right.value === null ? 0 : 1;
        if (right.value === null) return -1;
        return compareCells(left.value, right.value) * factor;
      });
  }, [groupBy, groupIndex, ordered, sort]);

  const summaryIndex =
    summary === undefined
      ? undefined
      : columnViews.find((view) => String(view.column.id) === String(summary.columnId))?.index;
  const numberColumns = columnViews.filter(({ column }) => column.type === "number");
  const groupOptions: ReadonlyArray<OctantSelectOption> = [
    { id: NO_GROUP, label: "No grouping" },
    ...columnViews.map(({ column }) => ({ id: String(column.id), label: column.label })),
  ];
  const summaryOptions: ReadonlyArray<OctantSelectOption> = [
    { id: NO_SUMMARY, label: "No summary" },
    ...numberColumns.flatMap(({ column }) =>
      (["count", "sum", "average"] as const).map((kind) => ({
        id: `${kind}:${String(column.id)}`,
        label: `${SUMMARY_LABEL[kind]} of ${column.label}`,
      })),
    ),
  ];

  // A pinned cell sticks at the width of everything pinned before it, which
  // only the drawn header knows: column widths follow their content.
  useLayoutEffect(() => {
    const measure = () => {
      const next = new Map<string, number>();
      let left = commentHeader.current?.offsetWidth ?? 0;
      for (const { column } of pinnedVisible) {
        next.set(String(column.id), left);
        left += headerCells.current.get(String(column.id))?.offsetWidth ?? 0;
      }
      setPinOffsets((current) =>
        current.size === next.size && [...next].every(([id, offset]) => current.get(id) === offset)
          ? current
          : next,
      );
    };
    measure();
    if (pinnedVisible.length === 0 || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    if (grid.current !== null) observer.observe(grid.current);
    return () => observer.disconnect();
  });

  const pinStyle = (columnId: ColumnId) => {
    const left = pinOffsets.get(String(columnId));
    return left === undefined ? {} : { left: `${String(left)}px` };
  };
  const pinProps = (columnId: ColumnId) =>
    pinned.has(columnId)
      ? {
          "data-pinned": "true",
          ...(String(columnId) === lastPinnedId ? { "data-pinned-edge": "true" } : {}),
        }
      : {};

  const togglePin = (columnId: ColumnId) => {
    setPinned((current) => {
      const next = new Set(current);
      if (next.has(columnId)) next.delete(columnId);
      else next.add(columnId);
      return next;
    });
  };

  const chooseGroup = (value: string) => {
    setGroupBy(
      value === NO_GROUP
        ? undefined
        : columnViews.find((view) => String(view.column.id) === value)?.column.id,
    );
    // A collapsed group belongs to the grouping that drew it.
    setCollapsed(new Set());
  };

  const chooseSummary = (value: string) => {
    const separator = value.indexOf(":");
    const kind = value.slice(0, separator);
    const columnId = value.slice(separator + 1);
    const column = numberColumns.find((view) => String(view.column.id) === columnId)?.column;
    setSummary(
      column === undefined || (kind !== "count" && kind !== "sum" && kind !== "average")
        ? undefined
        : { kind, columnId: column.id },
    );
  };

  const toggleGroup = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const columnCount = Math.max(1, visible.length + (commentable ? 1 : 0));

  const renderRow = ({ cells, index, rowId }: RowView) => (
    // A row that names itself keeps its element through a sort or a
    // revision, so a focused marker stays on the row it belongs to.
    <tr key={rowId === undefined ? `index:${String(index)}` : `row:${rowId}`}>
      {commentable ? (
        <td className="canvas-block__table-comment">
          {rowId === undefined || rowComments === undefined ? null : (
            <RowCommentMarker
              count={rowComments.openCounts.get(rowId) ?? 0}
              label={canvasTableRowLabel(block, cells)}
              onOpen={() => rowComments.onOpen(rowId)}
            />
          )}
        </td>
      ) : null}
      {visible.map(({ column, index: columnIndex }) => {
        const value = cells[columnIndex] ?? null;
        const heatStep =
          column.display === "heat" && typeof value === "number" && Number.isFinite(value)
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
            {...pinProps(column.id)}
            {...(heatStep === undefined
              ? { style: pinStyle(column.id) }
              : {
                  "data-heat-step": String(heatStep),
                  // The scale roles are theme tokens applied at runtime, so
                  // their value is read from the same TS source the bar list
                  // draws its bars from. A pinned heat cell layers the tint
                  // over its opaque ground so scrolled columns never show.
                  style: {
                    ...pinStyle(column.id),
                    ...(pinned.has(column.id)
                      ? {
                          backgroundImage: `linear-gradient(${heatTint(heatStep)}, ${heatTint(heatStep)})`,
                        }
                      : { background: heatTint(heatStep) }),
                  },
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
  );

  const groupColumn = groupIndex === undefined ? undefined : columnViews[groupIndex]?.column;
  const summaryColumn = summaryIndex === undefined ? undefined : columnViews[summaryIndex]?.column;

  const renderGroup = (group: RowGroup) => {
    const open = !collapsed.has(group.key);
    const label =
      group.value === null ? "No value" : formatCanvasValue(group.value, groupColumn?.format);
    const rowWord = group.rows.length === 1 ? "row" : "rows";
    const openThreads =
      rowComments === undefined
        ? 0
        : group.rows.reduce(
            (total, row) =>
              total + (row.rowId === undefined ? 0 : (rowComments.openCounts.get(row.rowId) ?? 0)),
            0,
          );
    const summaryText =
      summary === undefined || summaryIndex === undefined || summaryColumn === undefined
        ? undefined
        : `${SUMMARY_LABEL[summary.kind]} of ${summaryColumn.label} ${groupSummary(
            summary.kind,
            group.rows,
            summaryIndex,
            summaryColumn.format,
          )}`;
    return (
      <tbody className="canvas-block__table-group-body" key={`group:${group.key}`}>
        <tr className="canvas-block__table-group">
          <th colSpan={columnCount} scope="rowgroup">
            <span className="canvas-block__table-group-head">
              <OctantButton
                aria-expanded={open}
                aria-label={`${groupColumn?.label ?? "Group"}: ${label}, ${String(group.rows.length)} ${rowWord}`}
                className="canvas-block__table-group-toggle"
                onClick={() => toggleGroup(group.key)}
                type="button"
                variant="bare"
              >
                <ChevronRight
                  aria-hidden="true"
                  className="canvas-block__table-group-chevron"
                  size={12}
                  strokeWidth={2}
                />
                <span className="canvas-block__table-group-label">{label}</span>
                <span className="canvas-block__table-group-count">
                  {group.rows.length} {rowWord}
                </span>
              </OctantButton>
              {summaryText === undefined ? null : (
                <span className="canvas-block__table-group-summary">{summaryText}</span>
              )}
              {/* A collapsed group still says it holds open threads, so a
                  comment anchored to one of its rows is never out of sight. */}
              {open || openThreads === 0 ? null : (
                <span className="canvas-block__table-group-comments">
                  <MessageSquare aria-hidden="true" size={12} strokeWidth={1.8} />
                  <span aria-hidden="true">{openThreads}</span>
                  <span className="visually-hidden">
                    {`${String(openThreads)} open ${openThreads === 1 ? "comment" : "comments"} in this group`}
                  </span>
                </span>
              )}
            </span>
          </th>
        </tr>
        {open ? group.rows.map(renderRow) : null}
      </tbody>
    );
  };

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
        <OctantSelectField
          aria-label="Group rows"
          className="canvas-block__table-select"
          onValueChange={chooseGroup}
          options={groupOptions}
          value={groupBy === undefined ? NO_GROUP : String(groupBy)}
        />
        {groupBy === undefined || numberColumns.length === 0 ? null : (
          <OctantSelectField
            aria-label="Group summary"
            className="canvas-block__table-select"
            onValueChange={chooseSummary}
            options={summaryOptions}
            value={
              summary === undefined ? NO_SUMMARY : `${summary.kind}:${String(summary.columnId)}`
            }
          />
        )}
        <details className="canvas-block__table-columns">
          <summary>Columns</summary>
          <ul>
            {columnViews.map(({ column }) => {
              const shown = !hidden.has(column.id);
              const isPinned = pinned.has(column.id);
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
                  <OctantButton
                    aria-label={`Pin ${column.label}`}
                    aria-pressed={isPinned}
                    className="canvas-block__table-pin"
                    onClick={() => togglePin(column.id)}
                    title={isPinned ? "Unpin from the left edge" : "Pin to the left edge"}
                    type="button"
                    variant="bare"
                  >
                    <Pin aria-hidden="true" size={12} strokeWidth={1.8} />
                  </OctantButton>
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
        <table className="ds-table canvas-block__table-grid" ref={grid}>
          <thead>
            <tr>
              {commentable ? (
                <th className="canvas-block__table-comment" ref={commentHeader} scope="col">
                  <span className="visually-hidden">Comments</span>
                </th>
              ) : null}
              {visible.map(({ column }) => {
                const active = sort !== undefined && sort.columnId === column.id;
                return (
                  <th
                    key={String(column.id)}
                    ref={(cell) => {
                      if (cell === null) headerCells.current.delete(String(column.id));
                      else headerCells.current.set(String(column.id), cell);
                    }}
                    scope="col"
                    style={pinStyle(column.id)}
                    {...pinProps(column.id)}
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
          {ordered.length === 0 ? (
            <tbody>
              <tr>
                <td className="canvas-block__table-empty" colSpan={columnCount}>
                  {block.rows.length === 0 ? "No rows." : "No matching rows."}
                </td>
              </tr>
            </tbody>
          ) : grouped === undefined ? (
            <tbody>{ordered.map(renderRow)}</tbody>
          ) : (
            <Fragment>{grouped.map(renderGroup)}</Fragment>
          )}
        </table>
      </div>
    </div>
  );
}

function RowCommentMarker(props: {
  readonly count: number;
  readonly label: string;
  readonly onOpen: () => void;
}) {
  return (
    <OctantButton
      aria-label={
        props.count === 0
          ? `Comment on row ${props.label}`
          : `${String(props.count)} open ${props.count === 1 ? "comment" : "comments"} on row ${props.label}`
      }
      className="canvas-block__row-comment-marker"
      data-has-comments={props.count === 0 ? "false" : "true"}
      onClick={props.onOpen}
      type="button"
      variant="bare"
    >
      <MessageSquare aria-hidden="true" size={12} strokeWidth={1.8} />
      {props.count === 0 ? null : <span>{props.count}</span>}
    </OctantButton>
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

/**
 * A group's summary of a number column over the rows it holds: the count of
 * cells holding a number, their sum, or their mean. An empty cell is not a
 * zero, so it neither counts nor pulls an average down.
 */
function groupSummary(
  kind: GroupSummaryKind,
  rows: ReadonlyArray<RowView>,
  columnIndex: number,
  format: CanvasTableColumn["format"],
): string {
  const values = rows
    .map((row) => row.cells[columnIndex])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (kind === "count") return formatCanvasValue(values.length);
  if (values.length === 0) return "—";
  const sum = values.reduce((total, value) => total + value, 0);
  return formatCanvasValue(kind === "sum" ? sum : sum / values.length, format);
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
    const value = canvasTableRowCells(row)[index];
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  const resolvedMin = min === Number.POSITIVE_INFINITY ? 0 : min;
  const resolvedMax = max === Number.NEGATIVE_INFINITY ? 0 : max;
  return { min: resolvedMin, max: resolvedMax, largest: Math.max(0, resolvedMax) };
}
