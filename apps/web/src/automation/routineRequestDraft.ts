import type { AutomationTrigger } from "@octant/contracts/automation";

/**
 * Reading a plain-English request into a routine draft.
 *
 * This is deliberately a *draft*. It never creates anything: it turns "every
 * weekday at 9am, summarise open pull requests" into a filled-in form the
 * person confirms, and says plainly which parts it could not read. A parser
 * that quietly guessed a schedule would be scheduling work nobody agreed to.
 *
 * It is small on purpose. It recognises the handful of shapes people actually
 * type and declines everything else rather than growing into a language: a
 * request it cannot read still becomes a draft, just one with the schedule
 * left for the person to fill in.
 */

export interface RoutineRequestDraft {
  /** The routine's name, taken from the request's own words. */
  readonly name: string;
  /** What the routine should do, which is the request minus its schedule. */
  readonly prompt: string;
  /** Absent when the request named no schedule this could read. */
  readonly trigger?: AutomationTrigger;
  /** What was read, in words, so the person can check it before confirming. */
  readonly scheduleSummary: string;
  /** True when the schedule still needs a person. */
  readonly needsSchedule: boolean;
}

export interface RoutineRequestSuggestion {
  readonly label: string;
  readonly request: string;
}

/**
 * The starting points offered beside the composer.
 *
 * They are examples of the shapes the reader understands, so a person who uses
 * one gets a complete draft and learns the vocabulary by seeing it work.
 */
export const ROUTINE_REQUEST_SUGGESTIONS: ReadonlyArray<RoutineRequestSuggestion> = [
  {
    label: "Every weekday morning",
    request: "Every weekday at 9:00, summarise what changed in this Project overnight",
  },
  { label: "Every hour", request: "Every hour, check whether the test suite still passes" },
  { label: "Daily digest", request: "Every day at 17:00, write a digest of today's threads" },
  { label: "Once tomorrow", request: "Tomorrow at 10:00, review the open pull requests" },
  { label: "Weekly review", request: "Every Monday at 9:00, plan the week from the thread board" },
];

const WEEKDAY_WORDS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bmondays?\b/i, 1],
  [/\btuesdays?\b/i, 2],
  [/\bwednesdays?\b/i, 3],
  [/\bthursdays?\b/i, 4],
  [/\bfridays?\b/i, 5],
  [/\bsaturdays?\b/i, 6],
  [/\bsundays?\b/i, 7],
];

export interface RoutineRequestContext {
  /** Now, so "tomorrow" means something. Passed in rather than read. */
  readonly now: string;
  readonly timeZone: string;
}

export function draftRoutineFromRequest(
  request: string,
  context: RoutineRequestContext,
): RoutineRequestDraft {
  const text = request.trim();
  if (text.length === 0) {
    return { name: "", prompt: "", scheduleSummary: "No schedule yet", needsSchedule: true };
  }

  const clock = readClock(text);
  const trigger = readTrigger(text, clock, context);
  const prompt = withoutSchedulePhrase(text);
  return {
    name: nameFrom(prompt),
    prompt,
    ...(trigger === undefined ? {} : { trigger }),
    scheduleSummary:
      trigger === undefined ? "Could not read a schedule — choose one below" : describe(trigger),
    needsSchedule: trigger === undefined,
  };
}

function readTrigger(
  text: string,
  clock: { readonly hour: number; readonly minute: number } | undefined,
  context: RoutineRequestContext,
): AutomationTrigger | undefined {
  const weekdays = readWeekdays(text);
  if (weekdays !== undefined && clock !== undefined) {
    return {
      kind: "weekly-local",
      weekdays,
      localTime: `${pad(clock.hour)}:${pad(clock.minute)}`,
      timeZone: context.timeZone,
    } as AutomationTrigger;
  }

  const everyMinutes = readIntervalMinutes(text);
  if (everyMinutes !== undefined) {
    // A daily interval is anchored at the requested time of day; a sub-daily
    // one is anchored now, because "every hour at 9:00" is not a thing.
    const anchorAt =
      everyMinutes % 1_440 === 0 && clock !== undefined
        ? nextLocalOccurrence(clock, context)
        : context.now;
    return { kind: "interval", anchorAt, intervalMinutes: everyMinutes } as AutomationTrigger;
  }

  if (/\btomorrow\b/i.test(text) && clock !== undefined) {
    return {
      kind: "once",
      scheduledAt: nextLocalOccurrence(clock, context, 1),
    } as AutomationTrigger;
  }
  if (/\btoday\b/i.test(text) && clock !== undefined) {
    return { kind: "once", scheduledAt: nextLocalOccurrence(clock, context) } as AutomationTrigger;
  }
  return undefined;
}

