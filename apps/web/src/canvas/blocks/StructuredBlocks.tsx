import { CANVAS_CHART_PALETTE } from "@octant/theme";
import type { CanvasBlock, CanvasChartSeries } from "@octant/contracts/canvas";
import { computeYDomain, scaleX, scaleY, type ChartSeriesData } from "../chartGeometry";
import { formatScalar } from "../canvasRuntime";
import { DiagramBoard, type DiagramBoardLayoutRuntime } from "./DiagramBoard";
import { formatTableCell } from "./DataBlocks";

type Block = Extract<CanvasBlock, { readonly kind: "table" | "chart" | "timeline" | "diagram" }>;

const PLOT_WIDTH = 320;
const PLOT_HEIGHT = 160;
const INSET = 10;

export function StructuredBlocks({
  block,
  layoutRuntime,
}: {
  readonly block: Block;
  readonly layoutRuntime?: DiagramBoardLayoutRuntime;
}) {
  switch (block.kind) {
    case "table":
      return <TableBlock block={block} />;
    case "chart":
      return <ChartBlock block={block} />;
    case "timeline":
      return <TimelineBlock block={block} />;
    case "diagram":
      return (
        <DiagramBlock block={block} {...(layoutRuntime === undefined ? {} : { layoutRuntime })} />
      );
  }
}

function TableBlock({ block }: { readonly block: Extract<Block, { readonly kind: "table" }> }) {
  return (
    <table className="ds-table">
      <thead>
        <tr>
          {block.columns.map((column) => (
            <th key={column.id} scope="col">
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {block.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex}>{formatTableCell(cell)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ChartBlock({ block }: { readonly block: Extract<Block, { readonly kind: "chart" }> }) {
  const data: ChartSeriesData[] = block.series.map((item) => ({
    seriesId: item.seriesId,
    label: item.label,
    points: item.points,
  }));
  const domain = computeYDomain(data);

  return (
    <figure
      role="img"
      aria-label={`${block.chartType} chart with ${block.series.length} series`}
      className={`canvas-block__chart canvas-block__chart--${block.chartType}`}
    >
      <svg
        role="presentation"
        width={PLOT_WIDTH}
        height={PLOT_HEIGHT}
        viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
      >
        {block.series.map((series, seriesIndex) => (
          <SeriesShapes
            key={series.seriesId}
            chartType={block.chartType}
            series={series}
            domain={domain}
            color={
              CANVAS_CHART_PALETTE[seriesIndex % CANVAS_CHART_PALETTE.length] ??
              CANVAS_CHART_PALETTE[0]
            }
          />
        ))}
      </svg>
      <figcaption className="canvas-block__chart-fallback">
        {block.series.map((series) => (
          <ul key={series.seriesId} aria-label={series.label ?? series.seriesId}>
            {series.points.map((point, index) => (
              <li key={index}>
                {String(point.x)}: {formatScalar(point.y)}
              </li>
            ))}
          </ul>
        ))}
      </figcaption>
    </figure>
  );
}

function SeriesShapes({
  chartType,
  series,
  domain,
  color,
}: {
  readonly chartType: string;
  readonly series: CanvasChartSeries;
  readonly domain: { min: number; max: number };
  readonly color: string;
}) {
  const count = series.points.length;
  const coords = series.points.map((point, index) => ({
    x: scaleX(index, count, PLOT_WIDTH, INSET),
    y: scaleY(point.y, domain, PLOT_HEIGHT, INSET),
  }));
  const points = coords.map((c) => `${c.x},${c.y}`).join(" ");

  if (chartType === "line") {
    return <polyline points={points} fill="none" stroke={color} strokeWidth={2} />;
  }
  if (chartType === "area") {
    const baseY = PLOT_HEIGHT - INSET;
    const path = `M ${coords[0]?.x ?? 0} ${baseY} L ${points.replaceAll(" ", " L ")} L ${coords[coords.length - 1]?.x ?? 0} ${baseY} Z`;
    return <path d={path} fill={color} opacity={0.25} />;
  }
  if (chartType === "scatter") {
    return (
      <g fill={color}>
        {coords.map((c, index) => (
          <circle key={index} cx={c.x} cy={c.y} r={3} />
        ))}
      </g>
    );
  }
  const barWidth = count > 0 ? Math.max(2, PLOT_WIDTH / count / 2) : 2;
  return (
    <g fill={color}>
      {coords.map((c, index) => (
        <rect
          key={index}
          x={c.x - barWidth / 2}
          y={c.y}
          width={barWidth}
          height={PLOT_HEIGHT - INSET - c.y}
        />
      ))}
    </g>
  );
}

function TimelineBlock({
  block,
}: {
  readonly block: Extract<Block, { readonly kind: "timeline" }>;
}) {
  return (
    <ol className="canvas-block__timeline">
      {block.items.map((item) => (
        <li
          key={item.itemId}
          className={`canvas-block__timeline-item${item.status !== undefined ? ` canvas-block__timeline-item--${item.status}` : ""}`}
        >
          <time dateTime={item.startAt}>{formatDate(item.startAt)}</time>
          <strong>{item.title}</strong>
          {item.status !== undefined ? (
            <span className="canvas-block__timeline-status">{item.status}</span>
          ) : null}
          {item.detail !== undefined ? <p>{item.detail}</p> : null}
        </li>
      ))}
    </ol>
  );
}

function DiagramBlock({
  block,
  layoutRuntime,
}: {
  readonly block: Extract<Block, { readonly kind: "diagram" }>;
  readonly layoutRuntime?: DiagramBoardLayoutRuntime;
}) {
  return (
    <figure aria-label={diagramLabel(block)} className="canvas-block__diagram">
      <DiagramBoard block={block} {...(layoutRuntime === undefined ? {} : { layoutRuntime })} />
      {/* The drawing said in words, for a reader who cannot see it. The labels
        are already on the boxes, so this describes what connects to what rather
        than repeating the names on their own. */}
      <figcaption className="canvas-block__diagram-fallback visually-hidden">
        <ul>
          {(block.groups ?? []).map((group) => (
            <li key={group.groupId}>{`${group.label}: ${groupMembers(block, group.nodeIds)}`}</li>
          ))}
          {block.edges.map((edge) => (
            <li key={edge.edgeId}>{describeEdge(block, edge)}</li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

function nodeLabel(block: Extract<Block, { readonly kind: "diagram" }>, nodeId: string): string {
  return (
    block.nodes.find((node) => String(node.nodeId) === String(nodeId))?.label ?? String(nodeId)
  );
}

function groupMembers(
  block: Extract<Block, { readonly kind: "diagram" }>,
  nodeIds: ReadonlyArray<string>,
): string {
  return nodeIds.map((nodeId) => nodeLabel(block, nodeId)).join(", ");
}

function describeEdge(
  block: Extract<Block, { readonly kind: "diagram" }>,
  edge: Extract<Block, { readonly kind: "diagram" }>["edges"][number],
): string {
  const relation = edge.label === undefined ? "to" : edge.label;
  return `${nodeLabel(block, edge.source)} ${relation} ${nodeLabel(block, edge.target)}`;
}

function diagramLabel(block: Extract<Block, { readonly kind: "diagram" }>): string {
  const groups = block.groups ?? [];
  const parts = [
    `Diagram with ${String(block.nodes.length)} nodes and ${String(block.edges.length)} edges`,
  ];
  if (groups.length > 0) parts.push(`in ${String(groups.length)} groups`);
  return parts.join(" ");
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toISOString();
}
