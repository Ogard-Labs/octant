import { shownPercent } from "./pooledProviderLimits";
import { windowHours } from "./railUsageReading";

/**
 * One limit window as a pace and a forecast read it. Everything here comes from
 * the provider's own reading: the share left, when it resets, and how long the
 * window is by its name. No plan size and no vendor usage endpoint is involved,
 * so whatever the reading leaves out stays unknown.
 */
export interface LimitWindowReading {
  readonly window: string;
  readonly remainingPercent?: number;
  readonly resetsAt?: string;
  /** When the provider reported the share; a forecast is measured from here. */
  readonly observedAt?: string;
  readonly exhausted: boolean;
  /** Kept from before a failed refresh, so the share may no longer be true. */
  readonly stale: boolean;
}

export interface LimitForecast {
  /** Share of the window already passed, where its length and reset are known. */
  readonly elapsedPercent?: number;
  /** The share that returns at the reset. */
  readonly back?: { readonly percent: number; readonly inMs: number };
  /** Spending set against an even pace over the window, as of the reading. */
  readonly trend?: "slower" | "even" | "faster";
  /** Whether the share left lasts until the reset at the pace so far. */
  readonly outlook?:
    | { readonly kind: "lasts" }
    | { readonly kind: "runs-out"; readonly inMs: number };
}

const HOUR_MS = 60 * 60_000;

/**
 * Below this share of a window, one early burst extrapolates to a run-out
 * within the hour, so no pace is claimed yet.
 */
const EARLIEST_PACED_SHARE = 0.05;

/** A few points either side of even spending are read as even. */
const EVEN_PACE_POINTS = 3;

/**
 * How long a window is, where its name says. A month has no fixed length, so a
 * monthly window gets no pace rather than an assumed thirty days.
 */
function windowLengthMs(window: string): number | undefined {
  const id = window.slice(window.lastIndexOf(":") + 1).toLowerCase();
  if (id.startsWith("monthly")) return undefined;
  const hours = id === "weekly" ? 168 : windowHours(window);
  return hours > 0 ? hours * HOUR_MS : undefined;
}

/** The share of the window passed at `at`, or nothing when `at` is outside it. */
function elapsedShare(resetMs: number, lengthMs: number, at: number): number | undefined {
  const share = 1 - (resetMs - at) / lengthMs;
  return Number.isFinite(share) && share >= 0 && share < 1 ? share : undefined;
}

export function limitForecast(reading: LimitWindowReading, now: number): LimitForecast {
  const resetMs = reading.resetsAt === undefined ? Number.NaN : Date.parse(reading.resetsAt);
  // No reset time, or one already past, leaves nothing to measure against.
  if (!Number.isFinite(resetMs) || resetMs <= now) return {};
  const lengthMs = windowLengthMs(reading.window);
  const elapsedNow = lengthMs === undefined ? undefined : elapsedShare(resetMs, lengthMs, now);
  const marker = elapsedNow === undefined ? {} : { elapsedPercent: Math.round(elapsedNow * 100) };
  const remaining = reading.remainingPercent;
  if (reading.stale || remaining === undefined) return marker;
  const used = 100 - Math.max(0, Math.min(100, remaining));
  // What comes back is counted from the share as shown, so the two add to 100.
  const returning = 100 - shownPercent(100 - used);
  const back = returning > 0 ? { back: { percent: returning, inMs: resetMs - now } } : {};
  const observed = reading.observedAt === undefined ? now : Date.parse(reading.observedAt);
  const elapsed =
    lengthMs === undefined ? undefined : elapsedShare(resetMs, lengthMs, Math.min(observed, now));
  // A spent account or allowance has nothing left to pace, whatever share one
  // window of a stopped account still reports.
  if (reading.exhausted || used >= 100 || lengthMs === undefined || elapsed === undefined) {
    return { ...marker, ...back };
  }
  if (elapsed < EARLIEST_PACED_SHARE) return { ...marker, ...back };
  const ahead = used - elapsed * 100;
  const trend = ahead > EVEN_PACE_POINTS ? "faster" : ahead < -EVEN_PACE_POINTS ? "slower" : "even";
  const emptyAt =
    used === 0
      ? Number.POSITIVE_INFINITY
      : Math.min(observed, now) + ((100 - used) / used) * elapsed * lengthMs;
  return {
    ...marker,
    ...back,
    trend,
    outlook:
      emptyAt < resetMs
        ? { kind: "runs-out", inMs: Math.max(0, emptyAt - now) }
        : { kind: "lasts" },
  };
}

/** "1d 19h", "4h 59m" or "12m", never less than a minute. */
export function paceDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${rest}m`;
}

export function outlookPhrase(outlook: NonNullable<LimitForecast["outlook"]>): string {
  if (outlook.kind === "lasts") return "Lasts until the reset";
  return outlook.inMs === 0
    ? "May have run out already at this pace"
    : `Runs out in about ${paceDuration(outlook.inMs)}, before the reset`;
}
