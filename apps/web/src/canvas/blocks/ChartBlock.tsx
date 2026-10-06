import { useState, type SVGAttributes } from "react";
import type {
  CanvasChartBlock,
  CanvasChartSeries,
  CanvasChartType,
  CanvasNumberFormat,
} from "@octant/contracts/canvas";
import { OctantButton } from "../../ui/base/OctantButton";
import { CHART_BAR_RADIUS, CHART_DOT_RADIUS } from "@octant/theme";
import { ChartTooltip, type ChartTooltipAnchor } from "../ChartTooltip";
import { gridValues } from "../chartStyle";
import {
  categoryCenter,
  computeYDomain,
  pieWedges,
  ringPath,
  scaleX,
  scaleY,
  type YDomain,
} from "../chartGeometry";
import { formatCanvasValue } from "../canvasRuntime";

const PLOT_WIDTH = 320;
const PLOT_HEIGHT = 168;
const INSET = 12;
const AXIS_Y = 148;
const MAX_INTERACTIVE_LEGEND_ITEMS = 24;
/** Above this many marks a chart is read through its disclosed data table, so
 * the keyboard does not walk a thousand tab stops. Matches the legend cap. */
const MAX_INTERACTIVE_MARKS = 24;

type ChartCategory = {
  readonly key: string;
  readonly label: string;
};

/** What each mark reads out on hover and on keyboard focus. */
interface MarkInteraction {
  readonly enabled: boolean;
  readonly format: CanvasNumberFormat | undefined;
  readonly onAnchor: (anchor: ChartTooltipAnchor) => void;
  readonly onLeave: () => void;
}

function anchorFor(
  x: number,
  y: number,
  seriesLabel: string,
  value: number,
  format: CanvasNumberFormat | undefined,
): ChartTooltipAnchor {
  return {
    seriesLabel,
    valueLabel: formatCanvasValue(value, format),
    // Clamped: a mark at the edge of the plot still keeps its tip on the surface.
    x: Math.min(1, Math.max(0, x / PLOT_WIDTH)),
    y: Math.min(1, Math.max(0, y / PLOT_HEIGHT)),
  };
}

function markInteraction(
  interaction: MarkInteraction,
  anchor: () => ChartTooltipAnchor,
  label: string,
): SVGAttributes<SVGElement> {
  if (!interaction.enabled) return {};
  return {
    tabIndex: 0,
    "aria-label": label,
    onPointerEnter: () => interaction.onAnchor(anchor()),
    onPointerLeave: interaction.onLeave,
    onFocus: () => interaction.onAnchor(anchor()),
    onBlur: interaction.onLeave,
  };
}

export function ChartBlock({ block }: { readonly block: CanvasChartBlock }) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [anchor, setAnchor] = useState<ChartTooltipAnchor | undefined>(undefined);
  const toggle = (id: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const interaction: MarkInteraction = {
    enabled: markCount(block) <= MAX_INTERACTIVE_MARKS,
    format: block.format,
    onAnchor: setAnchor,
    onLeave: () => {
      setAnchor(undefined);
    },
  };

  return (
    <figure className={`canvas-block__chart canvas-block__chart--${block.chartType}`}>
      <div className="canvas-block__chart-plot">
        <svg
          aria-label={chartLabel(block)}
          className="canvas-block__chart-svg"
          role="img"
          viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
        >
          <ChartMarks block={block} hidden={hidden} interaction={interaction} />
        </svg>
        <ChartTooltip anchor={anchor} />
      </div>
      <ChartLegend block={block} hidden={hidden} onToggle={toggle} />
      <ChartData block={block} />
    </figure>
  );
}

function markCount(block: CanvasChartBlock): number {
  return block.series.reduce((count, series) => count + series.points.length, 0);
}

function ChartMarks({
  block,
  hidden,
  interaction,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
  readonly interaction: MarkInteraction;
}) {
  switch (block.chartType) {
    case "pie":
      return <PieMarks block={block} hidden={hidden} hole={false} interaction={interaction} />;
    case "donut":
      return <PieMarks block={block} hidden={hidden} hole interaction={interaction} />;
    case "stacked-bar":
      return <StackedMarks block={block} hidden={hidden} interaction={interaction} />;
    case "grouped-bar":
      return <GroupedMarks block={block} hidden={hidden} interaction={interaction} />;
    case "bar-line":
      return <ComboMarks block={block} hidden={hidden} interaction={interaction} />;
    case "line":
    case "area":
    case "scatter":
    case "bar":
    case "distribution":
      return <CartesianMarks block={block} hidden={hidden} interaction={interaction} />;
    default: {
      const exhaustive: never = block.chartType;
      return exhaustive;
    }
  }
}

