import { useMemo, useState } from "react";
import type { CanvasBarListBlock } from "@octant/contracts/canvas";
import type { CanvasActionBlock } from "@octant/contracts/canvas-actions";
import { CHART_SEQUENTIAL_STEPS, chartScaleRoleId, chartScaleStep } from "@octant/theme";
import { OctantButton } from "../../ui/base/OctantButton";
import { ChartTooltip, type ChartTooltipAnchor } from "../ChartTooltip";
import { formatCanvasValue } from "../canvasRuntime";
import type { CanvasActionRuntime } from "../canvasActionRuntime";
import { openSourceActionBlock } from "../canvasActionRuntime";
import { PathLabel } from "./ReferenceBlocks";
import {
  BAR_LIST_DEFAULT_VISIBLE_ROWS,
  barListValueDomain,
  layoutCanvasBarList,
  type CanvasBarListRowLayout,
} from "@octant/domain/canvas-bar-list-layout";

/** Above this many rows the list is read through its disclosed table, so the
 * keyboard does not walk a tab stop per bar. Matches the chart mark cap. */
const MAX_INTERACTIVE_ROWS = 24;

/**
 * A ranked list of magnitudes: the "hottest files" or "slowest tests" panel.
 *
 * Rows are ordered largest first by default and each bar is its share of the
 * largest value, worked out by the shared domain layout so the screen and the
 * static export draw the same list. The order, the number of rows shown, and
 * Show all are view state: they are never journaled and never revise the
 * Canvas. A row that names a manifest source offers Open file through the
 * allowlisted open-source action; the host reauthorizes it. The disclosed table
 * is the complete, accessible reading of every row.
 */
export function BarListBlock({
  block,
  actionRuntime,
}: {
  readonly block: CanvasBarListBlock;
  readonly actionRuntime?: CanvasActionRuntime | undefined;
}) {
  const [showAll, setShowAll] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | undefined>(undefined);

  const layout = useMemo(
    () => layoutCanvasBarList(block, showAll ? {} : { limit: BAR_LIST_DEFAULT_VISIBLE_ROWS }),
    [block, showAll],
  );
  const domain = useMemo(() => barListValueDomain(block), [block]);
  const scale = block.scale ?? "neutral";
  const interactive = block.rows.length <= MAX_INTERACTIVE_ROWS;

  const fillFor = (row: CanvasBarListRowLayout): string => {
    if (scale !== "sequential") return "var(--oct-fg-2)";
    const step = chartScaleStep(row.value, domain, CHART_SEQUENTIAL_STEPS);
    return `var(--octant-${chartScaleRoleId("sequential", step)})`;
  };

  const showAnchor = (row: CanvasBarListRowLayout) => {
    if (!interactive) return;
    setActiveIndex(row.index);
  };

  return (
    <figure className="canvas-block__bar-list" data-scale={scale}>
      <ol aria-label={barListLabel(block)} className="canvas-block__bar-list-rows">
        {layout.rows.map((row) => (
          <li className="canvas-block__bar-list-row" key={`${row.label}:${String(row.index)}`}>
            <span aria-hidden="true" className="canvas-block__bar-list-track">
              <span
                className="canvas-block__bar-list-bar"
                style={{ background: fillFor(row), width: `${String(row.fraction * 100)}%` }}
              />
            </span>
            <span
              className="canvas-block__bar-list-entry"
              {...(interactive
                ? {
                    tabIndex: 0,
                    onPointerEnter: () => showAnchor(row),
                    onPointerLeave: () => setActiveIndex(undefined),
                    onFocus: () => showAnchor(row),
                    onBlur: () => setActiveIndex(undefined),
                  }
                : {})}
            >
              <span className="canvas-block__bar-list-label">
                <PathLabel label={row.label} />
              </span>
              <span className="canvas-block__bar-list-value">
                {formatCanvasValue(row.value, block.format)}
              </span>
              {row.secondaryValue === undefined ? null : (
                <span className="canvas-block__bar-list-secondary">
                  {formatCanvasValue(row.secondaryValue, block.secondaryFormat ?? block.format)}
                </span>
              )}
            </span>
            {row.sourceId === undefined ? null : (
              <OpenFileControl
                actionRuntime={actionRuntime}
                blockId={String(block.blockId)}
                index={row.index}
                label={row.label}
                sourceId={row.sourceId}
              />
            )}
            {activeIndex === row.index ? <ChartTooltip anchor={rowAnchor(block, row)} /> : null}
          </li>
        ))}
      </ol>
      {block.rows.length <= BAR_LIST_DEFAULT_VISIBLE_ROWS ? null : (
        <OctantButton
          aria-pressed={showAll}
          className="canvas-block__bar-list-show-all"
          onClick={() => setShowAll((current) => !current)}
          type="button"
          variant="bare"
        >
          {showAll
            ? `Show top ${String(BAR_LIST_DEFAULT_VISIBLE_ROWS)}`
            : `Show all ${String(block.rows.length)}`}
        </OctantButton>
      )}
      <BarListData block={block} actionRuntime={actionRuntime} />
    </figure>
  );
}

