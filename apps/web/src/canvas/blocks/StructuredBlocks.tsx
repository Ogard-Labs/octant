import type { CanvasBlock, CanvasChartSeries } from "@octant/contracts/canvas";
import { computeYDomain, scaleX, scaleY, type ChartSeriesData } from "../chartGeometry";
import { formatScalar } from "../canvasRuntime";
import { formatTableCell } from "./DataBlocks";

type Block = Extract<CanvasBlock, { readonly kind: "table" | "chart" | "timeline" | "diagram" }>;

const PLOT_WIDTH = 320;
const PLOT_HEIGHT = 160;
const INSET = 10;

export function StructuredBlocks({ block }: { readonly block: Block }) {
  switch (block.kind) {
    case "table":
      return <TableBlock block={block} />;
    case "chart":
      return <ChartBlock block={block} />;
    case "timeline":
      return <TimelineBlock block={block} />;
    case "diagram":
      return <DiagramBlock block={block} />;
  }
}

function TableBlock({ block }: { readonly block: Extract<Block, { readonly kind: "table" }> }) {
  return (
    <table className="canvas-block__table">
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

const palette = ["#8ab4f8", "#7bc47f", "#f2b26b", "#e78fc3", "#7fd1c7", "#c7c7c7"] as const;

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
            color={palette[seriesIndex % palette.length] ?? "#8ab4f8"}
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

function DiagramBlock({ block }: { readonly block: Extract<Block, { readonly kind: "diagram" }> }) {
  const positions = new Map<string, { x: number; y: number }>();
  block.nodes.forEach((node, index) => {
    positions.set(node.nodeId, {
      x: node.x ?? scaleX(index, block.nodes.length, 280, 20),
      y: node.y ?? 60 + (index % 3) * 28,
    });
  });

  return (
    <figure
      role="img"
      aria-label={`Diagram with ${block.nodes.length} nodes and ${block.edges.length} edges`}
      className="canvas-block__diagram"
    >
      <svg role="presentation" width={280} height={140} viewBox="0 0 280 140">
        {block.edges.map((edge) => {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (source === undefined || target === undefined) return null;
          return (
            <g key={edge.edgeId}>
              <line
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                className="canvas-block__diagram-edge"
              />
              {edge.label !== undefined ? (
                <text
                  x={(source.x + target.x) / 2}
                  y={(source.y + target.y) / 2}
                  className="canvas-block__diagram-edge-label"
                >
                  {edge.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {block.nodes.map((node) => {
          const position = positions.get(node.nodeId);
          if (position === undefined) return null;
          return (
            <g key={node.nodeId} className="canvas-block__diagram-node">
              <circle cx={position.x} cy={position.y} r={14} />
            </g>
          );
        })}
      </svg>
      <figcaption className="canvas-block__diagram-fallback">
        <ul>
          {block.nodes.map((node) => (
            <li key={node.nodeId}>{node.label}</li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toISOString();
}
