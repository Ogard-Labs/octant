import type { AutomationTrigger } from "@octant/contracts/automation";
import type { AutomationFormatOptions } from "./automationCenterModel";
import { routineClockTime, routineDayLabel, routineScheduleLabel } from "@octant/domain";

export { routineScheduleLabel };

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

export type RoutineCadence = "one-time" | "recurring";

/** Whether this routine fires once or keeps going. */
export function routineCadence(trigger: AutomationTrigger): RoutineCadence {
  return trigger.kind === "once" ? "one-time" : "recurring";
}

export function routineCadenceLabel(cadence: RoutineCadence): string {
  return cadence === "one-time" ? "One-time" : "Recurring";
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
  const when = relativeWhen(nextDueAt, now, options);
  if (when === undefined) return "Not scheduled";
  return when === "now" ? "Next run due now" : `Next run ${when}`;
}

/** When a pending follow-up sends its turn: "Follows up tomorrow at 9:00". */
export function followUpWhenLabel(
  scheduledAt: string,
  now: string,
  options: AutomationFormatOptions = {},
): string {
  const when = relativeWhen(scheduledAt, now, options);
  if (when === undefined) return "Follow-up time unknown";
  return when === "now" ? "Follows up now" : `Follows up ${when}`;
}

function relativeWhen(
  dueAt: string,
  now: string,
  options: AutomationFormatOptions,
): string | undefined {
  const dueMs = Date.parse(dueAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(dueMs) || !Number.isFinite(nowMs)) return undefined;
  if (dueMs <= nowMs) return "now";

  const minutes = Math.round((dueMs - nowMs) / 60_000);
  if (minutes < 60) {
    return `in ${String(Math.max(1, minutes))} minute${minutes === 1 ? "" : "s"}`;
  }
  const time = routineClockTime(dueAt, options);
  const days = calendarDaysBetween(now, dueAt, options);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `on ${weekdayName(dueAt, options)} at ${time}`;
  return `on ${routineDayLabel(dueAt, options)} at ${time}`;
}

/** The row's whole schedule line: what it does, then when it next does it. */
export function routineScheduleLine(
  trigger: AutomationTrigger,
  nextDueAt: string | null,
  now: string,
  options: AutomationFormatOptions = {},
): string {
  if (trigger.kind === "file-arrival" || trigger.kind === "integration-event")
    return routineScheduleLabel(trigger, options);
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
