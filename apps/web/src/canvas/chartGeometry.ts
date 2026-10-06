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
