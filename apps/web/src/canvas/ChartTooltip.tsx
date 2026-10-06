import { Fragment } from "react";

/**
 * The one hover and focus tooltip every Canvas chart uses.
 *
 * A mark names itself and its value in one place, so a bar, a slice, a line
 * point, and a dot all read the same way. A cartesian chart names the position
 * under the pointer in the caption and lists every visible series there, so a
 * multi-series line reads through the same component as a single slice. It is
 * placed from the mark's own position in the plot rather than the pointer,
 * which is what keeps it off the pointer: it is offset above (or below, near
 * the top) and never sits under the cursor. It carries no entrance motion, so
 * it also respects reduced motion without a separate branch.
 */

/** One reading in the tooltip: a series, its value, and the palette slot its key uses. */
export interface ChartTooltipReading {
  readonly seriesLabel: string;
  readonly valueLabel: string;
  /** Index into the series palette, so a listed reading keeps its key. */
  readonly seriesIndex: number;
}

export interface ChartTooltipAnchor {
  /** What the readings belong to, e.g. the x value under the pointer. */
  readonly caption?: string;
  readonly readings: ReadonlyArray<ChartTooltipReading>;
  /** Fraction across the plot area, 0..1, measured from the left. */
  readonly x: number;
  /** Fraction down the plot area, 0..1, measured from the top. */
  readonly y: number;
}

/** Readings a listed tooltip shows before it says how many more there are. */
const TOOLTIP_MAX_READINGS = 4;

function seriesClass(index: number): string {
  return `ser-${String((index % 6) + 1)}`;
}

export function ChartTooltip({ anchor }: { readonly anchor: ChartTooltipAnchor | undefined }) {
  if (anchor === undefined) return null;
  // A mark near the top of the plot flips the tip below itself; anywhere else
  // the tip sits above. This is a placement choice, not animation.
  const placement = anchor.y < 0.28 ? "below" : "above";
  // A single unnamed mark reads as one head and one value; a cartesian caption
  // lists each visible series under it.
  const single =
    anchor.caption === undefined && anchor.readings.length === 1 ? anchor.readings[0] : undefined;
  const shown = anchor.readings.slice(0, TOOLTIP_MAX_READINGS);
  return (
    <div
      className="chart-tip canvas-block__chart-tip"
      role="tooltip"
      data-placement={placement}
      style={{ left: `${String(anchor.x * 100)}%`, top: `${String(anchor.y * 100)}%` }}
    >
      {single === undefined ? (
        <>
          {anchor.caption === undefined ? null : (
            <span className="chart-tip-head">{anchor.caption}</span>
          )}
          <dl>
            {shown.map((reading) => (
              <Fragment key={reading.seriesIndex}>
                <dt>
                  <span
                    aria-hidden="true"
                    className={`chart-key is-block ${seriesClass(reading.seriesIndex)}`}
                    data-series={String(reading.seriesIndex % 6)}
                  />
                  {reading.seriesLabel}
                </dt>
                <dd>{reading.valueLabel}</dd>
              </Fragment>
            ))}
          </dl>
          {anchor.readings.length > shown.length ? (
            <span className="chart-tip-head">
              {`${String(anchor.readings.length - shown.length)} more`}
            </span>
          ) : null}
        </>
      ) : (
        <>
          <span className="chart-tip-head">{single.seriesLabel}</span>
          <span className="chart-tip-value">{single.valueLabel}</span>
        </>
      )}
    </div>
  );
}
