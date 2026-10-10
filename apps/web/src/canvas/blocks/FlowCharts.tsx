import { useState, type SVGAttributes } from "react";
import type { CanvasChartBlock } from "@octant/contracts/canvas";
import { layoutCanvasSankey, sankeyNodeLabels } from "@octant/domain/canvas-sankey-layout";
import { ChartTooltip, type ChartTooltipAnchor } from "../ChartTooltip";
import { formatTick, niceAxis } from "../chartGeometry";
import { formatCanvasValue } from "../canvasRuntime";

/**
 * Funnel, radar, and sankey charts.
 *
 * They draw at the figure's measured width like a line or bar chart, in the
 * same shared style: hue only on the marks, labels in text ink, one tooltip
 * placed from the mark, and every reading in the disclosed table. Above the
 * interactive cap the marks still show the tooltip under the pointer, but the
 * keyboard reads the table instead of walking a tab stop per mark.
 */

const MAX_INTERACTIVE_MARKS = 24;

function seriesClass(index: number): string {
  return `ser-${String((index % 6) + 1)}`;
}

function seriesAttr(index: number): string {
  return String(index % 6);
}

/** A label cut to the characters its room holds, with an ellipsis when cut. */
function fitLabel(label: string, room: number): string {
  const chars = Math.max(3, Math.floor(room / 7));
  return label.length <= chars ? label : `${label.slice(0, chars - 1)}…`;
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const value = Math.round((part / whole) * 1000) / 10;
  return Number.isInteger(value) ? `${String(value)}%` : `${value.toFixed(1)}%`;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function readable(
  keyboard: boolean,
  label: string,
  show: () => void,
  hide: () => void,
): SVGAttributes<SVGElement> {
  return {
    ...(keyboard ? { tabIndex: 0, "aria-label": label } : {}),
    onPointerEnter: show,
    onPointerLeave: hide,
    onFocus: show,
    onBlur: hide,
  };
}

export function isFlowChart(type: CanvasChartBlock["chartType"]): boolean {
  return type === "funnel" || type === "radar" || type === "sankey";
}

export function FlowChart({
  block,
  hidden,
  width,
  label,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
  readonly width: number;
  readonly label: string;
}) {
  switch (block.chartType) {
    case "funnel":
      return <FunnelChart block={block} label={label} width={width} />;
    case "radar":
      return <RadarChart block={block} hidden={hidden} label={label} width={width} />;
    case "sankey":
      return <SankeyChart block={block} hidden={hidden} label={label} width={width} />;
    default:
      return null;
  }
}

const FUNNEL_ROW = 32;
const FUNNEL_GAP = 8;

/**
 * Stages top to bottom, each bar centred and as wide as its share of the first
 * stage, with a faint neck between neighbours so the drop-off reads as one
 * shape. The value and its share of the first stage sit at the right.
 */
function FunnelChart({
  block,
  width,
  label,
}: {
  readonly block: CanvasChartBlock;
  readonly width: number;
  readonly label: string;
}) {
  const [hover, setHover] = useState<number | undefined>(undefined);
  const series = block.series[0];
  const points = series?.points ?? [];
  const first = points[0]?.y ?? 0;
  const labelWidth = width < 480 ? Math.min(112, width * 0.3) : 168;
  const valueWidth = 104;
  const barLeft = labelWidth + 8;
  const barRoom = Math.max(24, width - labelWidth - valueWidth - 16);
  const height = Math.max(
    FUNNEL_ROW,
    points.length * FUNNEL_ROW + (points.length - 1) * FUNNEL_GAP,
  );
  const keyboard = points.length <= MAX_INTERACTIVE_MARKS;
  const bars = points.map((point, index) => {
    const barWidth = Math.max(2, clampUnit(first > 0 ? point.y / first : 0) * barRoom);
    const top = index * (FUNNEL_ROW + FUNNEL_GAP);
    return { point, index, top, x: barLeft + (barRoom - barWidth) / 2, width: barWidth };
  });
  const reading = (index: number) => {
    const point = points[index];
    if (point === undefined) return "";
    const previous = points[index - 1]?.y;
    const share = `${percent(point.y, first)} of ${String(points[0]?.x ?? "")}`;
    return previous === undefined
      ? formatCanvasValue(point.y, block.format)
      : `${formatCanvasValue(point.y, block.format)}, ${share}, ${percent(point.y, previous)} of the stage before`;
  };
  const hovered = hover === undefined ? undefined : bars[hover];
  const anchor: ChartTooltipAnchor | undefined =
    hovered === undefined
      ? undefined
      : {
          caption: String(hovered.point.x),
          readings: [
            {
              seriesIndex: 0,
              seriesLabel: series?.label ?? "",
              valueLabel: reading(hovered.index),
            },
          ],
          x: width > 0 ? clampUnit((hovered.x + hovered.width / 2) / width) : 0,
          y: clampUnit(hovered.top / height),
        };

  return (
    <div className="canvas-chart">
      <div className="canvas-chart__plot">
        <svg
          aria-label={label}
          className="canvas-chart__svg"
          height={height}
          role="img"
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          width={width}
        >
          {bars.slice(1).map((bar) => {
            const above = bars[bar.index - 1];
            if (above === undefined) return null;
            const y0 = above.top + FUNNEL_ROW;
            const y1 = bar.top;
            return (
              <polygon
                aria-hidden="true"
                className={`canvas-chart__funnel-neck ${seriesClass(0)}`}
                key={`neck-${String(bar.index)}`}
                points={`${String(above.x)},${String(y0)} ${String(above.x + above.width)},${String(y0)} ${String(bar.x + bar.width)},${String(y1)} ${String(bar.x)},${String(y1)}`}
              />
            );
          })}
          {bars.map((bar) => (
            <g key={bar.index}>
              <text
                aria-hidden="true"
                className="canvas-chart__category"
                dominantBaseline="middle"
                x={0}
                y={bar.top + FUNNEL_ROW / 2}
              >
                {fitLabel(String(bar.point.x), labelWidth)}
              </text>
              <rect
                className={`canvas-block__chart-mark canvas-chart__bar ${seriesClass(0)}`}
                data-active={hover === bar.index ? "true" : undefined}
                data-series={seriesAttr(0)}
                height={FUNNEL_ROW}
                rx={2}
                width={bar.width}
                x={bar.x}
                y={bar.top}
                {...readable(
                  keyboard,
                  `${String(bar.point.x)}: ${reading(bar.index)}`,
                  () => setHover(bar.index),
                  () => setHover(undefined),
                )}
              />
              <text
                aria-hidden="true"
                className="canvas-chart__reading"
                dominantBaseline="middle"
                textAnchor="end"
                x={width}
                y={bar.top + FUNNEL_ROW / 2}
              >
                {formatCanvasValue(bar.point.y, block.format)}
                <tspan className="canvas-chart__reading-share">{` ${percent(bar.point.y, first)}`}</tspan>
              </text>
            </g>
          ))}
        </svg>
        <ChartTooltip anchor={anchor} />
      </div>
    </div>
  );
}

/** Room around a radar for its axis labels, and the size it never grows past. */
const RADAR_LABEL_ROOM = 40;
const RADAR_MAX_SIZE = 360;

/**
 * Series compared on the same axes around one centre. Rings mark round values
 * from zero; each series is an outline in its hue and dash with a faint fill,
 * and a vertex per axis names its reading. Every visible series at the focused
 * axis reads through the one tooltip.
 */
function RadarChart({
  block,
  hidden,
  width,
  label,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
  readonly width: number;
  readonly label: string;
}) {
  const [hover, setHover] = useState<number | undefined>(undefined);
  const axes = block.series[0]?.points.map((point) => String(point.x)) ?? [];
  const visible = block.series
    .map((series, index) => ({ series, index }))
    .filter((item) => !hidden.has(item.series.seriesId));
  const peak = Math.max(0, ...visible.flatMap((item) => item.series.points.map((p) => p.y)));
  const axis = niceAxis({ min: 0, max: peak }, true, 4);
  const max = axis.domain.max > 0 ? axis.domain.max : 1;
  const size = Math.min(width, RADAR_MAX_SIZE);
  const height = size;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.max(16, size / 2 - RADAR_LABEL_ROOM);
  const angle = (index: number) => -Math.PI / 2 + (index / Math.max(1, axes.length)) * Math.PI * 2;
  const at = (index: number, value: number) => {
    const share = clampUnit(value / max);
    return {
      x: cx + Math.cos(angle(index)) * radius * share,
      y: cy + Math.sin(angle(index)) * radius * share,
    };
  };
  const ring = (value: number) =>
    axes
      .map((_axis, index) => {
        const point = at(index, value);
        return `${String(point.x)},${String(point.y)}`;
      })
      .join(" ");
  const markCount = block.series.length * axes.length;
  const keyboard = markCount <= MAX_INTERACTIVE_MARKS;
  const anchor: ChartTooltipAnchor | undefined =
    hover === undefined
      ? undefined
      : (() => {
          const tops = visible.map((item) => at(hover, item.series.points[hover]?.y ?? 0));
          const top = tops.reduce((best, point) => (point.y < best.y ? point : best), {
            x: cx,
            y: cy,
          });
          return {
            caption: axes[hover] ?? "",
            readings: visible.map((item) => ({
              seriesIndex: item.index,
              seriesLabel: item.series.label,
              valueLabel: formatCanvasValue(item.series.points[hover]?.y ?? 0, block.format),
            })),
            x: width > 0 ? clampUnit(top.x / width) : 0,
            y: clampUnit(top.y / height),
          };
        })();

  return (
    <div className="canvas-chart">
      <div className="canvas-chart__plot">
        <svg
          aria-label={label}
          className="canvas-chart__svg"
          height={height}
          role="img"
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          width={width}
        >
          <g aria-hidden="true">
            {axis.ticks
              .filter((tick) => tick > 0)
              .map((tick) => (
                <polygon
                  className="canvas-chart__grid"
                  fill="none"
                  key={tick}
                  points={ring(tick)}
                />
              ))}
            {axes.map((name, index) => {
              const end = at(index, max);
              const cos = Math.cos(angle(index));
              const sin = Math.sin(angle(index));
              const labelX = cx + cos * (radius + 10);
              const labelY = cy + sin * (radius + 10);
              return (
                <g key={name}>
                  <line
                    className={hover === index ? "canvas-chart__guide" : "canvas-chart__grid"}
                    x1={cx}
                    x2={end.x}
                    y1={cy}
                    y2={end.y}
                  />
                  <text
                    className="canvas-chart__category"
                    dominantBaseline={sin > 0.3 ? "hanging" : sin < -0.3 ? "auto" : "middle"}
                    textAnchor={cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle"}
                    x={labelX}
                    y={labelY}
                  >
                    {fitLabel(name, RADAR_LABEL_ROOM * 2.4)}
                  </text>
                </g>
              );
            })}
            {axis.ticks
              .filter((tick) => tick > 0)
              .map((tick) => (
                <text
                  className="canvas-chart__tick"
                  dominantBaseline="middle"
                  key={`tick-${String(tick)}`}
                  x={cx + 4}
                  y={at(0, tick).y}
                >
                  {formatTick(tick, axis.step)}
                </text>
              ))}
          </g>
          {visible.map((item) => {
            const outline = item.series.points
              .map((point, index) => {
                const xy = at(index, point.y);
                return `${String(xy.x)},${String(xy.y)}`;
              })
              .join(" ");
            return (
              <g
                className={seriesClass(item.index)}
                data-series={seriesAttr(item.index)}
                key={item.series.seriesId}
              >
                <polygon
                  className={`canvas-block__chart-mark canvas-chart__radar-area ${seriesClass(item.index)}`}
                  data-series={seriesAttr(item.index)}
                  points={outline}
                />
                <polygon
                  className={`canvas-block__chart-mark is-line ${seriesClass(item.index)}`}
                  data-series={seriesAttr(item.index)}
                  fill="none"
                  points={outline}
                />
                {item.series.points.map((point, index) => {
                  const xy = at(index, point.y);
                  return (
                    <circle
                      className={`canvas-chart__dot ${seriesClass(item.index)}`}
                      cx={xy.x}
                      cy={xy.y}
                      data-active={hover === index ? "true" : undefined}
                      data-series={seriesAttr(item.index)}
                      key={index}
                      r={hover === index ? 4 : 3}
                      {...readable(
                        keyboard,
                        `${item.series.label}, ${String(point.x)}: ${formatCanvasValue(point.y, block.format)}`,
                        () => setHover(index),
                        () => setHover(undefined),
                      )}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
        <ChartTooltip anchor={anchor} />
      </div>
    </div>
  );
}

const SANKEY_NODE_WIDTH = 10;
const SANKEY_ROW = 36;
const SANKEY_MAX_HEIGHT = 440;
/** The least room between two columns, so a long chain stays apart and scrolls. */
const SANKEY_MIN_COLUMN_GAP = 56;
/** A crowded column closes its gaps and keeps each node at least this tall. */
const SANKEY_DENSE_GAP = 4;
const SANKEY_MIN_NODE = 4;

/** The legend id a sankey node toggles under, kept apart from a series id. */
export function sankeyNodeId(label: string): string {
  return `node:${label}`;
}

/**
 * Flows between named nodes as bands, left to right. A band takes the hue of
 * the node it leaves, so a reader can follow a source through to its endings;
 * a node's label and total sit beside it in text ink. Hiding a node in the
 * legend removes every flow that touches it.
 */
function SankeyChart({
  block,
  hidden,
  width: columnWidth,
  label,
}: {
  readonly block: CanvasChartBlock;
  readonly hidden: ReadonlySet<string>;
  readonly width: number;
  readonly label: string;
}) {
  const [hover, setHover] = useState<
    { readonly kind: "link" | "node"; readonly index: number } | undefined
  >(undefined);
  const allLinks = block.links ?? [];
  // Hues follow the node, not its rank among what is shown, so hiding one node
  // never repaints the others.
  const hueOf = new Map(sankeyNodeLabels(allLinks).map((name, index) => [name, index]));
  const links = allLinks.filter(
    (link) => !hidden.has(sankeyNodeId(link.source)) && !hidden.has(sankeyNodeId(link.target)),
  );
  const probe = layoutCanvasSankey(links, { width: columnWidth, height: 100 });
  const tallest = Math.max(
    1,
    ...Array.from(
      { length: probe.columns },
      (_value, column) => probe.nodes.filter((node) => node.column === column).length,
    ),
  );
  // A column of many nodes closes its gaps, and the picture grows past its
  // usual cap rather than squeezing a node to nothing; a chain of many columns
  // draws wider than the figure and scrolls, rather than stacking its columns.
  const nodeGap = tallest > 12 ? SANKEY_DENSE_GAP : 10;
  const height = Math.max(
    Math.min(SANKEY_MAX_HEIGHT, Math.max(200, tallest * SANKEY_ROW)),
    tallest * (nodeGap + SANKEY_MIN_NODE),
  );
  const width = Math.max(
    columnWidth,
    (probe.columns - 1) * SANKEY_MIN_COLUMN_GAP + SANKEY_NODE_WIDTH,
  );
  const layout = layoutCanvasSankey(links, {
    width,
    height,
    nodeWidth: SANKEY_NODE_WIDTH,
    nodeGap,
  });
  const keyboard = layout.links.length + layout.nodes.length <= MAX_INTERACTIVE_MARKS;
  const hue = (name: string) => hueOf.get(name) ?? 0;
  const nodeReading = (inflow: number, outflow: number) =>
    [
      inflow > 0 ? `in ${formatCanvasValue(inflow, block.format)}` : "",
      outflow > 0 ? `out ${formatCanvasValue(outflow, block.format)}` : "",
    ]
      .filter((part) => part !== "")
      .join(", ");
  const anchor: ChartTooltipAnchor | undefined = (() => {
    if (hover === undefined || width <= 0) return undefined;
    if (hover.kind === "link") {
      const link = layout.links[hover.index];
      if (link === undefined) return undefined;
      return {
        caption: `${link.source} → ${link.target}`,
        readings: [
          {
            seriesIndex: hue(link.source),
            seriesLabel: link.source,
            valueLabel: formatCanvasValue(link.value, block.format),
          },
        ],
        x: clampUnit((link.x0 + link.x1) / 2 / width),
        y: clampUnit(Math.min(link.y0, link.y1) / height),
      };
    }
    const node = layout.nodes[hover.index];
    if (node === undefined) return undefined;
    return {
      readings: [
        {
          seriesIndex: hue(node.label),
          seriesLabel: node.label,
          valueLabel: nodeReading(node.inflow, node.outflow),
        },
      ],
      x: clampUnit((node.x + node.width / 2) / width),
      y: clampUnit(node.y / height),
    };
  })();

  return (
    <div className="canvas-chart">
      <div className="canvas-chart__scroll">
        <div className="canvas-chart__plot" style={{ width }}>
          <svg
            aria-label={label}
            className="canvas-chart__svg"
            height={height}
            role="img"
            viewBox={`0 0 ${String(width)} ${String(height)}`}
            width={width}
          >
            {layout.links.map((link, index) => (
              <path
                className={`canvas-block__chart-mark canvas-chart__flow ${seriesClass(hue(link.source))}`}
                d={link.path}
                data-active={
                  (hover?.kind === "link" && hover.index === index) ||
                  (hover?.kind === "node" &&
                    (layout.nodes[hover.index]?.label === link.source ||
                      layout.nodes[hover.index]?.label === link.target))
                    ? "true"
                    : undefined
                }
                data-series={seriesAttr(hue(link.source))}
                key={`${link.source}→${link.target}`}
                {...readable(
                  keyboard,
                  `${link.source} to ${link.target}: ${formatCanvasValue(link.value, block.format)}`,
                  () => setHover({ kind: "link", index }),
                  () => setHover(undefined),
                )}
              />
            ))}
            {layout.nodes.map((node, index) => {
              const last = node.column === layout.columns - 1 && layout.columns > 1;
              const total = formatCanvasValue(Math.max(node.inflow, node.outflow), block.format);
              const room = labelRoom(node.column, layout.columns, width);
              // A total joins the name only where both fit; the tooltip and the
              // table always carry it.
              const withTotal = room >= 140;
              const nameRoom = withTotal ? room - (total.length + 1) * 7 : room;
              return (
                <g key={node.label}>
                  <rect
                    className={`canvas-block__chart-mark canvas-chart__node ${seriesClass(hue(node.label))}`}
                    data-series={seriesAttr(hue(node.label))}
                    height={node.height}
                    rx={2}
                    width={node.width}
                    x={node.x}
                    y={node.y}
                    {...readable(
                      keyboard,
                      `${node.label}: ${nodeReading(node.inflow, node.outflow)}`,
                      () => setHover({ kind: "node", index }),
                      () => setHover(undefined),
                    )}
                  />
                  <text
                    aria-hidden="true"
                    className="canvas-chart__category"
                    dominantBaseline="middle"
                    textAnchor={last ? "end" : "start"}
                    x={last ? node.x - 6 : node.x + node.width + 6}
                    y={node.y + node.height / 2}
                  >
                    {fitLabel(node.label, nameRoom)}
                    {withTotal ? (
                      <tspan className="canvas-chart__reading-share">{` ${total}`}</tspan>
                    ) : null}
                  </text>
                </g>
              );
            })}
          </svg>
          <ChartTooltip anchor={anchor} />
        </div>
      </div>
    </div>
  );
}

/**
 * How wide a node's label may run. A label reads into the gap after its node,
 * and the last column's labels read back into the gap before it, so the two
 * columns either side of that gap share it rather than writing over each other.
 */
function labelRoom(column: number, columns: number, width: number): number {
  if (columns <= 1) return Math.max(0, width - SANKEY_NODE_WIDTH - 12);
  const gap = (width - SANKEY_NODE_WIDTH) / (columns - 1) - SANKEY_NODE_WIDTH;
  const shared = column >= columns - 2;
  return Math.max(28, (shared ? gap / 2 : gap) - 12);
}

/** Every flow, with each node's share of what leaves its source. */
export function FlowTable({ block }: { readonly block: CanvasChartBlock }) {
  const links = block.links ?? [];
  const outflow = new Map<string, number>();
  for (const link of links) {
    outflow.set(link.source, (outflow.get(link.source) ?? 0) + link.value);
  }
  return (
    <table aria-label="Chart readings" className="ds-table">
      <thead>
        <tr>
          <th scope="col">From</th>
          <th scope="col">To</th>
          <th scope="col">Flow</th>
          <th scope="col">Share of source</th>
        </tr>
      </thead>
      <tbody>
        {links.map((link) => (
          <tr key={`${link.source}→${link.target}`}>
            <th scope="row">{link.source}</th>
            <td>{link.target}</td>
            <td>{formatCanvasValue(link.value, block.format)}</td>
            <td>{percent(link.value, outflow.get(link.source) ?? 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Every stage, with its share of the first stage and of the stage before. */
export function StageTable({ block }: { readonly block: CanvasChartBlock }) {
  const points = block.series[0]?.points ?? [];
  const first = points[0]?.y ?? 0;
  return (
    <table aria-label="Chart readings" className="ds-table">
      <thead>
        <tr>
          <th scope="col">Stage</th>
          <th scope="col">Value</th>
          <th scope="col">Of first stage</th>
          <th scope="col">Of stage before</th>
        </tr>
      </thead>
      <tbody>
        {points.map((point, index) => {
          const previous = points[index - 1]?.y;
          return (
            <tr key={String(point.x)}>
              <th scope="row">{String(point.x)}</th>
              <td>{formatCanvasValue(point.y, block.format)}</td>
              <td>{percent(point.y, first)}</td>
              <td>{previous === undefined ? "—" : percent(point.y, previous)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
