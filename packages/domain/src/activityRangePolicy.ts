import type { ActivityKind, HomeActivityCustomization } from "@octant/contracts/code-home-activity";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const OFFSET_SAMPLE_RADIUS_MS = 36 * HOUR_MS;
const TRANSITION_SEARCH_ITERATIONS = 48;
const MIN_INSTANT_MS = civilMs(1, 1, 1);
const MAX_INSTANT_MS = civilMs(10_000, 1, 1);

export type ActivityRange =
  | {
      readonly kind:
        | "today"
        | "last-24-hours"
        | "yesterday"
        | "this-week"
        | "this-month"
        | "last-month"
        | "this-year"
        | "total";
    }
  | { readonly kind: "custom"; readonly startDate: string; readonly endDate: string };

/** Half-open `[startMs, endMs)`; a null start means unbounded. */
export interface ActivityWindow {
  readonly startMs: number | null;
  readonly endMs: number;
}

export type ActivityRangeResult =
  | {
      readonly status: "ready";
      readonly current: ActivityWindow;
      readonly comparison: ActivityWindow | null;
    }
  | {
      readonly status: "refused";
      readonly reason:
        | "invalid-clock"
        | "invalid-time-zone"
        | "invalid-week-start"
        | "invalid-custom-date"
        | "reversed-custom-range";
    };

/**
 * Wall-clock reading encoded as a UTC timestamp: a scratch coordinate for
 * civil arithmetic only. `setUTCFullYear` takes years below 100 literally and
 * normalises overflowing months and days, so `civilMs(9999, 13, 1)` reaches
 * year 10000 and `civilMs(y, m, d + 1)` rolls month and year ends.
 */
function civilMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getTime();
}

interface LocalClock {
  /** Wall-clock reading of an instant, encoded as UTC milliseconds. */
  readonly wallAt: (instantMs: number) => number;
  /** Instant realising a wall reading, per the fold/gap rules. */
  readonly resolve: (wall: number) => number | undefined;
}

function createLocalClock(timeZone: string): LocalClock {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });

  const wallAt = (instantMs: number): number => {
    let parts: Intl.DateTimeFormatPart[];
    try {
      parts = formatter.formatToParts(new Date(instantMs));
    } catch {
      return Number.NaN;
    }
    const values = new Map<string, number>();
    for (const part of parts) {
      if (part.type === "era" && part.value === "BC") return Number.NaN;
      if (part.type !== "literal" && part.type !== "era") {
        values.set(part.type, Number(part.value));
      }
    }
    const year = values.get("year");
    const month = values.get("month");
    const day = values.get("day");
    const hour = values.get("hour");
    const minute = values.get("minute");
    const second = values.get("second");
    const millisecond = values.get("fractionalSecond");
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      hour === undefined ||
      minute === undefined ||
      second === undefined ||
      millisecond === undefined
    ) {
      return Number.NaN;
    }
    return civilMs(year, month, day, hour, minute, second, millisecond);
  };

  const offsetAt = (instantMs: number): number => wallAt(instantMs) - instantMs;

  const firstInstantWithLaterOffset = (
    lowerBound: number,
    upperBound: number,
    beforeOffset: number,
  ): number => {
    let left = lowerBound;
    let right = upperBound;
    for (
      let iteration = 0;
      iteration < TRANSITION_SEARCH_ITERATIONS && left < right;
      iteration += 1
    ) {
      const midpoint = left + Math.floor((right - left) / 2);
      if (offsetAt(midpoint) <= beforeOffset) {
        left = midpoint + 1;
      } else {
        right = midpoint;
      }
    }
    return right;
  };

  /**
   * An ambiguous wall time resolves to the earlier of its instants; a skipped
   * one resolves to the first instant whose reading reaches it — for a
   * forward gap the transition instant itself, which is the first real
   * instant of that civil day when the gap covers midnight.
   */
  const resolve = (wall: number): number | undefined => {
    const probes = [wall - OFFSET_SAMPLE_RADIUS_MS, wall, wall + OFFSET_SAMPLE_RADIUS_MS];
    const candidates = [...new Set(probes.map((probe) => wall - offsetAt(probe)))]
      .filter((candidate) => Number.isFinite(candidate))
      .sort((left, right) => left - right);

    const exact = candidates.filter((candidate) => wallAt(candidate) === wall);
    if (exact.length > 0) return exact[0];

    // A skipped wall time leaves two adjacent candidates whose readings
    // straddle it; the transition sits between them.
    for (let index = 0; index + 1 < candidates.length; index += 1) {
      const left = candidates[index];
      const right = candidates[index + 1];
      if (left === undefined || right === undefined) continue;
      if (!(wallAt(left) < wall && wallAt(right) > wall)) continue;
      const beforeOffset = offsetAt(left);
      const afterOffset = offsetAt(right);
      if (afterOffset <= beforeOffset) continue;
      const instant = firstInstantWithLaterOffset(left, right, beforeOffset);
      if (wallAt(instant) >= wall) return instant;
    }
    return undefined;
  };

  return { wallAt, resolve };
}

