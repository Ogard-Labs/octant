/**
 * The one hover and focus tooltip every Canvas chart uses.
 *
 * A mark names itself and its value in one place, so a bar, a slice, a line
 * point, and a dot all read the same way. It is placed from the mark's own
 * position in the plot rather than the pointer, which is what keeps it off the
 * pointer: it is offset above (or below, near the top) and never sits under
 * the cursor. It carries no entrance motion, so it also respects reduced
 * motion without a separate branch.
 */
export interface ChartTooltipAnchor {
  readonly seriesLabel: string;
  readonly valueLabel: string;
  /** Fraction across the plot area, 0..1, measured from the left. */
  readonly x: number;
  /** Fraction down the plot area, 0..1, measured from the top. */
  readonly y: number;
}

export function ChartTooltip({ anchor }: { readonly anchor: ChartTooltipAnchor | undefined }) {
  if (anchor === undefined) return null;
  // A mark near the top of the plot flips the tip below itself; anywhere else
  // the tip sits above. This is a placement choice, not animation.
  const placement = anchor.y < 0.28 ? "below" : "above";
  return (
    <div
      className="chart-tip canvas-block__chart-tip"
      role="tooltip"
      data-placement={placement}
      style={{ left: `${String(anchor.x * 100)}%`, top: `${String(anchor.y * 100)}%` }}
    >
      <span className="chart-tip-head">{anchor.seriesLabel}</span>
      <span className="chart-tip-value">{anchor.valueLabel}</span>
    </div>
  );
}
