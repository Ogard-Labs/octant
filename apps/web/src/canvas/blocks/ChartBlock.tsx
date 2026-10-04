import { useState } from "react";
import type {
  CanvasChartBlock,
  CanvasChartSeries,
  CanvasChartType,
} from "@octant/contracts/canvas";
import { OctantButton } from "../../ui/base/OctantButton";
import {
  categoryCenter,
  computeYDomain,
  pieWedges,
  ringPath,
  scaleX,
  scaleY,
  type YDomain,
} from "../chartGeometry";
import { formatScalar } from "../canvasRuntime";

const PLOT_WIDTH = 320;
const PLOT_HEIGHT = 168;
const INSET = 12;
const AXIS_Y = 148;
const MAX_INTERACTIVE_LEGEND_ITEMS = 24;

type ChartCategory = {
  readonly key: string;
  readonly label: string;
};

export function ChartBlock({ block }: { readonly block: CanvasChartBlock }) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <figure className={`canvas-block__chart canvas-block__chart--${block.chartType}`}>
      <svg
        aria-label={chartLabel(block)}
        className="canvas-block__chart-svg"
        role="img"
        viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
      >
        <ChartMarks block={block} hidden={hidden} />
      </svg>
      <ChartLegend block={block} hidden={hidden} onToggle={toggle} />
      <ChartData block={block} />
    </figure>
  );
}

function ChartMarks({
  block,
  hidden,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
}) {
  switch (block.chartType) {
    case "pie":
      return <PieMarks block={block} hidden={hidden} hole={false} />;
    case "donut":
      return <PieMarks block={block} hidden={hidden} hole />;
    case "stacked-bar":
      return <StackedMarks block={block} hidden={hidden} />;
    case "grouped-bar":
      return <GroupedMarks block={block} hidden={hidden} />;
    case "bar-line":
      return <ComboMarks block={block} hidden={hidden} />;
    case "line":
    case "area":
    case "scatter":
    case "bar":
    case "distribution":
      return <CartesianMarks block={block} hidden={hidden} />;
    default: {
      const exhaustive: never = block.chartType;
      return exhaustive;
    }
  }
}

function PieMarks({
  block,
  hidden,
  hole,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
  readonly hole: boolean;
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
        return (
          <path
            key={item.index}
            className={`canvas-block__chart-mark canvas-block__chart-slice ${seriesClass(item.index)}`}
            d={path}
            data-series={String(item.index % 6)}
            data-slice={String(item.point.x)}
          />
        );
      })}
    </g>
  );
}

