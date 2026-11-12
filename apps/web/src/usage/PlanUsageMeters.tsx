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

/** A window's short name in words: "wk" read as a code to look up. */
function meterName(short: string): string {
  if (short === "Week") return "week";
  if (short === "Month") return "month";
  return short;
}

/**
 * One window: a bar and the share left. A meter standing alone carries no
 * name: the bar with its figure already says what it is, and the tooltip and
 * the accessible name say which window. Two meters side by side each lead
 * with a quiet name, because two bare figures cannot be told apart.
 */
function PlanUsageMeter(props: {
  readonly window: ComposerLimitWindow;
  readonly named: boolean;
  /** Replaces the meter's name and tooltip, where one meter speaks for several windows. */
  readonly label?: string;
}) {
  const style = useUsageBarStyle();
  const { window } = props;
  const label = props.label ?? `${window.name}, ${String(window.percent)}% left`;
  return (
    <OctantTooltip label={label} side="top">
      <span
        aria-label={label}
        className="plan-usage__meter"
        data-level={window.level}
        data-style={style}
        role="img"
      >
        {props.named ? <span className="plan-usage__name">{meterName(window.short)}</span> : null}
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
 * How much of the plan is left, beside a composer: the shortest window the
 * provider reported (5h) and the longest (the week), in that order, each as a
 * bar and the share left, named only when there are two. A provider that
 * reported no window figure gets nothing, because a bar without a figure
 * would invent one.
 */
/**
 * The window a compact meter speaks for: the one closest to its limit (the
 * least share left), the shorter window when two are level.
 */
export function closestToLimit(
  shown: ReadonlyArray<ComposerLimitWindow>,
): ComposerLimitWindow | undefined {
  return shown.reduce<ComposerLimitWindow | undefined>(
    (closest, window) =>
      closest === undefined || window.percent < closest.percent ? window : closest,
    undefined,
  );
}

export function PlanUsageMeters(props: {
  readonly windows: ReadonlyArray<ComposerLimitWindow>;
  /**
   * One small meter for the window closest to its limit, with every window in
   * its tooltip and accessible name. The composer's row has room for one.
   */
  readonly compact?: boolean;
}) {
  const span = windowSpan(props.windows);
  if (span === undefined) return null;
  const shown = span.inner === undefined ? [span.outer] : [span.inner, span.outer];
  if (props.compact === true) {
    const closest = closestToLimit(shown);
    if (closest === undefined) return null;
    const label = shown
      .map((window) => `${window.name}, ${String(window.percent)}% left`)
      .join("; ");
    return (
      <span aria-label="Plan usage left" className="plan-usage plan-usage--compact" role="group">
        <PlanUsageMeter label={label} named={false} window={closest} />
      </span>
    );
  }
  return (
    <span aria-label="Plan usage left" className="plan-usage" role="group">
      {shown.map((window) => (
        <PlanUsageMeter key={window.window} named={shown.length > 1} window={window} />
      ))}
    </span>
  );
}
