import type { CanvasBlock } from "@octant/contracts/canvas";
import { formatCanvasNumber } from "@octant/domain/canvas-number-format";
import { layoutCanvasSankey } from "@octant/domain/canvas-sankey-layout";
import {
  CHART_BAR_GAP,
  CHART_BAR_RADIUS,
  CHART_DOT_RADIUS,
  CHART_GRID_LINE_COUNT,
  CHART_LINE_WIDTH,
  DEFAULT_LIGHT_TOKENS,
} from "@octant/theme";
import { escapeXml } from "./artifactRender";

/**
 * A Canvas chart as the HTML export draws it: plain SVG elements on the light
 * scheme, to the shared mark specifications, with no script, id, or reference
 * out. The thumbnail in `artifactRender` is a glance; this is the picture a
 * reader of an exported file reads instead of the screen, so it keeps the
 * axis, the gridlines, the readings a mark needs, and a legend. Every label a
 * chart carries passes `label`, which decides what text may leave the host.
 */
export interface CanvasExportDrawing {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly markup: string;
  /** Drawn under the picture as text, so it wraps on a narrow page. */
  readonly legend?: ReadonlyArray<CanvasExportLegendEntry>;
}

export interface CanvasExportLegendEntry {
  readonly label: string;
  readonly color: string;
  /** A line series' swatch is a stroke, dashed when its line is. */
  readonly line?: "solid" | "dashed";
}

type ChartBlock = Extract<CanvasBlock, { readonly kind: "chart" }>;
type Label = (value: string) => string;

const token = (id: string, fallback: string): string => DEFAULT_LIGHT_TOKENS[id] ?? fallback;

/**
 * The six series hues. The theme states that its palette follows the chart
 * series (yellow is series 1; teal, pink, purple, green, and blue follow), so
 * an export reads them from the theme rather than restating colours.
 */
export const EXPORT_SERIES_COLORS: ReadonlyArray<string> = [
  token("palette-yellow", "#8a6218"),
  token("palette-teal", "#0f6f68"),
  token("palette-pink", "#b3356e"),
  token("palette-purple", "#5b4bb0"),
  token("palette-green", "#41761c"),
  token("palette-blue", "#1e5fae"),
];
/** A line is also told apart by its dash, so colour is never the only difference. */
const SERIES_DASHES: ReadonlyArray<string | undefined> = [
  undefined,
  "6 3",
  "2 3",
  "9 3 2 3",
  "1 4",
  "12 4",
];
export const EXPORT_INK = token("text-primary", "#141414");
export const EXPORT_MUTED = token("text-muted", "#666666");
const AXIS = token("border-strong", "#bdbdbb");
const GRID = token("border", "#e0e0de");

const WIDTH = 560;
const PLOT_HEIGHT = 220;
const GUTTER_LEFT = 52;
const GUTTER_RIGHT = 12;
const GUTTER_TOP = 10;
const GUTTER_BOTTOM = 26;
const FONT = 12;

export function seriesColor(index: number): string {
  return EXPORT_SERIES_COLORS[index % EXPORT_SERIES_COLORS.length] ?? EXPORT_INK;
}

function seriesDash(index: number): string | undefined {
  return SERIES_DASHES[index % SERIES_DASHES.length];
}

export function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function svgText(
  x: number,
  y: number,
  value: string,
  options: {
    readonly anchor?: "start" | "middle" | "end";
    readonly fill?: string;
    readonly size?: number;
    readonly weight?: number;
  } = {},
): string {
  if (value.length === 0) return "";
  const anchor = options.anchor === undefined ? "" : ` text-anchor="${options.anchor}"`;
  const weight = options.weight === undefined ? "" : ` font-weight="${String(options.weight)}"`;
  return `<text x="${round(x)}" y="${round(y)}" font-size="${String(options.size ?? FONT)}" fill="${options.fill ?? EXPORT_MUTED}"${anchor}${weight}>${escapeXml(value)}</text>`;
}

