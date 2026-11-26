/** Round values from zero up to the first one that covers `maximum`. */
export function roundTicks(maximum: number, intervals = 3): ReadonlyArray<number> {
  if (!Number.isFinite(maximum) || maximum <= 0) return [0, 1];
  const rough = maximum / intervals;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = power * ([1, 2, 2.5, 5, 10].find((candidate) => candidate * power >= rough) ?? 10);
  const count = Math.max(1, Math.ceil(maximum / step - 1e-9));
  // Rounded to twelve digits so 0.1 + 0.2 never labels a tick.
  return Array.from({ length: count + 1 }, (_, index) => Number((index * step).toPrecision(12)));
}

/** Every calendar day from the first to the last, so a quiet day takes its place. */
export function calendarDays(days: ReadonlyArray<string>): ReadonlyArray<string> {
  const sorted = [...new Set(days)].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return [];
  const filled: string[] = [];
  for (
    let time = Date.parse(`${first}T00:00:00Z`);
    time <= Date.parse(`${last}T00:00:00Z`) && filled.length < 512;
    time += 86_400_000
  ) {
    filled.push(new Date(time).toISOString().slice(0, 10));
  }
  return filled;
}

export interface PlotPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A smooth line through the points that never leaves the range between two
 * neighbours (monotone cubic interpolation). An ordinary spline dips below zero
 * beside a spike, which would draw usage that never happened.
 */
export function smoothLine(points: ReadonlyArray<PlotPoint>): string {
  const slopes = points.slice(1).map((point, index) => {
    const before = points[index] ?? point;
    return (point.y - before.y) / (point.x - before.x || 1);
  });
  const tangents = points.map((_, index) => {
    const left = slopes[index - 1];
    const right = slopes[index];
    if (left === undefined) return right ?? 0;
    if (right === undefined) return left;
    // The harmonic mean keeps the curve between its points; a turn is flat.
    return left * right <= 0 ? 0 : (2 * left * right) / (left + right);
  });
  return points
    .map((point, index) => {
      const before = points[index - 1];
      if (before === undefined) return `M${point.x},${point.y}`;
      const third = (point.x - before.x) / 3;
      return `C${before.x + third},${before.y + (tangents[index - 1] ?? 0) * third} ${point.x - third},${point.y - (tangents[index] ?? 0) * third} ${point.x},${point.y}`;
    })
    .join(" ");
}

/** The smooth line closed down to the baseline. */
export function smoothArea(points: ReadonlyArray<PlotPoint>, baseline: number): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return "";
  return `${smoothLine(points)} L${last.x},${baseline} L${first.x},${baseline} Z`;
}