function StackedMarks({
  block,
  hidden,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
}) {
  const categories = categoryLabels(block.series);
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
      <Axis categories={categories} zero={undefined} />
      {visible.map((item, visibleIndex) =>
        item.series.points.map((point, category) => {
          const y0 = bands[visibleIndex]?.[category] ?? 0;
          const x = INSET + slot * category + (slot - barWidth) / 2;
          return (
            <rect
              key={`${item.series.seriesId}-${String(category)}`}
              className={`canvas-block__chart-mark ${seriesClass(item.index)}`}
              data-series={String(item.index % 6)}
              height={barSpan(y0, y0 + point.y, domain)}
              width={barWidth}
              x={x}
              y={Math.min(plotY(y0, domain), plotY(y0 + point.y, domain))}
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
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
}) {
  const categories = categoryLabels(block.series);
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
      <Axis categories={categories} zero={domain.min < 0 ? plotY(0, domain) : undefined} />
      {categories.map((_, category) =>
        visible.map((item, visibleIndex) => {
          const value = item.series.points[category]?.y ?? 0;
          const used = barWidth * visible.length + gap * Math.max(0, visible.length - 1);
          const x = INSET + slot * category + (slot - used) / 2 + visibleIndex * (barWidth + gap);
          const yValue = plotY(value, domain);
          const yBase = plotY(0, domain);
          return (
            <rect
              key={`${item.series.seriesId}-${String(category)}`}
              className={`canvas-block__chart-mark ${seriesClass(item.index)}`}
              data-series={String(item.index % 6)}
              height={Math.max(1, Math.abs(yBase - yValue))}
              width={barWidth}
              x={x}
              y={Math.min(yBase, yValue)}
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
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
}) {
  const categories = categoryLabels(block.series);
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
      <Axis categories={categories} zero={domain.min < 0 ? plotY(0, domain) : undefined} />
      {categories.map((_, category) =>
        bars.map((item, barIndex) => {
          const value = item.series.points[category]?.y ?? 0;
          const used = barWidth * bars.length + gap * Math.max(0, bars.length - 1);
          const x = INSET + slot * category + (slot - used) / 2 + barIndex * (barWidth + gap);
          const yValue = plotY(value, domain);
          const yBase = plotY(0, domain);
          return (
            <rect
              key={`${item.series.seriesId}-${String(category)}`}
              className={`canvas-block__chart-mark ${seriesClass(item.index)}`}
              data-series={String(item.index % 6)}
              height={Math.max(1, Math.abs(yBase - yValue))}
              width={barWidth}
              x={x}
              y={Math.min(yBase, yValue)}
            />
          );
        }),
      )}
      {lines.map((item) => {
        const coords = item.series.points.map((point, index) => ({
          x: categoryCenter(index, categories.length, PLOT_WIDTH, INSET),
          y: plotY(point.y, domain),
        }));
        return (
          <polyline
            key={item.series.seriesId}
            className={`canvas-block__chart-mark is-line ${seriesClass(item.index)}`}
            data-series={String(item.index % 6)}
            fill="none"
            points={coords.map((coord) => `${String(coord.x)},${String(coord.y)}`).join(" ")}
          />
        );
      })}
    </g>
  );
}

function CartesianMarks({
  block,
  hidden,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
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
      <line
        className="canvas-block__chart-axis"
        x1={INSET}
        x2={PLOT_WIDTH - INSET}
        y1={PLOT_HEIGHT - INSET}
        y2={PLOT_HEIGHT - INSET}
      />
      {visible.map((item) => (
        <SeriesShapes
          key={item.series.seriesId}
          chartType={block.chartType}
          domain={domain}
          series={item.series}
          seriesIndex={item.index}
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
}: {
  readonly chartType: CanvasChartType;
  readonly series: CanvasChartSeries;
  readonly domain: YDomain;
  readonly seriesIndex: number;
}) {
  const count = series.points.length;
  const coords = series.points.map((point, index) => ({
    x: scaleX(index, count, PLOT_WIDTH, INSET),
    y: scaleY(point.y, domain, PLOT_HEIGHT, INSET),
  }));
  const points = coords.map((coord) => `${String(coord.x)},${String(coord.y)}`).join(" ");
  const mark = `canvas-block__chart-mark ${seriesClass(seriesIndex)}`;
  if (chartType === "line") {
    return (
      <polyline
        className={`${mark} is-line`}
        data-series={String(seriesIndex % 6)}
        fill="none"
        points={points}
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
          <circle key={index} className="canvas-block__chart-dot" cx={coord.x} cy={coord.y} r={3} />
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
          height={Math.max(1, PLOT_HEIGHT - INSET - coord.y)}
          width={barWidth}
          x={coord.x - barWidth / 2}
          y={coord.y}
        />
      ))}
    </g>
  );
}

function Axis({
  categories,
  zero,
}: {
  readonly categories: ReadonlyArray<ChartCategory>;
  readonly zero: number | undefined;
}) {
  const y = zero ?? AXIS_Y;
  return (
    <g>
      <line className="canvas-block__chart-axis" x1={INSET} x2={PLOT_WIDTH - INSET} y1={y} y2={y} />
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
            <td>{formatScalar(point.y)}</td>
            <td>{formatShare(point.y, total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SeriesTable({ block }: { readonly block: CanvasChartBlock }) {
  const categories = categoryLabels(block.series);
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
              <td key={series.seriesId}>{formatScalar(valueAt(series, category.key))}</td>
            ))}
          </tr>
        ))}
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

function categoryLabels(series: ReadonlyArray<CanvasChartSeries>): ReadonlyArray<ChartCategory> {
  const seen = new Set<string>();
  const labels: ChartCategory[] = [];
  for (const item of series) {
    for (const point of item.points) {
      const key = categoryKey(point.x);
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push({ key, label: String(point.x) });
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