function ChartGrid({
  domain,
  zero,
}: {
  readonly domain: YDomain;
  readonly zero: number | undefined;
}) {
  return (
    <g className="canvas-block__chart-grid" aria-hidden="true">
      {gridValues(domain).map((value) => {
        const y = plotY(value, domain);
        if (y <= INSET) return null;
        return (
          <line
            key={value}
            className="canvas-block__chart-gridline"
            x1={INSET}
            x2={PLOT_WIDTH - INSET}
            y1={y}
            y2={y}
          />
        );
      })}
      {zero === undefined ? null : (
        <line
          className="canvas-block__chart-axis"
          x1={INSET}
          x2={PLOT_WIDTH - INSET}
          y1={zero}
          y2={zero}
        />
      )}
    </g>
  );
}

function PieMarks({
  block,
  hidden,
  hole,
  interaction,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
  readonly hole: boolean;
  readonly interaction: MarkInteraction;
}) {
  const series = block.series[0];
  if (series === undefined) return null;
  const visible = series.points
    .map((point, index) => ({ point, index }))
    .filter((item) => !hidden.has(sliceId(String(item.point.x))));
  const wedges = pieWedges(visible.map((item) => item.point.y));
  const cx = PLOT_WIDTH / 2;
  const cy = 78;
  const outer = 62;
  const inner = hole ? 36 : 0;
  return (
    <g>
      {visible.map((item, wedgeIndex) => {
        const wedge = wedges[wedgeIndex];
        if (wedge === undefined) return null;
        const path = ringPath(cx, cy, outer, inner, wedge.start, wedge.end);
        if (path === "") return null;
        const label = String(item.point.x);
        const value = formatCanvasValue(item.point.y, interaction.format);
        return (
          <path
            key={item.index}
            className={`canvas-block__chart-mark canvas-block__chart-slice ${seriesClass(item.index)}`}
            d={path}
            data-series={String(item.index % 6)}
            data-slice={label}
            {...markInteraction(
              interaction,
              () => {
                const mid = (wedge.start + wedge.end) / 2;
                const radius = hole ? (outer + inner) / 2 : outer * 0.62;
                return anchorFor(
                  cx + radius * Math.cos(mid),
                  cy + radius * Math.sin(mid),
                  label,
                  item.point.y,
                  interaction.format,
                );
              },
              `${label}: ${value}`,
            )}
          />
        );
      })}
    </g>
  );
}

function StackedMarks({
  block,
  hidden,
  interaction,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
  readonly interaction: MarkInteraction;
}) {
  const categories = categoryLabels(block.series, interaction.format);
  const visible = visibleSeries(block, hidden);
  const bands = stackOffsets(visible.map((item) => item.series.points.map((point) => point.y)));
  const totals = categories.map((_, category) =>
    visible.reduce((sum, item) => sum + (item.series.points[category]?.y ?? 0), 0),
  );
  const domain = { min: 0, max: Math.max(1, ...totals) };
  const slot = categories.length > 0 ? (PLOT_WIDTH - INSET * 2) / categories.length : 0;
  const barWidth = Math.max(4, slot * 0.62);
  return (
    <g>
      <ChartGrid domain={domain} zero={undefined} />
      <AxisLine />
      <Axis categories={categories} />
      {visible.map((item, visibleIndex) =>
        item.series.points.map((point, category) => {
          const y0 = bands[visibleIndex]?.[category] ?? 0;
          const x = INSET + slot * category + (slot - barWidth) / 2;
          const top = Math.min(plotY(y0, domain), plotY(y0 + point.y, domain));
          const value = formatCanvasValue(point.y, interaction.format);
          return (
            <rect
              key={`${item.series.seriesId}-${String(category)}`}
              className={`canvas-block__chart-mark ${seriesClass(item.index)}`}
              data-series={String(item.index % 6)}
              height={barSpan(y0, y0 + point.y, domain)}
              width={barWidth}
              x={x}
              y={top}
              rx={CHART_BAR_RADIUS}
              {...markInteraction(
                interaction,
                () =>
                  anchorFor(x + barWidth / 2, top, item.series.label, point.y, interaction.format),
                `${item.series.label}: ${value}`,
              )}
            />
          );
        }),
      )}
    </g>
  );
}

