import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type SVGAttributes } from "react";
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
  formatTick,
  niceAxis,
  pieWedges,
  smoothPath,
  ringPath,
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
  seriesIndex: number,
): ChartTooltipAnchor {
  return {
    readings: [{ seriesIndex, seriesLabel, valueLabel: formatCanvasValue(value, format) }],
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

  const [figureRef, width] = useMeasuredWidth();

  return (
    <figure
      className={`canvas-block__chart canvas-block__chart--${block.chartType}`}
      ref={figureRef}
    >
      {isCartesian(block.chartType) ? (
        <CartesianChart block={block} hidden={hidden} width={width} />
      ) : (
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
      )}
      {/* One series is named by the Canvas around it; a legend that can only
          hide the whole chart is noise. */}
      {isCartesian(block.chartType) && block.series.length === 1 ? null : (
        <ChartLegend block={block} hidden={hidden} onToggle={toggle} />
      )}
      <ChartData block={block} />
    </figure>
  );
}

function markCount(block: CanvasChartBlock): number {
  return block.series.reduce((count, series) => count + series.points.length, 0);
}

/** Width a chart draws at before the figure has been measured, and in tests. */
const FALLBACK_CHART_WIDTH = 480;

/**
 * The figure's own width, so a line or bar chart draws in real pixels: its
 * labels stay at the interface size instead of growing and shrinking with the
 * column the way a stretched fixed-size drawing does.
 */
function useMeasuredWidth() {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(FALLBACK_CHART_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    // The layout width, not the painted one: a scaled-down preview of the
    // Canvas must still draw the chart at its own size and let the scale shrink it.
    const measure = () => {
      const next = element.clientWidth;
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function isCartesian(type: CanvasChartType): boolean {
  return (
    type === "line" ||
    type === "area" ||
    type === "scatter" ||
    type === "bar" ||
    type === "distribution"
  );
}

const CARTESIAN_HEIGHT = 200;
const CARTESIAN_PAD = { top: 12, right: 12, bottom: 28 } as const;

interface CartesianFrame {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly domain: YDomain;
}

/**
 * Line, area, scatter, bar and distribution charts on one value axis: round
 * gridlines labelled in a left gutter, the first series' x values along the
 * bottom (thinned to what fits), and a hover readout that names the reading
 * under the pointer. The data table stays the complete, accessible record.
 */
function CartesianChart({
  block,
  hidden,
  width,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
  readonly width: number;
}) {
  const [hover, setHover] = useState<number | undefined>(undefined);
  // useId yields characters a url(#…) reference cannot carry.
  const gradientId = `chart-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const visible = visibleSeries(block, hidden);
  const barLike = block.chartType === "bar" || block.chartType === "distribution";
  const axis = niceAxis(
    computeYDomain(
      visible.map((item) => ({
        seriesId: item.series.seriesId,
        label: item.series.label,
        points: item.series.points,
      })),
    ),
    barLike || block.chartType === "area",
  );
  const tickLabels = axis.ticks.map((tick) => formatTick(tick, axis.step));
  const gutter = Math.min(
    64,
    Math.max(28, Math.max(...tickLabels.map((label) => label.length)) * 7 + 12),
  );
  const frame: CartesianFrame = {
    left: gutter,
    right: Math.max(gutter + 40, width - CARTESIAN_PAD.right),
    top: CARTESIAN_PAD.top,
    bottom: CARTESIAN_HEIGHT - CARTESIAN_PAD.bottom,
    domain: axis.domain,
  };
  const count = Math.max(0, ...visible.map((item) => item.series.points.length));
  const xAt = (index: number) => pointX(frame, index, count, barLike);
  const yAt = (value: number) => {
    const span = frame.domain.max - frame.domain.min;
    const share = span <= 0 ? 0.5 : (value - frame.domain.min) / span;
    return frame.bottom - share * (frame.bottom - frame.top);
  };
  const labelSource = visible[0]?.series.points ?? block.series[0]?.points ?? [];
  const labelEvery = Math.max(
    1,
    Math.ceil(count / Math.max(1, Math.floor((frame.right - frame.left) / 56))),
  );
  const slot = count > 0 ? (frame.right - frame.left) / count : 0;
  // Above the cap the keyboard would walk a tab stop per mark, so the readings
  // are read from the disclosed table and only the pointer names a position.
  const keyboardReadable = markCount(block) <= MAX_INTERACTIVE_MARKS;
  const markProps = (index: number, label: string): SVGAttributes<SVGElement> => ({
    ...(keyboardReadable ? { tabIndex: 0, "aria-label": label } : {}),
    onPointerEnter: () => setHover(index),
    onPointerLeave: () => setHover(undefined),
    onFocus: () => setHover(index),
    onBlur: () => setHover(undefined),
  });
  // Every visible series at the focused position, so a multi-series chart reads
  // through the same tooltip component as a single slice.
  const anchorAt = (index: number): ChartTooltipAnchor => {
    const readings = visible.flatMap((item) => {
      const point = item.series.points[index];
      return point === undefined
        ? []
        : [
            {
              seriesIndex: item.index,
              seriesLabel: item.series.label,
              valueLabel: formatCanvasValue(point.y, block.format),
            },
          ];
    });
    const tops = visible.flatMap((item) => {
      const point = item.series.points[index];
      return point === undefined ? [] : [yAt(point.y)];
    });
    const top = tops.length > 0 ? Math.min(...tops) : frame.top;
    return {
      caption: String(labelSource[index]?.x ?? ""),
      readings,
      // Clamped: a mark at the edge of the plot still keeps its tip on the surface.
      x: width > 0 ? Math.min(1, Math.max(0, xAt(index) / width)) : 0,
      y: Math.min(1, Math.max(0, top / CARTESIAN_HEIGHT)),
    };
  };
  const anchor = hover === undefined ? undefined : anchorAt(hover);

  const pick = (clientX: number, rect: DOMRect) => {
    if (count === 0 || rect.width <= 0) return;
    const x = ((clientX - rect.left) / rect.width) * width;
    let nearest = 0;
    for (let index = 1; index < count; index += 1) {
      if (Math.abs(xAt(index) - x) < Math.abs(xAt(nearest) - x)) nearest = index;
    }
    setHover(nearest);
  };

  return (
    <div className="canvas-chart">
      <TrendHeadline block={block} />
      <div className="canvas-chart__plot">
        <svg
          aria-label={chartLabel(block)}
          className="canvas-chart__svg"
          height={CARTESIAN_HEIGHT}
          onPointerLeave={() => setHover(undefined)}
          onPointerMove={(event) =>
            pick(event.clientX, event.currentTarget.getBoundingClientRect())
          }
          role="img"
          viewBox={`0 0 ${String(width)} ${String(CARTESIAN_HEIGHT)}`}
          width={width}
        >
          <g aria-hidden="true">
            {axis.ticks.map((tick, index) => (
              <g key={tick}>
                <line
                  className={tick === 0 ? "canvas-chart__baseline" : "canvas-chart__grid"}
                  x1={frame.left}
                  x2={frame.right}
                  y1={yAt(tick)}
                  y2={yAt(tick)}
                />
                <text
                  className="canvas-chart__tick"
                  dominantBaseline="middle"
                  textAnchor="end"
                  x={frame.left - 8}
                  y={yAt(tick)}
                >
                  {tickLabels[index]}
                </text>
              </g>
            ))}
            {labelSource.map((point, index) =>
              index % labelEvery === 0 ? (
                <text
                  className="canvas-block__chart-label"
                  key={index}
                  textAnchor="middle"
                  x={xAt(index)}
                  y={CARTESIAN_HEIGHT - 8}
                >
                  {shortLabel(String(point.x))}
                </text>
              ) : null,
            )}
          </g>
          {hover === undefined ? null : (
            <line
              aria-hidden="true"
              className="canvas-chart__guide"
              x1={xAt(hover)}
              x2={xAt(hover)}
              y1={frame.top}
              y2={frame.bottom}
            />
          )}
          {visible.map((item, order) => {
            const coords = item.series.points.map((point, index) => ({
              x: xAt(index),
              y: yAt(point.y),
              value: point.y,
            }));
            const mark = `canvas-block__chart-mark ${seriesClass(item.index)}`;
            const series = String(item.index % 6);
            if (barLike) {
              const groupWidth = Math.min(slot * 0.64, 48);
              const barWidth = Math.max(2, groupWidth / Math.max(1, visible.length));
              return (
                <g className={mark} data-series={series} key={item.series.seriesId}>
                  {coords.map((coord, index) => {
                    const zero = yAt(Math.max(frame.domain.min, Math.min(0, frame.domain.max)));
                    return (
                      <rect
                        className="canvas-block__chart-mark canvas-chart__bar"
                        data-active={hover === index ? "true" : undefined}
                        height={Math.max(1, Math.abs(zero - coord.y))}
                        key={index}
                        rx={2}
                        width={barWidth}
                        x={coord.x - groupWidth / 2 + order * barWidth}
                        y={Math.min(zero, coord.y)}
                        {...markProps(
                          index,
                          `${item.series.label}: ${formatCanvasValue(coord.value, block.format)}`,
                        )}
                      />
                    );
                  })}
                </g>
              );
            }
            const curve = smoothPath(coords);
            const first = coords[0];
            const last = coords[coords.length - 1];
            const fillId = `${gradientId}-${series}`;
            // A lone line or area fades a wash of its own colour to the floor,
            // which reads as volume; several overlapping washes would muddy.
            const washed = block.chartType === "area" || visible.length === 1;
            return (
              <g
                className={seriesClass(item.index)}
                data-series={series}
                key={item.series.seriesId}
              >
                {washed &&
                block.chartType !== "scatter" &&
                first !== undefined &&
                last !== undefined ? (
                  <>
                    <defs>
                      <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
                        <stop
                          className="canvas-chart__wash-top"
                          data-kind={block.chartType}
                          offset="0"
                        />
                        <stop className="canvas-chart__wash-floor" offset="1" />
                      </linearGradient>
                    </defs>
                    <path
                      className="canvas-chart__wash"
                      d={`${curve} L ${String(last.x)} ${String(frame.bottom)} L ${String(first.x)} ${String(frame.bottom)} Z`}
                      data-kind={block.chartType}
                      fill={`url(#${fillId})`}
                    />
                  </>
                ) : null}
                {block.chartType === "scatter" ? null : (
                  <path className={`${mark} is-line`} d={curve} data-series={series} fill="none" />
                )}
                {coords.map((coord, index) =>
                  block.chartType === "scatter" ||
                  hover === index ||
                  index === coords.length - 1 ? (
                    <circle
                      className={`canvas-chart__dot ${seriesClass(item.index)}`}
                      cx={coord.x}
                      cy={coord.y}
                      data-active={hover === index ? "true" : undefined}
                      data-series={series}
                      key={index}
                      r={block.chartType === "scatter" ? 3 : 4}
                      {...markProps(
                        index,
                        `${item.series.label}: ${formatCanvasValue(coord.value, block.format)}`,
                      )}
                    />
                  ) : null,
                )}
              </g>
            );
          })}
        </svg>
        <ChartTooltip anchor={anchor} />
      </div>
    </div>
  );
}

