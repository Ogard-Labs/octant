import type {
  CanvasBlock,
  CanvasMetricDirection,
  CanvasNumberFormat,
} from "@octant/contracts/canvas";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Fragment } from "react";
import { formatCanvasValue, formatScalar } from "../canvasRuntime";

type Block = Extract<
  CanvasBlock,
  { readonly kind: "metric" | "progress" | "status" | "key-value" }
>;

/* The status block is the design system's badge; each tone maps onto the
   badge recipe that carries the same meaning. */
const statusToneClass: Record<Extract<Block, { readonly kind: "status" }>["tone"], string> = {
  neutral: "badge",
  info: "badge badge-accent",
  success: "badge badge-ok",
  warning: "badge badge-warn",
  danger: "badge badge-danger",
};

export function DataBlocks({ block }: { readonly block: Block }) {
  switch (block.kind) {
    case "metric":
      return (
        <div className="cmetric canvas-block__metric">
          <span className="cmetric-label">{block.label}</span>
          <span className="cmetric-value">
            {formatCanvasValue(block.value, block.format)}
            {block.unit !== undefined ? <span className="cmetric-unit">{block.unit}</span> : null}
          </span>
          {block.delta !== undefined ? (
            <MetricDelta
              delta={block.delta}
              direction={block.goodDirection}
              format={block.format}
            />
          ) : null}
          {block.sparkline === undefined ? null : <MetricSparkline values={block.sparkline} />}
          {block.caption === undefined ? null : (
            <span className="cmetric-caption">{block.caption}</span>
          )}
        </div>
      );
    case "progress":
      return (
        <div className="canvas-block__progress">
          <span className="canvas-block__progress-label">{block.label}</span>
          <progress max="1" value={block.value}>
            {Math.round(block.value * 100)}%
          </progress>
        </div>
      );
    case "status":
      return (
        <div
          role="status"
          aria-label={`${block.label}: ${block.value}`}
          className={statusToneClass[block.tone]}
        >
          <span className="canvas-block__status-label">{block.label}</span>
          <span className="canvas-block__status-value">{block.value}</span>
        </div>
      );
    case "key-value":
      return (
        <dl className="kv">
          {block.entries.map((entry) => (
            <Fragment key={entry.key}>
              <dt>{entry.key}</dt>
              <dd>{formatScalar(entry.value)}</dd>
            </Fragment>
          ))}
        </dl>
      );
  }
}

/**
 * How a number moved, and how that reads.
 *
 * The block names whether up or down is good; absent or `neutral` keeps the
 * neutral ink, so the arrow alone gives direction. When a direction is named
 * the tone follows the change, but the arrow and the signed value stay the
 * channel a reader without colour relies on.
 */
function MetricDelta({
  delta,
  direction,
  format,
}: {
  readonly delta: number;
  readonly direction: CanvasMetricDirection | undefined;
  readonly format: CanvasNumberFormat | undefined;
}) {
  const Icon = delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : Minus;
  return (
    <span className={`cmetric-delta ${deltaTone(delta, direction)}`}>
      <Icon aria-hidden="true" size={12} strokeWidth={2} />
      {formatDelta(delta, format)}
    </span>
  );
}

/** The tone a delta reads in: good, bad, or flat when no direction is named. */
function deltaTone(delta: number, direction: CanvasMetricDirection | undefined): string {
  if (delta === 0 || direction === undefined || direction === "neutral") return "flat";
  const rising = delta > 0;
  const goodRising = direction === "up";
  return rising === goodRising ? "good" : "bad";
}

/**
 * A recent trend drawn as a sparkline: latest readings only, no axes.
 *
 * A sparkline is a glance at a shape, so it carries no reading of its own; the
 * value and the delta beside it are the accessible numbers. A flat or single
 * series draws a level line rather than collapsing to nothing.
 */
function MetricSparkline({ values }: { readonly values: ReadonlyArray<number> }) {
  const width = 100;
  const height = 24;
  const pad = 2;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (Number.isFinite(value)) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  const span = max - min;
  const points = values
    .map((value, index) => {
      const x = values.length <= 1 ? width / 2 : (index / (values.length - 1)) * width;
      const share = span > 0 ? (value - min) / span : 0.5;
      const y = height - pad - share * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      aria-hidden="true"
      className="cmetric-sparkline"
      preserveAspectRatio="none"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
    >
      <polyline className="cmetric-sparkline-line" fill="none" points={points} />
    </svg>
  );
}

function formatDelta(delta: number, format: CanvasNumberFormat | undefined): string {
  const sign = delta > 0 ? "+" : "";
  return `${sign}${formatCanvasValue(delta, format)}`;
}
