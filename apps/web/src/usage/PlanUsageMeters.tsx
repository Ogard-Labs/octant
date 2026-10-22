import type { ComposerLimitWindow } from "../context/composerLimitWindows";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { useUsageBarStyle } from "./PlanUsageContext";
import { windowSpan } from "./railUsageReading";
import "./plan-usage-meters.css";

const PIXEL_COLUMNS = 17;
const PIXEL_ROWS = 3;
const PIXEL_CELL = 2;
const PIXEL_GAP = 1;
/** How many columns at the leading edge thin out before the bar ends. */
const FADE_COLUMNS = 4;

/**
 * Whether the cell at `column`, `row` is lit. The last columns before the
 * leading edge thin out in steps (two thirds, a checker, a third, a stipple)
 * so the fill dissolves instead of stopping at a straight edge.
 */
function cellLit(column: number, row: number, fromEdge: number): boolean {
  if (fromEdge >= FADE_COLUMNS) return true;
  if (fromEdge === 3) return (column + row) % 3 !== 0;
  if (fromEdge === 2) return (column + row) % 2 === 0;
  if (fromEdge === 1) return (column + row) % 3 === 0;
  return row === 1 && column % 2 === 0;
}

/**
 * The square cells of a pixelated bar for a share left. A full bar is solid; a
 * bar with anything left lights at least one column; an empty bar lights none.
 */
export function pixelBarCells(
  percent: number,
): ReadonlyArray<{ readonly column: number; readonly row: number; readonly lit: boolean }> {
  const share = Math.max(0, Math.min(100, percent));
  const filled =
    share === 0
      ? 0
      : Math.max(1, Math.min(PIXEL_COLUMNS, Math.round((share / 100) * PIXEL_COLUMNS)));
  const cells: { column: number; row: number; lit: boolean }[] = [];
  for (let column = 0; column < PIXEL_COLUMNS; column += 1) {
    for (let row = 0; row < PIXEL_ROWS; row += 1) {
      const lit = column < filled && (share === 100 || cellLit(column, row, filled - 1 - column));
      cells.push({ column, row, lit });
    }
  }
  return cells;
}

const PIXEL_WIDTH = PIXEL_COLUMNS * PIXEL_CELL + (PIXEL_COLUMNS - 1) * PIXEL_GAP;
const PIXEL_HEIGHT = PIXEL_ROWS * PIXEL_CELL + (PIXEL_ROWS - 1) * PIXEL_GAP;

/** "Week" and "Month" are too long for a meter beside a percent. */
function meterLabel(short: string): string {
  if (short === "Week") return "wk";
  if (short === "Month") return "mo";
  return short;
}

function PlanUsageMeter(props: { readonly window: ComposerLimitWindow }) {
  const style = useUsageBarStyle();
  const { window } = props;
  return (
    <OctantTooltip label={`${window.name}, ${String(window.percent)}% left`} side="top">
      <span className="plan-usage__meter" data-level={window.level} data-style={style}>
        <span className="plan-usage__name">{meterLabel(window.short)}</span>
        {style === "pixelated" ? (
          <svg
            aria-hidden="true"
            className="plan-usage__bar plan-usage__bar--pixelated"
            height={PIXEL_HEIGHT}
            viewBox={`0 0 ${String(PIXEL_WIDTH)} ${String(PIXEL_HEIGHT)}`}
            width={PIXEL_WIDTH}
          >
            {pixelBarCells(window.percent).map((cell) => (
              <rect
                className="plan-usage__cell"
                data-lit={cell.lit ? "true" : "false"}
                height={PIXEL_CELL}
                key={`${String(cell.column)}:${String(cell.row)}`}
                width={PIXEL_CELL}
                x={cell.column * (PIXEL_CELL + PIXEL_GAP)}
                y={cell.row * (PIXEL_CELL + PIXEL_GAP)}
              />
            ))}
          </svg>
        ) : (
          <span aria-hidden="true" className="plan-usage__bar plan-usage__bar--smooth">
            <span style={{ width: `${String(window.percent)}%` }} />
          </span>
        )}
        <span className="plan-usage__percent">{`${String(window.percent)}%`}</span>
      </span>
    </OctantTooltip>
  );
}

/**
 * How much of the plan is left, above a composer: the shortest window the
 * provider reported (5h) and the longest (the week), each as a short name, a
 * thin bar and the share left. A provider that reported no window figure gets
 * nothing, because a bar without a figure would invent one.
 */
export function PlanUsageMeters(props: { readonly windows: ReadonlyArray<ComposerLimitWindow> }) {
  const span = windowSpan(props.windows);
  if (span === undefined) return null;
  const shown = span.inner === undefined ? [span.outer] : [span.inner, span.outer];
  return (
    <span aria-label="Plan usage left" className="plan-usage" role="group">
      {shown.map((window) => (
        <PlanUsageMeter key={window.window} window={window} />
      ))}
    </span>
  );
}