function GroupedMarks({
  block,
  hidden,
  interaction,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
  readonly interaction: MarkInteraction;
}) {
  const categories = categoryLabels(block.series, interaction.format);
  const visible = visibleSeries(block, hidden);
  const values = visible.flatMap((item) => item.series.points.map((point) => point.y));
  const domain = zeroDomain(values);
  const slot = categories.length > 0 ? (PLOT_WIDTH - INSET * 2) / categories.length : 0;
  const gap = 2;
  const inner = Math.max(4, slot * 0.78);
  const barWidth =
    visible.length > 0 ? Math.max(2, (inner - gap * (visible.length - 1)) / visible.length) : 2;
  return (
    <g>
      <ChartGrid domain={domain} zero={domain.min < 0 ? plotY(0, domain) : undefined} />
      <AxisLine />
      <Axis categories={categories} />
      {categories.map((_, category) =>
        visible.map((item, visibleIndex) => {
          const value = item.series.points[category]?.y ?? 0;
          const used = barWidth * visible.length + gap * Math.max(0, visible.length - 1);
          const x = INSET + slot * category + (slot - used) / 2 + visibleIndex * (barWidth + gap);
          const yValue = plotY(value, domain);
          const yBase = plotY(0, domain);
          const top = Math.min(yBase, yValue);
          const reading = formatCanvasValue(value, interaction.format);
          return (
            <rect
              key={`${item.series.seriesId}-${String(category)}`}
              className={`canvas-block__chart-mark ${seriesClass(item.index)}`}
              data-series={String(item.index % 6)}
              height={Math.max(1, Math.abs(yBase - yValue))}
              width={barWidth}
              x={x}
              y={top}
              rx={CHART_BAR_RADIUS}
              {...markInteraction(
                interaction,
                () =>
                  anchorFor(x + barWidth / 2, top, item.series.label, value, interaction.format),
                `${item.series.label}: ${reading}`,
              )}
            />
          );
        }),
      )}
    </g>
  );
}

function ComboMarks({
  block,
  hidden,
  interaction,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
  readonly interaction: MarkInteraction;
}) {
  const categories = categoryLabels(block.series, interaction.format);
  const visible = visibleSeries(block, hidden);
  const bars = visible.filter((item) => item.series.mark !== "line");
  const lines = visible.filter((item) => item.series.mark === "line");
  const values = visible.flatMap((item) => item.series.points.map((point) => point.y));
  const domain = zeroDomain(values);
  const slot = categories.length > 0 ? (PLOT_WIDTH - INSET * 2) / categories.length : 0;
  const gap = 2;
  const inner = Math.max(4, slot * 0.62);
  const barWidth =
    bars.length > 0 ? Math.max(2, (inner - gap * (bars.length - 1)) / bars.length) : 2;
  return (
    <g>
      <ChartGrid domain={domain} zero={domain.min < 0 ? plotY(0, domain) : undefined} />
      <AxisLine />
      <Axis categories={categories} />
      {categories.map((_, category) =>
        bars.map((item, barIndex) => {
          const value = item.series.points[category]?.y ?? 0;
          const used = barWidth * bars.length + gap * Math.max(0, bars.length - 1);
          const x = INSET + slot * category + (slot - used) / 2 + barIndex * (barWidth + gap);
          const yValue = plotY(value, domain);
          const yBase = plotY(0, domain);
          const top = Math.min(yBase, yValue);
          const reading = formatCanvasValue(value, interaction.format);
          return (
            <rect
              key={`${item.series.seriesId}-${String(category)}`}
              className={`canvas-block__chart-mark ${seriesClass(item.index)}`}
              data-series={String(item.index % 6)}
              height={Math.max(1, Math.abs(yBase - yValue))}
              width={barWidth}
              x={x}
              y={top}
              rx={CHART_BAR_RADIUS}
              {...markInteraction(
                interaction,
                () =>
                  anchorFor(x + barWidth / 2, top, item.series.label, value, interaction.format),
                `${item.series.label}: ${reading}`,
              )}
            />
          );
        }),
      )}
      {lines.map((item) => {
        const coords = item.series.points.map((point, index) => ({
          x: categoryCenter(index, categories.length, PLOT_WIDTH, INSET),
          y: plotY(point.y, domain),
          value: point.y,
        }));
        return (
          <LineMark
            key={item.series.seriesId}
            coords={coords}
            interaction={interaction}
            label={item.series.label}
            seriesAttr={String(item.index % 6)}
            seriesIndex={item.index}
          />
        );
      })}
    </g>
  );
}