function readWeekdays(text: string): ReadonlyArray<number> | undefined {
  if (/\bevery ?day\b|\bdaily\b/i.test(text)) return undefined;
  if (/\bweekdays?\b/i.test(text)) return [1, 2, 3, 4, 5];
  if (/\bweekends?\b/i.test(text)) return [6, 7];
  const named = WEEKDAY_WORDS.filter(([pattern]) => pattern.test(text)).map(([, day]) => day);
  return named.length === 0 ? undefined : named.sort((left, right) => left - right);
}

function readIntervalMinutes(text: string): number | undefined {
  if (/\bevery ?day\b|\bdaily\b/i.test(text)) return 1_440;
  const every = /\bevery\s+(\d+)?\s*(minute|minutes|hour|hours|day|days)\b/i.exec(text);
  if (every === null) return undefined;
  const count = every[1] === undefined ? 1 : Number(every[1]);
  const unit = (every[2] ?? "").toLowerCase();
  if (!Number.isFinite(count) || count <= 0) return undefined;
  if (unit.startsWith("minute")) return count;
  if (unit.startsWith("hour")) return count * 60;
  return count * 1_440;
}

/** `9am`, `9:30`, `17:00`, `5pm` — the forms people type, and nothing else. */
function readClock(text: string): { readonly hour: number; readonly minute: number } | undefined {
  const match = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (match === null) return undefined;
  const rawHour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isFinite(rawHour) || minute > 59) return undefined;
  // A bare number with no colon and no am/pm is a count ("every 3 days"), not
  // a time. Reading it as one is how "every 3 days" becomes "at 03:00".
  if (match[2] === undefined && meridiem === undefined) return undefined;
  let hour = rawHour;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return hour > 23 ? undefined : { hour, minute };
}

/**
 * The next time that clock comes round, in the reader's own zone.
 *
 * Built by walking candidate days and comparing the formatted local time,
 * rather than by arithmetic on an offset: the offset changes across a daylight
 * saving boundary, and a routine that drifts by an hour twice a year is the
 * bug this avoids.
 */
function nextLocalOccurrence(
  clock: { readonly hour: number; readonly minute: number },
  context: RoutineRequestContext,
  minimumDays = 0,
): string {
  const nowMs = Date.parse(context.now);
  for (let day = minimumDays; day <= minimumDays + 8; day += 1) {
    const candidate = localInstant(nowMs + day * 86_400_000, clock, context.timeZone);
    if (candidate !== undefined && (day > minimumDays || candidate > nowMs)) {
      return new Date(candidate).toISOString();
    }
  }
  return new Date(nowMs).toISOString();
}

function localInstant(
  dayMs: number,
  clock: { readonly hour: number; readonly minute: number },
  timeZone: string,
): number | undefined {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(dayMs));
  // Two passes: guess at UTC, measure the zone's offset there, then correct.
  const guess = Date.parse(`${date}T${pad(clock.hour)}:${pad(clock.minute)}:00Z`);
  if (!Number.isFinite(guess)) return undefined;
  const offsetMs = zoneOffsetMs(guess, timeZone);
  return guess - offsetMs;
}

function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instantMs));
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const asUtc = Date.parse(
    `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}:${read("second")}Z`,
  );
  return Number.isFinite(asUtc) ? asUtc - instantMs : 0;
}

/**
 * The request minus the words that described its schedule.
 *
 * What is left is what the routine should *do*, which is what the thread will
 * be asked. Leaving the schedule in would have every run re-reading an
 * instruction the host has already carried out.
 */
function withoutSchedulePhrase(text: string): string {
  const stripped = text
    .replace(
      /^\s*(every\s+\d*\s*(minute|minutes|hour|hours|day|days|weekday|weekdays|weekend|weekends|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?|daily|tomorrow|today)\b/i,
      "",
    )
    .replace(/^\s*(at\s+\d{1,2}(?::\d{2})?\s*(am|pm)?)\b/i, "")
    .replace(/^[\s,;:-]+/, "");
  return stripped.length === 0 ? text.trim() : stripped.trim();
}

/** A short name from the request's own first clause. */
function nameFrom(prompt: string): string {
  const firstClause = prompt.split(/[.;\n]/)[0] ?? prompt;
  const trimmed = firstClause.trim().slice(0, 80);
  return trimmed.length === 0 ? "New routine" : trimmed[0]?.toUpperCase() + trimmed.slice(1);
}

function describe(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case "once":
      return `Once, at ${trigger.scheduledAt}`;
    case "interval":
      return `Every ${String(trigger.intervalMinutes)} minutes from ${trigger.anchorAt}`;
    case "weekly-local":
      return `Weekly on ${trigger.weekdays.join(", ")} at ${trigger.localTime}`;
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