function refused(
  reason: Extract<ActivityRangeResult, { readonly status: "refused" }>["reason"],
): ActivityRangeResult {
  return { status: "refused", reason };
}

function ready(current: ActivityWindow, comparison: ActivityWindow | null): ActivityRangeResult {
  return { status: "ready", current, comparison };
}

const CUSTOM_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Day-start wall of a strict `YYYY-MM-DD` Gregorian date, or null. */
function parseCalendarDate(value: string): number | null {
  const match = CUSTOM_DATE_PATTERN.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0) return null;
  const wall = civilMs(year, month, day);
  const date = new Date(wall);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return wall;
}

export function isActivityCalendarDate(value: string): boolean {
  return parseCalendarDate(value) !== null;
}

interface CivilSpan {
  readonly currentStartWall: number;
  readonly currentEndWall: number;
  readonly previousStartWall: number;
  /**
   * To-date spans compare the wall-clock position already elapsed in the
   * current period against the previous one; whole-period spans compare the
   * whole previous civil period instead.
   */
  readonly elapsedPosition: boolean;
}

type NamedRangeKind = Exclude<ActivityRange["kind"], "total" | "last-24-hours" | "custom">;

function namedSpans(kind: NamedRangeKind, nowWall: number, weekStartsOn: number): CivilSpan {
  const nowDate = new Date(nowWall);
  const year = nowDate.getUTCFullYear();
  const month = nowDate.getUTCMonth() + 1;
  const day = nowDate.getUTCDate();
  switch (kind) {
    case "today":
      return {
        currentStartWall: civilMs(year, month, day),
        currentEndWall: civilMs(year, month, day + 1),
        previousStartWall: civilMs(year, month, day - 1),
        elapsedPosition: true,
      };
    case "yesterday":
      return {
        currentStartWall: civilMs(year, month, day - 1),
        currentEndWall: civilMs(year, month, day),
        previousStartWall: civilMs(year, month, day - 2),
        elapsedPosition: false,
      };
    case "this-week": {
      const back = (((nowDate.getUTCDay() - weekStartsOn) % 7) + 7) % 7;
      return {
        currentStartWall: civilMs(year, month, day - back),
        currentEndWall: civilMs(year, month, day - back + 7),
        previousStartWall: civilMs(year, month, day - back - 7),
        elapsedPosition: true,
      };
    }
    case "this-month":
      return {
        currentStartWall: civilMs(year, month, 1),
        currentEndWall: civilMs(year, month + 1, 1),
        previousStartWall: civilMs(year, month - 1, 1),
        elapsedPosition: true,
      };
    case "last-month":
      return {
        currentStartWall: civilMs(year, month - 1, 1),
        currentEndWall: civilMs(year, month, 1),
        previousStartWall: civilMs(year, month - 2, 1),
        elapsedPosition: false,
      };
    case "this-year":
      return {
        currentStartWall: civilMs(year, 1, 1),
        currentEndWall: civilMs(year + 1, 1, 1),
        previousStartWall: civilMs(year - 1, 1, 1),
        elapsedPosition: true,
      };
    default: {
      const unreachable: never = kind;
      throw new Error(`unhandled activity range ${String(unreachable)}`);
    }
  }
}