function CartesianMarks({
  block,
  hidden,
  interaction,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
  readonly interaction: MarkInteraction;
}) {
  const visible = visibleSeries(block, hidden);
  const domain = computeYDomain(
    visible.map((item) => ({
      seriesId: item.series.seriesId,
      label: item.series.label,
      points: item.series.points,
    })),
  );
  return (
    <g>
      {block.chartType === "scatter" ? null : <ChartGrid domain={domain} zero={undefined} />}
      <AxisLine />
      {visible.map((item) => (
        <SeriesShapes
          key={item.series.seriesId}
          chartType={block.chartType}
          domain={domain}
          series={item.series}
          seriesIndex={item.index}
          interaction={interaction}
        />
      ))}
    </g>
  );
}

function SeriesShapes({
  chartType,
  series,
  domain,
  seriesIndex,
  interaction,
}: {
  readonly chartType: CanvasChartType;
  readonly series: CanvasChartSeries;
  readonly domain: YDomain;
  readonly seriesIndex: number;
  readonly interaction: MarkInteraction;
}) {
  const count = series.points.length;
  const coords = series.points.map((point, index) => ({
    x: scaleX(index, count, PLOT_WIDTH, INSET),
    y: scaleY(point.y, domain, PLOT_HEIGHT, INSET),
    value: point.y,
  }));
  const points = coords.map((coord) => `${String(coord.x)},${String(coord.y)}`).join(" ");
  const mark = `canvas-block__chart-mark ${seriesClass(seriesIndex)}`;
  if (chartType === "line") {
    return (
      <LineMark
        coords={coords}
        interaction={interaction}
        label={series.label}
        seriesAttr={String(seriesIndex % 6)}
        seriesIndex={seriesIndex}
      />
    );
  }
  if (chartType === "area") {
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first === undefined || last === undefined) return null;
    const baseY = PLOT_HEIGHT - INSET;
    const path = `M ${String(first.x)} ${String(baseY)} L ${points.replaceAll(" ", " L ")} L ${String(last.x)} ${String(baseY)} Z`;
    return <path className={`${mark} is-area`} d={path} data-series={String(seriesIndex % 6)} />;
  }
  if (chartType === "scatter") {
    return (
      <g className={mark} data-series={String(seriesIndex % 6)}>
        {coords.map((coord, index) => (
          <circle
            key={index}
            className="canvas-block__chart-mark canvas-block__chart-dot"
            cx={coord.x}
            cy={coord.y}
            r={CHART_DOT_RADIUS}
            {...markInteraction(
              interaction,
              () => anchorFor(coord.x, coord.y, series.label, coord.value, interaction.format),
              `${series.label}: ${formatCanvasValue(coord.value, interaction.format)}`,
            )}
          />
        ))}
      </g>
    );
  }
  const barWidth = count > 0 ? Math.max(2, PLOT_WIDTH / count / 2) : 2;
  return (
    <g className={mark} data-series={String(seriesIndex % 6)}>
      {coords.map((coord, index) => (
        <rect
          key={index}
          className="canvas-block__chart-mark"
          height={Math.max(1, PLOT_HEIGHT - INSET - coord.y)}
          width={barWidth}
          x={coord.x - barWidth / 2}
          y={coord.y}
          rx={CHART_BAR_RADIUS}
          {...markInteraction(
            interaction,
            () => anchorFor(coord.x, coord.y, series.label, coord.value, interaction.format),
            `${series.label}: ${formatCanvasValue(coord.value, interaction.format)}`,
          )}
        />
      ))}
    </g>
  );
}

function LineMark({
  coords,
  interaction,
  label,
  seriesAttr,
  seriesIndex,
}: {
  readonly coords: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly value: number;
  }>;
  readonly interaction: MarkInteraction;
  readonly label: string;
  readonly seriesAttr: string;
  readonly seriesIndex: number;
}) {
  const points = coords.map((coord) => `${String(coord.x)},${String(coord.y)}`).join(" ");
  return (
    <g data-series={seriesAttr}>
      <polyline
        className={`canvas-block__chart-mark is-line ${seriesClass(seriesIndex)}`}
        data-series={seriesAttr}
        fill="none"
        points={points}
      />
      {coords.map((coord, index) => (
        <circle
          key={index}
          className={`canvas-block__chart-mark canvas-block__chart-dot ${seriesClass(seriesIndex)}`}
          cx={coord.x}
          cy={coord.y}
          data-series={seriesAttr}
          r={CHART_DOT_RADIUS}
          {...markInteraction(
            interaction,
            () => anchorFor(coord.x, coord.y, label, coord.value, interaction.format),
            `${label}: ${formatCanvasValue(coord.value, interaction.format)}`,
          )}
        />
      ))}
    </g>
  );
}

