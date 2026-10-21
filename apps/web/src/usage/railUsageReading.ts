import type { ProviderUsageLimitsEntry } from "@octant/contracts";
import { composerLimitWindows, type ComposerLimitWindow } from "../context/composerLimitWindows";

/** One provider's plan windows as the rail draws them. */
export interface RailUsageReading {
  readonly providerInstanceId: string;
  /** Every reported window with a figure, in the provider's order (shortest first). */
  readonly windows: ReadonlyArray<ComposerLimitWindow>;
  /** The longest window, drawn as the outer arc: what is left of the week. */
  readonly outer: ComposerLimitWindow;
  /** The shortest window, drawn as the inner arc, when there are two or more. */
  readonly inner?: ComposerLimitWindow;
  /** When each window resets, by window id, where the provider said. */
  readonly resetsAt: ReadonlyMap<string, string>;
}

/**
 * The providers that have a plan window to show, read the same way the
 * composer's limit bars read them. A provider with no window figure (an API
 * key, a runtime that does not report, a window whose reset has passed) gets
 * no ring: an empty ring would claim a limit nobody reported.
 */
export function railUsageReadings(
  entries: ReadonlyArray<ProviderUsageLimitsEntry>,
  now: number,
): ReadonlyArray<RailUsageReading> {
  return entries.flatMap((entry) => {
    const limits =
      entry.status === "available"
        ? entry.limits
        : entry.status === "failed"
          ? entry.staleLimits
          : undefined;
    if (limits === undefined) return [];
    const windows = composerLimitWindows({ now, snapshot: { serviceLimits: limits } });
    // Arcs are chosen by how long each window is, not by its name: Codex
    // scopes its ids ("codex:secondary_7d"), Claude adds per-model weeks
    // ("seven_day_opus"). The first window of a length wins a tie, which keeps
    // the plain week ahead of a per-model one.
    const byLength = [...windows].sort((a, b) => windowHours(a.window) - windowHours(b.window));
    const shortest = byLength[0];
    const longestHours = windowHours(byLength[byLength.length - 1]?.window ?? "");
    const longest = windows.find((window) => windowHours(window.window) === longestHours);
    if (shortest === undefined || longest === undefined) return [];
    return [
      {
        providerInstanceId: String(entry.providerInstanceId),
        windows,
        outer: longest,
        ...(windowHours(shortest.window) < longestHours ? { inner: shortest } : {}),
        resetsAt: new Map(
          (limits.rateLimitWindows ?? []).flatMap((window) =>
            window.resetsAt === undefined ? [] : [[window.window, window.resetsAt] as const],
          ),
        ),
      },
    ];
  });
}

const NAMED_WINDOW_HOURS: Readonly<Record<string, number>> = {
  one_hour: 1,
  five_hour: 5,
  one_day: 24,
  seven_day: 168,
};

const UNIT_HOURS: Readonly<Record<string, number>> = { m: 1 / 60, h: 1, d: 24, w: 168 };

/**
 * How many hours a window id covers: "five_hour", "seven_day_opus",
 * "codex:primary_5h", "secondary_7d". An id with no readable length sorts as
 * the shortest, so it never claims the outer arc.
 */
export function windowHours(window: string): number {
  const id = window.slice(window.lastIndexOf(":") + 1).toLowerCase();
  for (const [name, hours] of Object.entries(NAMED_WINDOW_HOURS)) {
    if (id === name || id.startsWith(`${name}_`)) return hours;
  }
  const match = /(\d+)\s*([mhdw])\b/.exec(id.replaceAll("_", " "));
  const unit = match?.[2] === undefined ? undefined : UNIT_HOURS[match[2]];
  return match?.[1] === undefined || unit === undefined ? 0 : Number(match[1]) * unit;
}

/** "Resets in 2h 52m", "Resets in 1d 4h", or nothing when the reset is unknown or past. */
export function resetPhrase(resetsAt: string | undefined, now: number): string | undefined {
  if (resetsAt === undefined) return undefined;
  const minutes = Math.round((Date.parse(resetsAt) - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `Resets in ${days}d ${hours}h`;
  if (hours > 0) return `Resets in ${hours}h ${rest}m`;
  return `Resets in ${rest}m`;
}