export function resolveActivityRange(input: {
  readonly range: ActivityRange;
  readonly nowMs: number;
  readonly timeZone: string;
  readonly weekStartsOn: number;
}): ActivityRangeResult {
  if (
    !Number.isInteger(input.nowMs) ||
    input.nowMs < MIN_INSTANT_MS ||
    input.nowMs >= MAX_INSTANT_MS
  ) {
    return refused("invalid-clock");
  }
  let clock: LocalClock;
  try {
    clock = createLocalClock(input.timeZone);
  } catch {
    return refused("invalid-time-zone");
  }
  if (!Number.isInteger(input.weekStartsOn) || input.weekStartsOn < 0 || input.weekStartsOn > 6) {
    return refused("invalid-week-start");
  }
  const nowWall = clock.wallAt(input.nowMs);
  if (!Number.isFinite(nowWall)) return refused("invalid-clock");

  const resolveBoundary = (wall: number): number | null => {
    const resolved = clock.resolve(wall);
    return resolved !== undefined && Number.isFinite(resolved) ? resolved : null;
  };

  const range = input.range;
  if (range.kind === "total") {
    return ready({ startMs: null, endMs: input.nowMs }, null);
  }
  if (range.kind === "last-24-hours") {
    return ready(
      { startMs: input.nowMs - DAY_MS, endMs: input.nowMs },
      { startMs: input.nowMs - 2 * DAY_MS, endMs: input.nowMs - DAY_MS },
    );
  }

  let span: CivilSpan;
  if (range.kind === "custom") {
    const startWall = parseCalendarDate(range.startDate);
    const endWall = parseCalendarDate(range.endDate);
    if (startWall === null || endWall === null) return refused("invalid-custom-date");
    if (endWall < startWall) return refused("reversed-custom-range");
    const spanDays = (endWall - startWall) / DAY_MS + 1;
    span = {
      currentStartWall: startWall,
      currentEndWall: endWall + DAY_MS,
      previousStartWall: startWall - spanDays * DAY_MS,
      elapsedPosition: false,
    };
  } else {
    span = namedSpans(range.kind, nowWall, input.weekStartsOn);
  }

  const start = resolveBoundary(span.currentStartWall);
  const end = span.elapsedPosition ? input.nowMs : resolveBoundary(span.currentEndWall);
  if (start === null || end === null) return refused("invalid-clock");

  // A comparison whose period reaches before year 1 — or anywhere the zone
  // cannot represent — is omitted rather than refusing a valid range.
  let comparison: ActivityWindow | null = null;
  if (span.elapsedPosition) {
    const elapsedWall = nowWall - span.currentStartWall;
    // Wall elapsed can already be positive while the period's first real
    // instant is still arriving — a skipped local midnight shifts the start
    // ahead of now, and a comparison measured against an empty window is
    // worse than none.
    if (elapsedWall > 0 && input.nowMs > start) {
      const comparisonStart = resolveBoundary(span.previousStartWall);
      const comparisonEndWall = Math.min(
        span.previousStartWall + elapsedWall,
        span.currentStartWall,
      );
      const comparisonEndCandidate = resolveBoundary(comparisonEndWall);
      if (comparisonStart !== null && comparisonEndCandidate !== null) {
        const comparisonEnd = Math.min(comparisonEndCandidate, start);
        if (comparisonEnd > comparisonStart) {
          comparison = { startMs: comparisonStart, endMs: comparisonEnd };
        }
      }
    }
  } else {
    const comparisonStart = resolveBoundary(span.previousStartWall);
    if (comparisonStart !== null && comparisonStart < start) {
      comparison = { startMs: comparisonStart, endMs: start };
    }
  }

  return ready({ startMs: start, endMs: end }, comparison);
}

/** The choices an installation without any stored activity settings uses. */
export const DEFAULT_HOME_ACTIVITY = {
  sharedRange: { kind: "this-week" },
  source: "github",
  pins: [],
} satisfies HomeActivityCustomization;

/**
 * The timeframe one card resolves: its own pin when the person set one,
 * otherwise the shared range.
 */
export function activityRangeForCard(
  settings: HomeActivityCustomization,
  card: ActivityKind,
): ActivityRange {
  return settings.pins.find((pin) => pin.card === card)?.range ?? settings.sharedRange;
}