function AxisLine() {
  return (
    <line
      className="canvas-block__chart-axis"
      x1={INSET}
      x2={PLOT_WIDTH - INSET}
      y1={AXIS_Y}
      y2={AXIS_Y}
    />
  );
}

function Axis({ categories }: { readonly categories: ReadonlyArray<ChartCategory> }) {
  return (
    <g>
      {categories.length <= 6
        ? categories.map((category, index) => (
            <text
              key={category.key}
              className="canvas-block__chart-label"
              textAnchor="middle"
              x={categoryCenter(index, categories.length, PLOT_WIDTH, INSET)}
              y={164}
            >
              {shortLabel(category.label)}
            </text>
          ))
        : null}
    </g>
  );
}

function ChartLegend({
  block,
  hidden,
  onToggle,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
}) {
  const items = legendItems(block);
  if (items.length === 0) return null;
  return (
    <ul className="chart-legend">
      {items.map((item) => (
        <li key={item.id}>
          <OctantButton
            aria-pressed={!hidden.has(item.id)}
            className="canvas-block__chart-legend-item"
            onClick={() => onToggle(item.id)}
            type="button"
            variant="bare"
          >
            <span aria-hidden="true" className={item.keyClass} data-series={item.seriesAttr} />
            {item.label}
          </OctantButton>
        </li>
      ))}
    </ul>
  );
}

function ChartData({ block }: { readonly block: CanvasChartBlock }) {
  return (
    <details className="canvas-block__chart-data">
      <summary>View chart data</summary>
      <div aria-label="Chart data" className="canvas-block__chart-table" role="region" tabIndex={0}>
        {block.chartType === "pie" || block.chartType === "donut" ? (
          <SliceTable block={block} />
        ) : (
          <SeriesTable block={block} />
        )}
      </div>
    </details>
  );
}

