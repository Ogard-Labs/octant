import type { CanvasBlock, CanvasNumberFormat, CanvasTableCell } from "@octant/contracts/canvas";
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
        <div className="canvas-block__metric">
          <span className="canvas-block__metric-label">{block.label}</span>
          <strong className="canvas-block__metric-value">
            {formatCanvasValue(block.value, block.format)}
            {block.unit !== undefined ? (
              <span className="canvas-block__metric-unit"> {block.unit}</span>
            ) : null}
          </strong>
          {block.delta !== undefined ? (
            <span className="canvas-block__metric-delta">
              {formatDelta(block.delta, block.format)}
            </span>
          ) : null}
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

function formatDelta(delta: number, format: CanvasNumberFormat | undefined): string {
  const sign = delta > 0 ? "+" : "";
  return `${sign}${formatCanvasValue(delta, format)}`;
}

export function formatTableCell(value: CanvasTableCell, format?: CanvasNumberFormat): string {
  return formatCanvasValue(value, format);
}