/** A label cut to what its slot holds, with an ellipsis rather than a wrap. */
export function fit(value: string, characters: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  const room = Math.max(2, characters);
  return collapsed.length <= room ? collapsed : `${collapsed.slice(0, room - 1)}…`;
}

interface Axis {
  readonly min: number;
  readonly max: number;
  readonly ticks: ReadonlyArray<number>;
}

/** Round gridlines (1, 2, 2.5, or 5 times a power of ten) that enclose every reading. */
function niceAxis(min: number, max: number, includeZero: boolean): Axis {
  let low = includeZero ? Math.min(0, min) : min;
  let high = includeZero ? Math.max(0, max) : max;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { min: 0, max: 1, ticks: [0, 1] };
  const scale = Math.max(Math.abs(low), Math.abs(high));
  if (high - low <= Math.max(Number.EPSILON, scale * 1e-9)) {
    const pad = scale <= Number.EPSILON ? 1 : scale * 0.1;
    low -= pad;
    high += pad;
  }
  const rough = (high - low) / CHART_GRID_LINE_COUNT;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((value) => value >= rough) ??
    10 * magnitude;
  if (!Number.isFinite(step) || step <= 0) return { min: 0, max: 1, ticks: [0, 1] };
  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const count = Math.round((end - start) / step);
  const ticks: number[] = [];
  for (let index = 0; index <= count; index += 1) {
    ticks.push(Number((start + index * step).toFixed(decimals)));
  }
  return { min: start, max: end, ticks };
}

function categoryText(x: number | string, block: ChartBlock, label: Label): string {
  return typeof x === "number" ? formatCanvasNumber(x, block.format) : label(x);
}

/**
 * The chart's picture, or undefined when it has nothing to draw. The reading
 * the export writes beside it carries every value either way.
 */
export function drawCanvasExportChart(
  block: ChartBlock,
  label: Label,
): CanvasExportDrawing | undefined {
  switch (block.chartType) {
    case "pie":
    case "donut":
      return partToWhole(block, label);
    case "funnel":
      return funnel(block, label);
    case "radar":
      return radar(block, label);
    case "sankey":
      return sankey(block, label);
    case "line":
    case "area":
    case "bar":
    case "scatter":
    case "distribution":
    case "stacked-bar":
    case "grouped-bar":
    case "bar-line":
      return cartesian(block, label);
    default: {
      const unhandled: never = block.chartType;
      return unhandled;
    }
  }
}

function legendFor(block: ChartBlock, label: Label): ReadonlyArray<CanvasExportLegendEntry> {
  // One series is named by the Canvas around it, as on screen.
  if (block.series.length < 2) return [];
  return block.series.map((series, index) => {
    const line =
      block.chartType === "line" ||
      block.chartType === "area" ||
      block.chartType === "radar" ||
      (block.chartType === "bar-line" && series.mark === "line");
    return {
      label: label(series.label),
      color: seriesColor(index),
      ...(line ? { line: seriesDash(index) === undefined ? "solid" : "dashed" } : {}),
    };
  });
}