function SliceTable({ block }: { readonly block: CanvasChartBlock }) {
  const points = block.series[0]?.points ?? [];
  const total = points.reduce((sum, point) => sum + point.y, 0);
  return (
    <table aria-label="Chart readings" className="ds-table">
      <thead>
        <tr>
          <th scope="col">Slice</th>
          <th scope="col">Value</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {points.map((point, index) => (
          <tr key={index}>
            <th scope="row">{String(point.x)}</th>
            <td>{formatCanvasValue(point.y, block.format)}</td>
            <td>{formatShare(point.y, total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SeriesTable({ block }: { readonly block: CanvasChartBlock }) {
  const categories = categoryLabels(block.series, block.format);
  const aligned =
    block.chartType === "stacked-bar" ||
    block.chartType === "grouped-bar" ||
    block.chartType === "bar-line";
  const repeats = block.series.some(
    (series) =>
      new Set(series.points.map((point) => categoryKey(point.x))).size !== series.points.length,
  );
  if (aligned && !repeats) {
    return (
      <table aria-label="Chart readings" className="ds-table">
        <thead>
          <tr>
            <th scope="col">Category</th>
            {block.series.map((series) => (
              <th key={series.seriesId} scope="col">
                {series.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map((category) => (
            <tr key={category.key}>
              <th scope="row">{category.label}</th>
              {block.series.map((series) => (
                <td key={series.seriesId}>
                  {formatCanvasValue(valueAt(series, category.key), block.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  // Scatter, line, area, bar, and distribution can repeat or skip categories,
  // so the disclosed table lists every reading instead of a matrix that would
  // collapse duplicates to their first y.
  return (
    <table aria-label="Chart readings" className="ds-table">
      <thead>
        <tr>
          <th scope="col">Series</th>
          <th scope="col">X</th>
          <th scope="col">Y</th>
        </tr>
      </thead>
      <tbody>
        {block.series.flatMap((series) =>
          series.points.map((point, index) => (
            <tr key={`${String(series.seriesId)}:${String(index)}`}>
              <th scope="row">{series.label}</th>
              <td>{formatCanvasValue(point.x, block.format)}</td>
              <td>{formatCanvasValue(point.y, block.format)}</td>
            </tr>
          )),
        )}
      </tbody>
    </table>
  );
}

function legendItems(block: CanvasChartBlock): ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly keyClass: string;
  readonly seriesAttr: string;
}> {
  if (block.chartType === "pie" || block.chartType === "donut") {
    return (block.series[0]?.points ?? [])
      .slice(0, MAX_INTERACTIVE_LEGEND_ITEMS)
      .map((point, index) => ({
        id: sliceId(String(point.x)),
        label: String(point.x),
        keyClass: `chart-key is-block ${seriesClass(index)}`,
        seriesAttr: String(index % 6),
      }));
  }
  return block.series.map((series, index) => ({
    id: series.seriesId,
    label: series.label,
    keyClass: keyClass(block.chartType, series.mark, index),
    seriesAttr: String(index % 6),
  }));
}

function keyClass(
  chartType: CanvasChartType,
  mark: CanvasChartSeries["mark"],
  index: number,
): string {
  const line = chartType === "line" || mark === "line";
  return line ? `chart-key ${seriesClass(index)}` : `chart-key is-block ${seriesClass(index)}`;
}

function visibleSeries(block: CanvasChartBlock, hidden: ReadonlySet<string>) {
  return block.series
    .map((series, index) => ({ series, index }))
    .filter((item) => !hidden.has(item.series.seriesId));
}

function categoryKey(x: number | string): string {
  return typeof x === "number" ? `n:${String(x)}` : `s:${x}`;
}

function categoryLabels(
  series: ReadonlyArray<CanvasChartSeries>,
  format: CanvasNumberFormat | undefined,
): ReadonlyArray<ChartCategory> {
  const seen = new Set<string>();
  const labels: ChartCategory[] = [];
  for (const item of series) {
    for (const point of item.points) {
      const key = categoryKey(point.x);
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push({ key, label: formatCanvasValue(point.x, format) });
    }
  }
  return labels;
}

function valueAt(series: CanvasChartSeries, key: string): number | undefined {
  return series.points.find((point) => categoryKey(point.x) === key)?.y;
}

function seriesClass(index: number): string {
  return `ser-${String((index % 6) + 1)}`;
}

function sliceId(label: string): string {
  return `slice:${label}`;
}

function plotY(value: number, domain: YDomain): number {
  return scaleY(value, domain, AXIS_Y + INSET, INSET);
}

function barSpan(y0: number, y1: number, domain: YDomain): number {
  return Math.max(1, Math.abs(plotY(y0, domain) - plotY(y1, domain)));
}

function stackOffsets(
  columns: ReadonlyArray<ReadonlyArray<number>>,
): ReadonlyArray<ReadonlyArray<number>> {
  const count = columns[0]?.length ?? 0;
  const cursor = Array.from({ length: count }, () => 0);
  return columns.map((series) =>
    series.map((value, category) => {
      const y0 = cursor[category] ?? 0;
      cursor[category] = y0 + value;
      return y0;
    }),
  );
}

function zeroDomain(values: ReadonlyArray<number>): YDomain {
  let min = 0;
  let max = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min === max) return { min: min - 1, max: max + 1 };
  return { min, max };
}

function shortLabel(label: string): string {
  return label.length <= 8 ? label : `${label.slice(0, 7)}…`;
}

function formatShare(value: number, total: number): string {
  if (total <= 0) return "0%";
  const percent = Math.round((value / total) * 1000) / 10;
  return Number.isInteger(percent) ? `${String(percent)}%` : `${percent.toFixed(1)}%`;
}

function chartLabel(block: CanvasChartBlock): string {
  const name = chartTypeName(block.chartType);
  if (block.chartType === "pie" || block.chartType === "donut") {
    const slices = block.series[0]?.points.length ?? 0;
    return `${name} chart with ${String(slices)} slices. Open chart data for the values.`;
  }
  return `${name} chart with ${String(block.series.length)} series. Open chart data for the values.`;
}

function chartTypeName(type: CanvasChartType): string {
  switch (type) {
    case "stacked-bar":
      return "stacked bar";
    case "grouped-bar":
      return "grouped bar";
    case "bar-line":
      return "bar and line";
    case "line":
    case "bar":
    case "area":
    case "scatter":
    case "distribution":
    case "pie":
    case "donut":
      return type;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}
