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
    const first = windows[0];
    if (first === undefined) return [];
    const last = windows.find((window, index) => index > 0 && !window.name.includes(","));
    return [
      {
        providerInstanceId: String(entry.providerInstanceId),
        windows,
        outer: last ?? first,
        ...(last === undefined ? {} : { inner: first }),
        resetsAt: new Map(
          (limits.rateLimitWindows ?? []).flatMap((window) =>
            window.resetsAt === undefined ? [] : [[window.window, window.resetsAt] as const],
          ),
        ),
      },
    ];
  });
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