function cartesian(block: ChartBlock, label: Label): CanvasExportDrawing | undefined {
  const first = block.series[0];
  if (first === undefined) return undefined;
  const stacked = block.chartType === "stacked-bar";
  const numericX =
    block.chartType === "scatter" &&
    block.series.every((s) => s.points.every((p) => typeof p.x === "number"));
  const count = Math.max(...block.series.map((series) => series.points.length));
  const values = block.series.flatMap((series) => series.points.map((point) => point.y));
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (stacked) {
    const totals = first.points.map((_point, index) =>
      block.series.reduce((sum, series) => sum + Math.max(0, series.points[index]?.y ?? 0), 0),
    );
    low = 0;
    high = Math.max(...totals);
  }
  // Lines and areas run edge to edge; bars and categorical points sit in the
  // middle of their band. Bars and areas measure from zero.
  const edgeToEdge = block.chartType === "line" || block.chartType === "area";
  const axis = niceAxis(low, high, block.chartType !== "line" && block.chartType !== "scatter");
  const left = GUTTER_LEFT;
  const right = WIDTH - GUTTER_RIGHT;
  const top = GUTTER_TOP;
  const bottom = GUTTER_TOP + PLOT_HEIGHT;
  const y = (value: number) =>
    bottom - ((value - axis.min) / (axis.max - axis.min || 1)) * (bottom - top);
  const xs = numericX ? block.series.flatMap((s) => s.points.map((p) => Number(p.x))) : [];
  const xAxis = numericX ? niceAxis(Math.min(...xs), Math.max(...xs), false) : undefined;
  const band = (right - left) / Math.max(1, count);
  const xAt = (index: number, raw: number | string): number => {
    if (xAxis !== undefined && typeof raw === "number") {
      return left + ((raw - xAxis.min) / (xAxis.max - xAxis.min || 1)) * (right - left);
    }
    if (edgeToEdge) {
      return count <= 1 ? (left + right) / 2 : left + (index / (count - 1)) * (right - left);
    }
    return left + band * (index + 0.5);
  };
  const parts: string[] = [];
  for (const tick of axis.ticks) {
    const at = y(tick);
    parts.push(
      `<line x1="${round(left)}" x2="${round(right)}" y1="${round(at)}" y2="${round(at)}" stroke="${tick === 0 ? AXIS : GRID}" stroke-width="1"/>`,
      svgText(left - 6, at + 4, formatCanvasNumber(tick, block.format), { anchor: "end" }),
    );
  }
  // Category labels along the bottom, thinned so neighbours never overlap.
  const labelEvery = Math.max(1, Math.ceil(count / Math.max(1, Math.floor((right - left) / 56))));
  if (xAxis === undefined) {
    first.points.forEach((point, index) => {
      if (index % labelEvery !== 0) return;
      parts.push(
        svgText(xAt(index, point.x), bottom + 16, fit(categoryText(point.x, block, label), 12), {
          anchor: "middle",
        }),
      );
    });
  } else {
    for (const tick of xAxis.ticks) {
      parts.push(
        svgText(xAt(0, tick), bottom + 16, formatCanvasNumber(tick, block.format), {
          anchor: "middle",
        }),
      );
    }
  }

  const bars = block.series
    .map((series, index) => ({ series, index }))
    .filter(({ series }) =>
      block.chartType === "bar-line"
        ? series.mark === "bar"
        : block.chartType === "bar" ||
          block.chartType === "distribution" ||
          block.chartType === "grouped-bar" ||
          block.chartType === "stacked-bar",
    );
  const lines = block.series
    .map((series, index) => ({ series, index }))
    .filter(({ series }) =>
      block.chartType === "bar-line"
        ? series.mark === "line"
        : block.chartType === "line" || block.chartType === "area",
    );

  if (bars.length > 0) {
    // A distribution's bars touch because the density is the subject; every
    // other bar keeps the shared gap.
    const gap = block.chartType === "distribution" ? 0 : CHART_BAR_GAP;
    const inner = block.chartType === "distribution" ? band : band * 0.6;
    const groups = stacked ? 1 : bars.length;
    const width = Math.max(1, (inner - gap * (groups - 1)) / groups);
    const base = y(Math.max(axis.min, Math.min(axis.max, 0)));
    for (let index = 0; index < count; index += 1) {
      let stackTop = base;
      bars.forEach(({ series, index: seriesIndex }, position) => {
        const value = series.points[index]?.y;
        if (value === undefined) return;
        const x =
          left + band * index + (band - inner) / 2 + (stacked ? 0 : position * (width + gap));
        let from: number;
        let to: number;
        if (stacked) {
          to = stackTop;
          from = stackTop - (base - y(Math.max(0, value)));
          stackTop = from;
        } else {
          from = Math.min(y(value), base);
          to = Math.max(y(value), base);
        }
        const height = Math.max(0, to - from);
        if (height <= 0) return;
        // As on screen, a series that emphasizes a reading leaves its other
        // bars in the muted ink.
        const muted =
          series.points.some((point) => point.emphasis === true) &&
          series.points[index]?.emphasis !== true;
        parts.push(
          `<rect x="${round(x)}" y="${round(from)}" width="${round(width)}" height="${round(height)}" rx="${String(Math.min(CHART_BAR_RADIUS, width / 2))}" fill="${muted ? AXIS : seriesColor(seriesIndex)}"/>`,
        );
      });
    }
  }

  for (const { series, index } of lines) {
    const points = series.points.map((point, position) => ({
      x: xAt(position, point.x),
      y: y(point.y),
    }));
    const path = points
      .map((point, position) => `${position === 0 ? "M" : "L"}${round(point.x)} ${round(point.y)}`)
      .join(" ");
    const color = seriesColor(index);
    if (block.chartType === "area") {
      const baseline = y(Math.max(axis.min, 0));
      const last = points.at(-1);
      const firstPoint = points[0];
      if (last !== undefined && firstPoint !== undefined) {
        parts.push(
          `<path d="${path} L${round(last.x)} ${round(baseline)} L${round(firstPoint.x)} ${round(baseline)} Z" fill="${color}" fill-opacity="0.16"/>`,
        );
      }
    }
    const dash = seriesDash(index);
    parts.push(
      `<path d="${path}" fill="none" stroke="${color}" stroke-width="${String(CHART_LINE_WIDTH)}" stroke-linecap="round" stroke-linejoin="round"${dash === undefined ? "" : ` stroke-dasharray="${dash}"`}/>`,
    );
    for (const point of points) {
      parts.push(
        `<circle cx="${round(point.x)}" cy="${round(point.y)}" r="${String(CHART_DOT_RADIUS)}" fill="${color}"/>`,
      );
    }
  }

  if (block.chartType === "scatter") {
    block.series.forEach((series, index) => {
      series.points.forEach((point, position) => {
        parts.push(
          `<circle cx="${round(xAt(position, point.x))}" cy="${round(y(point.y))}" r="${String(CHART_DOT_RADIUS + 1)}" fill="${seriesColor(index)}" fill-opacity="0.85"/>`,
        );
      });
    });
  }

  // The author's callouts, in the text ink just above the point they name.
  if (
    block.chartType === "line" ||
    block.chartType === "area" ||
    block.chartType === "scatter" ||
    block.chartType === "bar" ||
    block.chartType === "distribution"
  ) {
    const barred = block.chartType === "bar" || block.chartType === "distribution";
    for (const series of block.series) {
      series.points.forEach((point, position) => {
        if (point.note === undefined) return;
        const x = xAt(position, point.x);
        const anchor = x > right - 48 ? "end" : x < left + 48 ? "start" : "middle";
        parts.push(
          svgText(
            x,
            Math.max(top + 10, y(barred ? Math.max(0, point.y) : point.y) - 8),
            label(point.note),
            { anchor, fill: EXPORT_INK, weight: 600 },
          ),
        );
      });
    }
  }

  const legend = legendFor(block, label);
  return {
    label: chartLabel(block, label),
    width: WIDTH,
    height: bottom + GUTTER_BOTTOM,
    markup: parts.join(""),
    ...(legend.length === 0 ? {} : { legend }),
  };
}