/**
 * A lone line or area over time leads with where it ended and how far it
 * moved from where it began, which is what a reader looks for first. It quotes
 * the first and last readings only; with several series, or a first reading
 * of zero, there is no single honest change to state, so it says nothing.
 */
function TrendHeadline({ block }: { readonly block: CanvasChartBlock }) {
  if (block.chartType !== "line" && block.chartType !== "area") return null;
  const points = block.series.length === 1 ? (block.series[0]?.points ?? []) : [];
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined || points.length < 2) return null;
  const change = first.y === 0 ? undefined : ((last.y - first.y) / Math.abs(first.y)) * 100;
  const Arrow =
    change === undefined || change === 0 ? Minus : change > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="canvas-chart__headline">
      <span className="canvas-chart__headline-value">
        {formatCanvasValue(last.y, block.format)}
      </span>
      <span className="canvas-chart__headline-at">{String(last.x)}</span>
      {change === undefined ? null : (
        <span className="canvas-chart__headline-change">
          <Arrow aria-hidden="true" size={12} strokeWidth={2} />
          {`${change > 0 ? "+" : ""}${formatTick(Math.round(change))}% since ${String(first.x)}`}
        </span>
      )}
    </div>
  );
}

/** Room between the gutter and a line's first point, so it never sits on a label. */
const LINE_INSET = 12;

function pointX(frame: CartesianFrame, index: number, count: number, slotted: boolean): number {
  const span = frame.right - frame.left;
  if (slotted)
    return count <= 0 ? frame.left + span / 2 : frame.left + (span / count) * (index + 0.5);
  if (count <= 1) return frame.left + span / 2;
  return frame.left + LINE_INSET + (index / (count - 1)) * (span - LINE_INSET * 2);
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
      // Drawn at the figure's measured width by CartesianChart instead.
      return null;
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
                  item.index,
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
                  anchorFor(
                    x + barWidth / 2,
                    top,
                    item.series.label,
                    point.y,
                    interaction.format,
                    item.index,
                  ),
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
                  anchorFor(
                    x + barWidth / 2,
                    top,
                    item.series.label,
                    value,
                    interaction.format,
                    item.index,
                  ),
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
                  anchorFor(
                    x + barWidth / 2,
                    top,
                    item.series.label,
                    value,
                    interaction.format,
                    item.index,
                  ),
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
            () => anchorFor(coord.x, coord.y, label, coord.value, interaction.format, seriesIndex),
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
