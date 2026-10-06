import type { CanvasChartPoint } from "@octant/contracts/canvas";

export interface ChartSeriesData {
  readonly seriesId: string;
  readonly label: string;
  readonly points: ReadonlyArray<CanvasChartPoint>;
}

export interface YDomain {
  readonly min: number;
  readonly max: number;
}

export function computeYDomain(series: ReadonlyArray<ChartSeriesData>): YDomain {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const item of series) {
    for (const point of item.points) {
      if (point.y < min) min = point.y;
      if (point.y > max) max = point.y;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) {
    const pad = Math.abs(max) <= Number.EPSILON ? 1 : Math.abs(max) * 0.1;
    return { min: min - pad, max: max + pad };
  }
  return { min, max };
}

/** Maps a zero-based point index within a series to an x coordinate in [0, width]. */
export function scaleX(index: number, count: number, width: number, inset: number): number {
  if (count <= 1) return inset + width / 2;
  return inset + (index / (count - 1)) * (width - inset * 2);
}

/** Maps a y value (as a proportion of the domain) to a y coordinate in [0, height]. */
export function scaleY(value: number, domain: YDomain, height: number, inset: number): number {
  const span = domain.max - domain.min;
  if (span <= 0) return inset + height / 2;
  const p = (value - domain.min) / span;
  return inset + (1 - p) * (height - inset * 2);
}

/** Center of a category slot along a shared x axis. */
export function categoryCenter(index: number, count: number, width: number, inset: number): number {
  if (count <= 0) return width / 2;
  const slot = (width - inset * 2) / count;
  return inset + slot * index + slot / 2;
}

export interface PieWedge {
  readonly start: number;
  readonly end: number;
  readonly fraction: number;
}

/** Clockwise wedges from 12 o'clock. A zero total yields no arc. */
export function pieWedges(values: ReadonlyArray<number>): ReadonlyArray<PieWedge> {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return values.map(() => ({ start: 0, end: 0, fraction: 0 }));
  let cursor = -Math.PI / 2;
  return values.map((value) => {
    const fraction = Math.max(0, value) / total;
    const start = cursor;
    const end = cursor + fraction * Math.PI * 2;
    cursor = end;
    return { start, end, fraction };
  });
}

function roundCoord(value: number): string {
  return value.toFixed(2);
}

/**
 * A pie wedge, or a donut ring when inner is greater than zero.
 * Angles are radians, zero at 3 o'clock, increasing clockwise on screen.
 */
export function ringPath(
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
    if (inner <= 0) {
      return `M ${roundCoord(cx - outer)} ${roundCoord(cy)} A ${roundCoord(outer)} ${roundCoord(outer)} 0 1 1 ${roundCoord(cx + outer)} ${roundCoord(cy)} A ${roundCoord(outer)} ${roundCoord(outer)} 0 1 1 ${roundCoord(cx - outer)} ${roundCoord(cy)} Z`;
    }
    return [
      `M ${roundCoord(cx - outer)} ${roundCoord(cy)}`,
      `A ${roundCoord(outer)} ${roundCoord(outer)} 0 1 1 ${roundCoord(cx + outer)} ${roundCoord(cy)}`,
      `A ${roundCoord(outer)} ${roundCoord(outer)} 0 1 1 ${roundCoord(cx - outer)} ${roundCoord(cy)}`,
      `M ${roundCoord(cx - inner)} ${roundCoord(cy)}`,
      `A ${roundCoord(inner)} ${roundCoord(inner)} 0 1 0 ${roundCoord(cx + inner)} ${roundCoord(cy)}`,
      `A ${roundCoord(inner)} ${roundCoord(inner)} 0 1 0 ${roundCoord(cx - inner)} ${roundCoord(cy)}`,
      "Z",
    ].join(" ");
  }
  const large = span > Math.PI ? 1 : 0;
  const outerStartX = cx + outer * Math.cos(start);
  const outerStartY = cy + outer * Math.sin(start);
  const outerEndX = cx + outer * Math.cos(end);
  const outerEndY = cy + outer * Math.sin(end);
  if (inner <= 0) {
    return `M ${roundCoord(cx)} ${roundCoord(cy)} L ${roundCoord(outerStartX)} ${roundCoord(outerStartY)} A ${roundCoord(outer)} ${roundCoord(outer)} 0 ${String(large)} 1 ${roundCoord(outerEndX)} ${roundCoord(outerEndY)} Z`;
  }
  const innerEndX = cx + inner * Math.cos(end);
  const innerEndY = cy + inner * Math.sin(end);
  const innerStartX = cx + inner * Math.cos(start);
  const innerStartY = cy + inner * Math.sin(start);
  return `M ${roundCoord(outerStartX)} ${roundCoord(outerStartY)} A ${roundCoord(outer)} ${roundCoord(outer)} 0 ${String(large)} 1 ${roundCoord(outerEndX)} ${roundCoord(outerEndY)} L ${roundCoord(innerEndX)} ${roundCoord(innerEndY)} A ${roundCoord(inner)} ${roundCoord(inner)} 0 ${String(large)} 0 ${roundCoord(innerStartX)} ${roundCoord(innerStartY)} Z`;
}

export interface NiceAxis {
  readonly domain: YDomain;
  readonly ticks: ReadonlyArray<number>;
  /** The distance between gridlines, which sets the precision their labels need. */
  readonly step: number;
}

