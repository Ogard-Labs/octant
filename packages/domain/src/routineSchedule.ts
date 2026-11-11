import type { AutomationTrigger } from "@octant/contracts/automation";

/** The zone a time reads in; the viewer's own when absent. */
export interface RoutineScheduleFormatOptions {
  readonly timeZone?: string;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const WEEKDAY_SET = { weekdays: [1, 2, 3, 4, 5], weekend: [6, 7] } as const;

/**
 * What this routine does, in the shortest true phrase.
 *
 * An interval's time of day comes from its anchor, because that is what the
 * host will actually fire at — saying "every day" without saying when is the
 * half-answer that sends people into the detail pane.
 */
export function routineScheduleLabel(
  trigger: AutomationTrigger,
  options: RoutineScheduleFormatOptions = {},
): string {
  switch (trigger.kind) {
    case "integration-event":
      return trigger.sourceLabel ?? "Integration events";
    case "file-arrival":
      return `File arrivals in ${trigger.directory}`;
    case "once":
      return `Once on ${routineDayLabel(trigger.scheduledAt, options)} at ${routineClockTime(trigger.scheduledAt, options)}`;
    case "interval": {
      const cadence = intervalCadence(trigger.intervalMinutes);
      // Below a day, a time of day would be a lie: it fires many times a day.
      return trigger.intervalMinutes % 1_440 === 0
        ? `${cadence} at ${routineClockTime(trigger.anchorAt, options)}`
        : cadence;
    }
    case "weekly-local": {
      const days = [...trigger.weekdays].sort((left, right) => left - right);
      // The stored local time is a padded "HH:MM"; reading it back through the
      // same clock format is what keeps one row from saying 09:00 where the
      // next says 9:00.
      return `${weekdayPhrase(days)} at ${normalizeClock(trigger.localTime)}`;
    }
  }
}

function intervalCadence(intervalMinutes: number): string {
  if (intervalMinutes % 1_440 === 0) {
    const days = intervalMinutes / 1_440;
    return days === 1 ? "Every day" : `Every ${String(days)} days`;
  }
  if (intervalMinutes % 60 === 0) {
    const hours = intervalMinutes / 60;
    return hours === 1 ? "Every hour" : `Every ${String(hours)} hours`;
  }
  return `Every ${String(intervalMinutes)} minutes`;
}

/**
 * The named sets people actually mean.
 *
 * "Mon, Tue, Wed, Thu, Fri" is five words for one idea, and a row has no room
 * to spend them.
 */
function weekdayPhrase(days: ReadonlyArray<number>): string {
  if (days.length === 7) return "Every day";
  if (sameDays(days, WEEKDAY_SET.weekdays)) return "Weekdays";
  if (sameDays(days, WEEKDAY_SET.weekend)) return "Weekends";
  return `Weekly on ${days.map((day) => WEEKDAY_LABELS[day - 1] ?? "").join(", ")}`;
}

function sameDays(left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean {
  return left.length === right.length && left.every((day, index) => day === right[index]);
}

/**
 * A 24-hour clock with no leading zero on the hour.
 *
 * `Intl` with `hourCycle: "h23"` pads the hour, so "9:00" comes back as
 * "09:00". The parts are assembled by hand rather than fought with, because
 * the padding differs between runtimes and a row that reads differently on two
 * machines is worse than a small formatter.
 */
export function routineClockTime(instant: string, options: RoutineScheduleFormatOptions): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "0";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${String(Number(hour))}:${minute}`;
}

function normalizeClock(localTime: string): string {
  const [hour, minute] = localTime.split(":");
  if (hour === undefined || minute === undefined) return localTime;
  return `${String(Number(hour))}:${minute}`;
}

export function routineDayLabel(instant: string, options: RoutineScheduleFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", {
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    month: "short",
    day: "numeric",
  }).format(new Date(instant));
}
