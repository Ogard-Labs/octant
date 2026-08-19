import type { AutomationMode, AutomationSummary, AutomationTrigger } from "@octant/contracts";
import { resolveNextAutomationOccurrence } from "@octant/domain";
import { routineScheduleLabel } from "./routinePresentation";

/**
 * A month of a routine's future, laid out the way a calendar is read.
 *
 * The occurrences come from the same resolver the scheduler fires on rather
 * than a second projection of the same rules. A calendar that computed its own
 * dates would eventually disagree with the host about when something runs, and
 * the disagreement would show up as a run that never happened on a day the
 * person was watching.
 *
 * Everything here is pure and takes `now` and a time zone as arguments: a grid
 * built from a hidden clock cannot be tested, and the day a routine lands on
 * depends entirely on which zone you read it in.
 */

/** Enough for daily and weekly routines across a six-week grid, with room. */
const MAX_OCCURRENCES_PER_ROUTINE = 200;
/** Below a day, a calendar cell would be a wall of times rather than a schedule. */
const SUB_DAILY_MINUTES = 1_440;

export interface RoutineCalendarEntry {
  readonly automationId: string;
  readonly displayName: string;
  readonly mode: AutomationMode;
  /** The instant it runs, or absent when the routine runs many times that day. */
  readonly at?: string;
  /** "9:00", or the cadence when the routine is more frequent than daily. */
  readonly label: string;
}

export interface RoutineCalendarDay {
  /** The local date this cell stands for, as `YYYY-MM-DD` in the display zone. */
  readonly date: string;
  readonly dayOfMonth: number;
  readonly inMonth: boolean;
  readonly isToday: boolean;
  readonly entries: ReadonlyArray<RoutineCalendarEntry>;
}

export interface RoutineCalendarMonth {
  /** "August 2026", in the display zone. */
  readonly label: string;
  /** Any instant inside the month, for stepping to the previous or next one. */
  readonly month: string;
  readonly weeks: ReadonlyArray<ReadonlyArray<RoutineCalendarDay>>;
  /**
   * A routine ran more times than this view enumerates. Said out loud rather
   * than silently dropped, because a calendar that quietly stops is read as a
   * calendar that says nothing more happens.
   */
  readonly truncated: boolean;
}

export interface BuildRoutineCalendarInput {
  readonly routines: ReadonlyArray<AutomationSummary>;
  /** Any instant inside the month to render. */
  readonly month: string;
  readonly now: string;
  readonly timeZone: string;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

export function buildRoutineCalendarMonth(input: BuildRoutineCalendarInput): RoutineCalendarMonth {
  const monthMs = Date.parse(input.month);
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(monthMs) || !Number.isFinite(nowMs)) {
    return { label: "", month: input.month, weeks: [], truncated: false };
  }
  const anchor = localParts(monthMs, input.timeZone);
  const firstOfMonth = Date.UTC(anchor.year, anchor.month - 1, 1);
  // The grid starts on the Monday on or before the first, and always runs six
  // weeks so the layout does not jump between months.
  const gridStart = firstOfMonth - (isoWeekday(firstOfMonth) - 1) * DAY_MS;
  const dates: string[] = [];
  for (let index = 0; index < 42; index += 1) {
    dates.push(isoDate(gridStart + index * DAY_MS));
  }
  const rangeStart = startOfLocalDay(dates[0] as string, input.timeZone);
  const rangeEnd = startOfLocalDay(dates[41] as string, input.timeZone) + DAY_MS;

  const byDate = new Map<string, RoutineCalendarEntry[]>();
  let truncated = false;
  for (const routine of input.routines) {
    // Only an enabled routine has a future to draw. Showing a paused, archived,
    // or exhausted one would promise runs that will not happen.
    if (routine.lifecycle !== "enabled") continue;
    const placed = placeRoutine(routine, rangeStart, rangeEnd, input.timeZone);
    truncated = truncated || placed.truncated;
    for (const entry of placed.entries) {
      const bucket = byDate.get(entry.date) ?? [];
      bucket.push(entry.entry);
      byDate.set(entry.date, bucket);
    }
  }

  const today = isoDateInZone(nowMs, input.timeZone);
  const days = dates.map((date): RoutineCalendarDay => {
    const entries = (byDate.get(date) ?? []).sort(
      (left, right) =>
        (left.at ?? "").localeCompare(right.at ?? "") ||
        left.displayName.localeCompare(right.displayName),
    );
    return {
      date,
      dayOfMonth: Number(date.slice(8, 10)),
      inMonth: Number(date.slice(5, 7)) === anchor.month,
      isToday: date === today,
      entries,
    };
  });

  const weeks: RoutineCalendarDay[][] = [];
  for (let index = 0; index < days.length; index += 7) {
    weeks.push(days.slice(index, index + 7));
  }
  return {
    label: monthLabel(firstOfMonth),
    month: input.month,
    weeks,
    truncated,
  };
}

/**
 * An instant inside the month `delta` months away from this one.
 *
 * Midday on the fifteenth, deliberately: stepping by a whole month from the
 * thirty-first would land on a month that has no thirty-first, and stepping
 * from midnight would land on the wrong day wherever a clock moved that night.
 */
