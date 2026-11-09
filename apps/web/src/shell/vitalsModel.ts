import type { HostResourceSnapshot } from "@octant/contracts/host-resources";

/** Five minutes at the host's five-second sample cache. */
export const VITALS_HISTORY_LIMIT = 60;

/**
 * Appends a sample to a rolling window. A sample at or before the newest one
 * (the host's cache answering twice) adds no point, so a flat repeated reading
 * is not drawn as time passing.
 */
export function appendVitalsSample(
  history: ReadonlyArray<HostResourceSnapshot>,
  next: HostResourceSnapshot,
): ReadonlyArray<HostResourceSnapshot> {
  const newest = history[history.length - 1];
  if (newest !== undefined && next.sampledAt <= newest.sampledAt) return history;
  return [...history, next].slice(-VITALS_HISTORY_LIMIT);
}

const UNITS = ["B", "K", "M", "G", "T"] as const;

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1_000 && unit < UNITS.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)}${UNITS[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** SVG polyline points for `values` scaled into a width x height box, `max` at the top. */
export function sparklinePoints(
  values: ReadonlyArray<number>,
  max: number,
  width: number,
  height: number,
): string {
  if (values.length === 0 || max <= 0) return "";
  const step = values.length === 1 ? 0 : width / (VITALS_HISTORY_LIMIT - 1);
  const offset = width - step * (values.length - 1);
  return values
    .map((value, index) => {
      const x = offset + index * step;
      const y = height - (Math.min(Math.max(value, 0), max) / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