function rowAnchor(block: CanvasBarListBlock, row: CanvasBarListRowLayout): ChartTooltipAnchor {
  const readings = [
    {
      seriesIndex: 0,
      seriesLabel: block.valueLabel ?? "Value",
      valueLabel: formatCanvasValue(row.value, block.format),
    },
  ];
  if (row.secondaryValue !== undefined) {
    readings.push({
      seriesIndex: 1,
      seriesLabel: block.secondaryLabel ?? "Second",
      valueLabel: formatCanvasValue(row.secondaryValue, block.secondaryFormat ?? block.format),
    });
  }
  // The tooltip is drawn inside the row it belongs to, so it sits on the row
  // rather than on a fixed fraction of the list. Away from the very top it
  // reads above the row; the flip near the top is the tooltip's own rule.
  return { caption: row.label, readings, x: 0.5, y: 1 };
}

function OpenFileControl({
  actionRuntime,
  blockId,
  index,
  label,
  sourceId,
}: {
  readonly actionRuntime: CanvasActionRuntime | undefined;
  readonly blockId: string;
  readonly index: number;
  readonly label: string;
  readonly sourceId: string;
}) {
  if (actionRuntime === undefined) return null;
  const action: CanvasActionBlock | undefined = openSourceActionBlock({
    blockId: `${blockId}-open-${String(index)}`,
    sourceId,
    label: `Open ${label}`,
  });
  if (action === undefined) return null;
  const availability = actionRuntime.availability(action);
  if (availability.state !== "available") return null;
  return (
    <OctantButton
      className="canvas-block__bar-list-open"
      onClick={() => {
        void actionRuntime.onExecute(action);
      }}
      type="button"
      variant="bare"
    >
      Open file
    </OctantButton>
  );
}

function BarListData({
  block,
  actionRuntime,
}: {
  readonly block: CanvasBarListBlock;
  readonly actionRuntime: CanvasActionRuntime | undefined;
}) {
  const hasSecondary = block.rows.some((row) => row.secondaryValue !== undefined);
  const hasFile =
    actionRuntime !== undefined && block.rows.some((row) => row.sourceId !== undefined);
  return (
    <details className="canvas-block__bar-list-data">
      <summary>View bar list data</summary>
      <div
        aria-label="Bar list data"
        className="canvas-block__bar-list-table"
        role="region"
        tabIndex={0}
      >
        <table aria-label="Bar list readings" className="ds-table">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">{block.valueLabel ?? "Value"}</th>
              {hasSecondary ? <th scope="col">{block.secondaryLabel ?? "Second"}</th> : null}
              {hasFile ? <th scope="col">File</th> : null}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, index) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{formatCanvasValue(row.value, block.format)}</td>
                {hasSecondary ? (
                  <td>
                    {row.secondaryValue === undefined
                      ? ""
                      : formatCanvasValue(
                          row.secondaryValue,
                          block.secondaryFormat ?? block.format,
                        )}
                  </td>
                ) : null}
                {hasFile ? (
                  <td>
                    {row.sourceId === undefined ? null : (
                      <OpenFileControl
                        actionRuntime={actionRuntime}
                        blockId={String(block.blockId)}
                        index={index}
                        label={row.label}
                        sourceId={row.sourceId}
                      />
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function barListLabel(block: CanvasBarListBlock): string {
  return `Ranked bar list with ${String(block.rows.length)} rows. Open bar list data for the values.`;
}