export function stepRoutineCalendarMonth(month: string, delta: number, timeZone: string): string {
  const anchor = localParts(Date.parse(month), timeZone);
  const target = anchor.month - 1 + delta;
  const year = anchor.year + Math.floor(target / 12);
  const zeroBasedMonth = ((target % 12) + 12) % 12;
  return new Date(Date.UTC(year, zeroBasedMonth, 15, 12)).toISOString();
}

function placeRoutine(
  routine: AutomationSummary,
  rangeStart: number,
  rangeEnd: number,
  timeZone: string,
): {
  readonly entries: ReadonlyArray<{ readonly date: string; readonly entry: RoutineCalendarEntry }>;
  readonly truncated: boolean;
} {
  const trigger = routine.trigger;
  if (isSubDaily(trigger)) {
    // Enumerating a fifteen-minute routine would bury the day it sits on. The
    // cadence is the useful sentence, and it is true on every day it runs.
    const from = Math.max(rangeStart, Date.parse(trigger.anchorAt));
    const entries: { readonly date: string; readonly entry: RoutineCalendarEntry }[] = [];
    for (let day = alignToLocalDay(from, timeZone); day < rangeEnd; day += DAY_MS) {
      entries.push({
        date: isoDateInZone(day, timeZone),
        entry: {
          automationId: String(routine.id),
          displayName: routine.displayName,
          mode: routine.mode,
          label: routineScheduleLabel(trigger, { timeZone }),
        },
      });
    }
    return { entries, truncated: false };
  }

  const entries: { readonly date: string; readonly entry: RoutineCalendarEntry }[] = [];
  let cursor = new Date(rangeStart).toISOString();
  let inclusive = true;
  while (entries.length < MAX_OCCURRENCES_PER_ROUTINE) {
    // The resolver rejects rather than returns for input it cannot read. A
    // stored routine has already been validated, so this only fires for a
    // trigger that arrived some other way — and a calendar is not the place to
    // take the page down over one row.
    let next;
    try {
      next = resolveNextAutomationOccurrence({
        trigger,
        after: cursor as never,
        inclusive,
      });
    } catch {
      break;
    }
    if (next === undefined) break;
    const nextMs = Date.parse(next);
    if (nextMs >= rangeEnd) break;
    entries.push({
      date: isoDateInZone(nextMs, timeZone),
      entry: {
        automationId: String(routine.id),
        displayName: routine.displayName,
        mode: routine.mode,
        at: next,
        label: clockInZone(nextMs, timeZone),
      },
    });
    cursor = next;
    inclusive = false;
  }
  return { entries, truncated: entries.length >= MAX_OCCURRENCES_PER_ROUTINE };
}

function isSubDaily(
  trigger: AutomationTrigger,
): trigger is Extract<AutomationTrigger, { readonly kind: "interval" }> {
  return trigger.kind === "interval" && trigger.intervalMinutes < SUB_DAILY_MINUTES;
}

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function localParts(epochMs: number, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const values = new Map(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.get("year") ?? 1970,
    month: values.get("month") ?? 1,
    day: values.get("day") ?? 1,
    hour: values.get("hour") ?? 0,
    minute: values.get("minute") ?? 0,
  };
}

/** ISO weekday of a UTC-midnight date, Monday 1 through Sunday 7. */
function isoWeekday(dateMs: number): number {
  return new Date(dateMs).getUTCDay() || 7;
}

function isoDate(dateMs: number): string {
  return new Date(dateMs).toISOString().slice(0, 10);
}

function isoDateInZone(epochMs: number, timeZone: string): string {
  const parts = localParts(epochMs, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function clockInZone(epochMs: number, timeZone: string): string {
  const parts = localParts(epochMs, timeZone);
  // Assembled by hand: `hourCycle: "h23"` pads to "09", and one row saying
  // 09:00 beside another saying 9:00 reads as two different schedules.
  return `${parts.hour}:${String(parts.minute).padStart(2, "0")}`;
}

/**
 * The instant a local date begins in a zone.
 *
 * Found by probing rather than assuming a fixed offset: the day a clock jumps
 * forward does not begin at the same UTC offset as the day before it.
 */
function startOfLocalDay(date: string, timeZone: string): number {
  const nominal = Date.parse(`${date}T00:00:00.000Z`);
  for (const guess of [nominal, nominal - offsetMs(nominal, timeZone)]) {
    const candidate = guess - offsetMs(guess, timeZone);
    if (isoDateInZone(candidate, timeZone) === date) return candidate;
  }
  return nominal;
}

function alignToLocalDay(epochMs: number, timeZone: string): number {
  return startOfLocalDay(isoDateInZone(epochMs, timeZone), timeZone);
}

function offsetMs(epochMs: number, timeZone: string): number {
  const parts = localParts(epochMs, timeZone);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) -
    floorMinute(epochMs)
  );
}

function floorMinute(epochMs: number): number {
  return epochMs - (epochMs % 60_000);
}

function monthLabel(firstOfMonthMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(firstOfMonthMs));
}