/**
 * A value axis a reader can scan: about `target` gridlines on round numbers
 * (1, 2, 2.5 or 5 times a power of ten) that enclose every reading. Bars and
 * areas measure from zero, so `includeZero` keeps the baseline in view.
 */
export function niceAxis(domain: YDomain, includeZero: boolean, target = 4): NiceAxis {
  let min = includeZero ? Math.min(0, domain.min) : domain.min;
  let max = includeZero ? Math.max(0, domain.max) : domain.max;
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { domain: { min: 0, max: 1 }, ticks: [0, 1], step: 1 };
  }
  // Readings a few float steps apart (3.3 and 1.1 + 2.2) are one value: the
  // tolerance scales with their size, or the step falls below what a float
  // can add and the gridlines never end.
  const scale = Math.max(Math.abs(min), Math.abs(max));
  if (max - min <= Math.max(Number.EPSILON, scale * 1e-9)) {
    const pad = scale <= Number.EPSILON ? 1 : scale * 0.1;
    min -= pad;
    max += pad;
  }
  const rough = (max - min) / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10]
      .map((factor) => factor * magnitude)
      .find((candidate) => candidate >= rough) ?? 10 * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  // Rounded through the step's own precision so 0.1 + 0.2 never labels a line
  // 0.30000000000000004, and counted by index so nothing accumulates.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const count = Math.round((end - start) / step);
  const ticks: number[] = [];
  for (let index = 0; index <= count; index += 1) {
    ticks.push(Number((start + index * step).toFixed(decimals)));
  }
  return { domain: { min: start, max: end }, ticks, step };
}

const COMPACT_UNITS: ReadonlyArray<{
  readonly size: number;
  readonly from: number;
  readonly suffix: string;
}> = [
  { size: 1_000_000_000, from: 1_000_000_000, suffix: "B" },
  { size: 1_000_000, from: 1_000_000, suffix: "M" },
  { size: 1_000, from: 10_000, suffix: "k" },
];

/**
 * A tick label short enough for a gutter: 1.2k, 3.4M, 0.25. Given the axis
 * step, it keeps exactly the precision that tells neighbouring gridlines
 * apart: 0.001 steps stay 0.001, 0.002, and 10001, 10002 are not all "10k".
 */
export function formatTick(value: number, step?: number): string {
  const size = Math.abs(value);
  for (const unit of COMPACT_UNITS) {
    if (size < unit.from) continue;
    const decimals = step === undefined ? 2 : decimalsFor(step / unit.size);
    // On an axis, a compact label that needs more than one decimal to stay
    // distinct reads worse than the plain number.
    if (step !== undefined && decimals > 1) break;
    return `${trimNumber(value / unit.size, decimals)}${unit.suffix}`;
  }
  return trimNumber(value, step === undefined ? 2 : decimalsFor(step));
}

function decimalsFor(step: number): number {
  if (!(step > 0)) return 2;
  return Math.min(8, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
}

function trimNumber(value: number, decimals: number): string {
  return String(Number(value.toFixed(decimals)));
}

export interface PlotPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A smooth line through every reading that never swings past one. A plain
 * cubic overshoots between a rise and a fall and draws a peak the data does
 * not have; monotone tangents (Fritsch–Carlson) keep each span inside its two
 * readings, so the curve stays honest at any spacing.
 */
export function smoothPath(points: ReadonlyArray<PlotPoint>): string {
  const first = points[0];
  if (first === undefined) return "";
  if (points.length < 3) {
    return points
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"} ${roundCoord(point.x)} ${roundCoord(point.y)}`,
      )
      .join(" ");
  }
  const slopes: number[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    if (a === undefined || b === undefined) continue;
    const dx = b.x - a.x;
    slopes.push(dx === 0 ? 0 : (b.y - a.y) / dx);
  }
  const tangents = points.map((point, index) => {
    const before = slopes[index - 1];
    const after = slopes[index];
    if (before === undefined) return after ?? 0;
    if (after === undefined) return before;
    // A turning point or a flat run keeps a flat tangent, which is what stops the overshoot.
    if (before * after <= 0) return 0;
    // Otherwise the weighted harmonic mean of the two slopes, weighted by the
    // neighbouring spans, which keeps the curve inside each span's readings.
    const previous = points[index - 1];
    const next = points[index + 1];
    const spanBefore = previous === undefined ? 0 : point.x - previous.x;
    const spanAfter = next === undefined ? 0 : next.x - point.x;
    const weightBefore = 2 * spanAfter + spanBefore;
    const weightAfter = spanAfter + 2 * spanBefore;
    return (weightBefore + weightAfter) / (weightBefore / before + weightAfter / after);
  });
  let path = `M ${roundCoord(first.x)} ${roundCoord(first.y)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    if (a === undefined || b === undefined) continue;
    const third = (b.x - a.x) / 3;
    const startTangent = tangents[index] ?? 0;
    const endTangent = tangents[index + 1] ?? 0;
    path += ` C ${roundCoord(a.x + third)} ${roundCoord(a.y + startTangent * third)} ${roundCoord(b.x - third)} ${roundCoord(b.y - endTangent * third)} ${roundCoord(b.x)} ${roundCoord(b.y)}`;
  }
  return path;
}