function chartLabel(block: ChartBlock, label: Label): string {
  const names = block.series.map((series) => label(series.label)).filter((name) => name !== "");
  const kind = block.chartType.replace("-", " ");
  return names.length === 0 ? `${kind} chart` : `${kind} chart of ${names.join(", ")}`;
}

function partToWhole(block: ChartBlock, label: Label): CanvasExportDrawing | undefined {
  const series = block.series[0];
  if (series === undefined) return undefined;
  const total = series.points.reduce((sum, point) => sum + Math.max(0, point.y), 0);
  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const outer = 100;
  const inner = block.chartType === "donut" ? 62 : 0;
  const parts: string[] = [];
  let cursor = -Math.PI / 2;
  series.points.forEach((point, index) => {
    const fraction = total > 0 ? Math.max(0, point.y) / total : 0;
    const start = cursor;
    const end = cursor + fraction * Math.PI * 2;
    cursor = end;
    const path = ringPath(cx, cy, outer, inner, start, end);
    if (path !== "") {
      parts.push(
        `<path d="${path}" fill="${seriesColor(index)}" stroke="#ffffff" stroke-width="1.5" fill-rule="evenodd"/>`,
      );
    }
  });
  return {
    label: chartLabel(block, label),
    width: size,
    height: size,
    markup: parts.join(""),
    legend: series.points.map((point, index) => ({
      label: `${categoryText(point.x, block, label)} ${formatCanvasNumber(point.y, block.format)}${total > 0 ? ` (${String(Math.round((Math.max(0, point.y) / total) * 100))}%)` : ""}`,
      color: seriesColor(index),
    })),
  };
}

function ringPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  start: number,
  end: number,
): string {
  const span = end - start;
  if (span <= 1e-6) return "";
  if (span >= Math.PI * 2 - 1e-4) {
    const circle = (r: number, sweep: 0 | 1) =>
      `M${round(cx - r)} ${round(cy)} A${round(r)} ${round(r)} 0 1 ${String(sweep)} ${round(cx + r)} ${round(cy)} A${round(r)} ${round(r)} 0 1 ${String(sweep)} ${round(cx - r)} ${round(cy)}`;
    return inner <= 0 ? `${circle(outer, 1)} Z` : `${circle(outer, 1)} ${circle(inner, 0)} Z`;
  }
  const large = span > Math.PI ? 1 : 0;
  const at = (r: number, angle: number) =>
    `${round(cx + r * Math.cos(angle))} ${round(cy + r * Math.sin(angle))}`;
  if (inner <= 0) {
    return `M${round(cx)} ${round(cy)} L${at(outer, start)} A${round(outer)} ${round(outer)} 0 ${String(large)} 1 ${at(outer, end)} Z`;
  }
  return `M${at(outer, start)} A${round(outer)} ${round(outer)} 0 ${String(large)} 1 ${at(outer, end)} L${at(inner, end)} A${round(inner)} ${round(inner)} 0 ${String(large)} 0 ${at(inner, start)} Z`;
}

function funnel(block: ChartBlock, label: Label): CanvasExportDrawing | undefined {
  const series = block.series[0];
  if (series === undefined) return undefined;
  const top = Math.max(...series.points.map((point) => Math.max(0, point.y)), 0);
  const first = Math.max(0, series.points[0]?.y ?? 0);
  const row = 30;
  const labelWidth = 150;
  const valueWidth = 110;
  const barRoom = WIDTH - labelWidth - valueWidth;
  const parts: string[] = [];
  series.points.forEach((point, index) => {
    const value = Math.max(0, point.y);
    const width = top > 0 ? (value / top) * barRoom : 0;
    const y = index * row;
    parts.push(
      svgText(0, y + row / 2 + 4, fit(categoryText(point.x, block, label), 22), {
        fill: EXPORT_INK,
      }),
      `<rect x="${round(labelWidth + (barRoom - width) / 2)}" y="${round(y + 4)}" width="${round(Math.max(1, width))}" height="${String(row - 8)}" rx="${String(CHART_BAR_RADIUS)}" fill="${seriesColor(0)}"/>`,
      svgText(
        WIDTH,
        y + row / 2 + 4,
        `${formatCanvasNumber(point.y, block.format)} ${first > 0 ? `${String(Math.round((value / first) * 100))}%` : ""}`.trim(),
        { anchor: "end" },
      ),
    );
  });
  return {
    label: chartLabel(block, label),
    width: WIDTH,
    height: Math.max(row, series.points.length * row),
    markup: parts.join(""),
  };
}

