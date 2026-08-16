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
