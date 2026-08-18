import type { AutomationTrigger } from "@octant/contracts/automation";
import type { AutomationFormatOptions } from "./automationCenterModel";

/**
 * How a routine reads on a row.
 *
 * The Automation Center already had labels, and they answered a different
 * question: they said what a trigger *is* ("Every day from Aug 18, 09:00")
 * where a person scanning a list wants to know what it *does next* ("Every day
 * at 9:00 · Next run tomorrow at 9:00"). These sit alongside the originals
 * rather than replacing them, because the detail pane still wants the exact
 * instant and the row does not.
 *
 * Everything here is pure and takes `now` as an argument. A relative phrase
 * computed from a hidden clock is a phrase that cannot be tested and changes
 * under the reader between two renders.
 */

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const WEEKDAY_SET = { weekdays: [1, 2, 3, 4, 5], weekend: [6, 7] } as const;

export type RoutineCadence = "one-time" | "recurring";

/** Whether this routine fires once or keeps going. */
export function routineCadence(trigger: AutomationTrigger): RoutineCadence {
  return trigger.kind === "once" ? "one-time" : "recurring";
}

export function routineCadenceLabel(cadence: RoutineCadence): string {
  return cadence === "one-time" ? "One-time" : "Recurring";
}

/**
 * What this routine does, in the shortest true phrase.
 *
 * An interval's time of day comes from its anchor, because that is what the
 * host will actually fire at — saying "every day" without saying when is the
 * half-answer that sends people into the detail pane.
 */
export function routineScheduleLabel(
  trigger: AutomationTrigger,
  options: AutomationFormatOptions = {},
): string {
  switch (trigger.kind) {
    case "once":
      return `Once on ${dayLabel(trigger.scheduledAt, options)} at ${timeOfDay(trigger.scheduledAt, options)}`;
    case "interval": {
      const cadence = intervalCadence(trigger.intervalMinutes);
      // Below a day, a time of day would be a lie: it fires many times a day.
      return trigger.intervalMinutes % 1_440 === 0
        ? `${cadence} at ${timeOfDay(trigger.anchorAt, options)}`
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

/**
 * When it next runs, said the way a person would say it.
 *
 * Near things are relative ("in 20 minutes", "tomorrow at 9:00") because that
 * is the useful form when you are deciding whether to wait for it. Anything
 * beyond a week is an absolute date, because "in 23 days" is not something
 * anyone can act on.
 */
export function routineNextRunLabel(
  nextDueAt: string | null,
  now: string,
  options: AutomationFormatOptions = {},
): string {
  if (nextDueAt === null) return "Not scheduled";
  const dueMs = Date.parse(nextDueAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(dueMs) || !Number.isFinite(nowMs)) return "Not scheduled";
  if (dueMs <= nowMs) return "Next run due now";

  const minutes = Math.round((dueMs - nowMs) / 60_000);
  if (minutes < 60) {
    return `Next run in ${String(Math.max(1, minutes))} minute${minutes === 1 ? "" : "s"}`;
  }
  const time = timeOfDay(nextDueAt, options);
  const days = calendarDaysBetween(now, nextDueAt, options);
  if (days === 0) return `Next run today at ${time}`;
  if (days === 1) return `Next run tomorrow at ${time}`;
  if (days < 7) return `Next run on ${weekdayName(nextDueAt, options)} at ${time}`;
  return `Next run on ${dayLabel(nextDueAt, options)} at ${time}`;
}

/** The row's whole schedule line: what it does, then when it next does it. */
export function routineScheduleLine(
  trigger: AutomationTrigger,
  nextDueAt: string | null,
  now: string,
  options: AutomationFormatOptions = {},
): string {
  return `${routineScheduleLabel(trigger, options)} · ${routineNextRunLabel(nextDueAt, now, options)}`;
}

/**
 * Whether a one-shot has already fired.
 *
 * A fired one-time routine is finished, not broken, so the list hides it unless
 * asked. It is recognised by having nothing left to do rather than by a status
 * field, which keeps this true for any host that stops scheduling it.
 */
export function routineHasCompleted(trigger: AutomationTrigger, nextDueAt: string | null): boolean {
  return trigger.kind === "once" && nextDueAt === null;
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
function timeOfDay(instant: string, options: AutomationFormatOptions): string {
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

function dayLabel(instant: string, options: AutomationFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", {
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    month: "short",
    day: "numeric",
  }).format(new Date(instant));
}

function weekdayName(instant: string, options: AutomationFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", {
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    weekday: "long",
  }).format(new Date(instant));
}

/**
 * Whole calendar days between two instants in the reader's own zone.
 *
 * Counted on the calendar rather than by dividing elapsed milliseconds: 23:50
 * to 00:10 is tomorrow to a person and twenty minutes to arithmetic, and the
 * row has to agree with the person.
 */
function calendarDaysBetween(from: string, to: string, options: AutomationFormatOptions): number {
  const fromDay = Date.parse(`${localDate(from, options)}T00:00:00Z`);
  const toDay = Date.parse(`${localDate(to, options)}T00:00:00Z`);
  if (!Number.isFinite(fromDay) || !Number.isFinite(toDay)) return 0;
  return Math.round((toDay - fromDay) / 86_400_000);
}

function localDate(instant: string, options: AutomationFormatOptions): string {
  return new Intl.DateTimeFormat("en-CA", {
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}