function radar(block: ChartBlock, label: Label): CanvasExportDrawing | undefined {
  const axes = block.series[0]?.points ?? [];
  if (axes.length < 3) return undefined;
  const width = 420;
  const height = 320;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 115;
  const values = block.series.flatMap((series) => series.points.map((point) => point.y));
  const axis = niceAxis(Math.min(0, ...values), Math.max(...values), true);
  const angle = (index: number) => -Math.PI / 2 + (index / axes.length) * Math.PI * 2;
  const point = (index: number, value: number) => {
    const r = ((value - axis.min) / (axis.max - axis.min || 1)) * radius;
    return { x: cx + r * Math.cos(angle(index)), y: cy + r * Math.sin(angle(index)) };
  };
  const parts: string[] = [];
  for (const tick of axis.ticks) {
    if (tick === axis.min) continue;
    const ring = axes.map((_axis, index) => point(index, tick));
    parts.push(
      `<polygon points="${ring.map((p) => `${round(p.x)},${round(p.y)}`).join(" ")}" fill="none" stroke="${GRID}" stroke-width="1"/>`,
    );
  }
  axes.forEach((entry, index) => {
    const end = point(index, axis.max);
    const outside = {
      x: cx + (radius + 14) * Math.cos(angle(index)),
      y: cy + (radius + 14) * Math.sin(angle(index)),
    };
    const anchor = Math.abs(outside.x - cx) < 4 ? "middle" : outside.x > cx ? "start" : "end";
    parts.push(
      `<line x1="${round(cx)}" y1="${round(cy)}" x2="${round(end.x)}" y2="${round(end.y)}" stroke="${GRID}" stroke-width="1"/>`,
      svgText(outside.x, outside.y + 4, fit(categoryText(entry.x, block, label), 16), { anchor }),
    );
  });
  block.series.forEach((series, index) => {
    const shape = series.points.map((entry, position) => point(position, entry.y));
    const color = seriesColor(index);
    const dash = seriesDash(index);
    parts.push(
      `<polygon points="${shape.map((p) => `${round(p.x)},${round(p.y)}`).join(" ")}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="${String(CHART_LINE_WIDTH)}" stroke-linejoin="round"${dash === undefined ? "" : ` stroke-dasharray="${dash}"`}/>`,
    );
  });
  const legend = legendFor(block, label);
  return {
    label: chartLabel(block, label),
    width,
    height,
    markup: parts.join(""),
    ...(legend.length === 0 ? {} : { legend }),
  };
}

function sankey(block: ChartBlock, label: Label): CanvasExportDrawing | undefined {
  const links = block.links ?? [];
  if (links.length === 0) return undefined;
  const labelRoom = 96;
  const height = 260;
  const layout = layoutCanvasSankey(links, {
    width: WIDTH - labelRoom * 2,
    height,
  });
  const parts: string[] = [];
  for (const link of layout.links) {
    parts.push(
      `<path d="${link.path}" transform="translate(${String(labelRoom)} 0)" fill="${seriesColor(link.sourceIndex)}" fill-opacity="0.3"/>`,
    );
  }
  for (const node of layout.nodes) {
    const x = labelRoom + node.x;
    parts.push(
      `<rect x="${round(x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" fill="${seriesColor(node.index)}"/>`,
    );
    const atLeft = node.column === 0;
    const text = `${fit(label(node.label), 12)} ${formatCanvasNumber(Math.max(node.inflow, node.outflow), block.format)}`;
    parts.push(
      svgText(atLeft ? x - 6 : x + node.width + 6, node.y + node.height / 2 + 4, text, {
        anchor: atLeft ? "end" : "start",
        fill: EXPORT_INK,
      }),
    );
  }
  return {
    label: `sankey chart of ${String(layout.nodes.length)} nodes`,
    width: WIDTH,
    height,
    markup: parts.join(""),
  };
}
