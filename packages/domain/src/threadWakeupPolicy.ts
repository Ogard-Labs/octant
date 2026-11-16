/**
 * The rules for wake-ups a thread's agent asks for: when one may be made,
 * when it fires, and when it is missed instead. Octant holds every wake-up
 * itself; nothing here reads a clock or a file, so the host passes `now`.
 */

/** The soonest a wake-up may fire after it is asked for. */
export const MIN_WAKEUP_DELAY_SECONDS = 60;
/** The latest a delayed wake-up may fire, the runtime's own clamp for it. */
export const MAX_WAKEUP_DELAY_SECONDS = 3_600;
/** How long a recurring wake-up keeps firing before it ends on its own. */
export const RECURRING_WAKEUP_LIFETIME_DAYS = 7;
/**
 * How late a wake-up may still fire on time. A timer the host's own sleep or
 * a busy event loop held back by more than this fired at a time nobody
 * chose, so it is shown as missed instead.
 */
export const WAKEUP_ON_TIME_GRACE_MS = 2 * 60_000;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const CRON_SEARCH_DAYS = 366;

export interface WakeupCron {
  readonly expression: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** Both day fields name days: a date matches when either does, as cron reads it. */
  readonly eitherDay: boolean;
}

export type WakeupRefusal = { readonly status: "refused"; readonly reason: string };

function parseField(
  text: string,
  min: number,
  max: number,
): { readonly values: ReadonlySet<number>; readonly any: boolean } | undefined {
  const values = new Set<number>();
  let any = false;
  for (const part of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (match === null) return undefined;
    const step = match[4] === undefined ? 1 : Number(match[4]);
    let low = min;
    let high = max;
    if (match[1] === "*") {
      if (match[4] === undefined) any = true;
    } else {
      low = Number(match[2]);
      high = match[3] === undefined ? (match[4] === undefined ? low : max) : Number(match[3]);
    }
    if (step < 1 || low < min || high > max || low > high) return undefined;
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return { values, any };
}

/** A five-field cron expression (minute, hour, day of month, month, day of week), or why not. */
export function parseWakeupCron(
  expression: string,
): { readonly status: "parsed"; readonly cron: WakeupCron } | WakeupRefusal {
  const fields = expression.trim().split(/\s+/);
  const refused = {
    status: "refused" as const,
    reason: `"${expression.trim().slice(0, 64)}" is not a five-field cron expression (minute hour day-of-month month day-of-week).`,
  };
  if (fields.length !== 5) return refused;
  const [minuteText, hourText, dayText, monthText, weekdayText] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minutes = parseField(minuteText, 0, 59);
  const hours = parseField(hourText, 0, 23);
  const days = parseField(dayText, 1, 31);
  const months = parseField(monthText, 1, 12);
  const weekdays = parseField(weekdayText, 0, 7);
  if (
    minutes === undefined ||
    hours === undefined ||
    days === undefined ||
    months === undefined ||
    weekdays === undefined
  ) {
    return refused;
  }
  // Sunday is both 0 and 7.
  const daysOfWeek = new Set([...weekdays.values].map((day) => day % 7));
  return {
    status: "parsed",
    cron: {
      expression: fields.join(" "),
      minutes: minutes.values,
      hours: hours.values,
      daysOfMonth: days.values,
      months: months.values,
      daysOfWeek,
      eitherDay: !days.any && !weekdays.any,
    },
  };
}

function dayMatches(cron: WakeupCron, date: Date): boolean {
  if (!cron.months.has(date.getMonth() + 1)) return false;
  const byMonthDay = cron.daysOfMonth.has(date.getDate());
  const byWeekday = cron.daysOfWeek.has(date.getDay());
  return cron.eitherDay ? byMonthDay || byWeekday : byMonthDay && byWeekday;
}

/**
 * The first minute strictly after `after` that the expression matches, in
 * the host's local time, within a year; undefined when none does.
 */
export function nextWakeupCronFire(cron: WakeupCron, after: Date): Date | undefined {
  // Candidates advance in epoch time. A local-time setter inside the repeated
  // hour of a daylight-saving fall-back resolves to the hour's first
  // occurrence, which moved the search backwards and returned a fire time
  // already past, so a new wake-up read as missed at once.
  let time = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = after.getTime() + CRON_SEARCH_DAYS * DAY_MS;
  while (time <= limit) {
    const candidate = new Date(time);
    if (!dayMatches(cron, candidate)) {
      const nextDay = new Date(
        candidate.getFullYear(),
        candidate.getMonth(),
        candidate.getDate() + 1,
      ).getTime();
      time = nextDay > time ? nextDay : time + MINUTE_MS;
      continue;
    }
    if (!cron.hours.has(candidate.getHours())) {
      time += (60 - candidate.getMinutes()) * MINUTE_MS;
      continue;
    }
    if (!cron.minutes.has(candidate.getMinutes())) {
      time += MINUTE_MS;
      continue;
    }
    return candidate;
  }
  return undefined;
}

export interface PlannedWakeup {
  readonly status: "planned";
  readonly fireAt: Date;
  /** Set for a recurring wake-up: when it stops firing on its own. */
  readonly expiresAt?: Date;
  /** The delay a delayed wake-up uses after the bounds, and whether they changed it. */
  readonly clampedDelaySeconds?: number;
  readonly wasClamped?: boolean;
}

/**
 * A wake-up a number of seconds from now, held to the runtime's own range of
 * one minute to one hour (its tool says so to the model).
 */
export function planDelayedWakeup(input: {
  readonly delaySeconds: unknown;
  readonly now: Date;
}): PlannedWakeup | WakeupRefusal {
  if (typeof input.delaySeconds !== "number" || !Number.isFinite(input.delaySeconds)) {
    return { status: "refused", reason: "A wake-up needs a delay in seconds." };
  }
  const requested = Math.round(input.delaySeconds);
  const clamped = Math.min(MAX_WAKEUP_DELAY_SECONDS, Math.max(MIN_WAKEUP_DELAY_SECONDS, requested));
  return {
    status: "planned",
    fireAt: new Date(input.now.getTime() + clamped * 1_000),
    clampedDelaySeconds: clamped,
    wasClamped: clamped !== requested,
  };
}

/**
 * A wake-up on a cron expression: its first fire at least a minute away. A
 * recurring one may fire on every match, as often as every minute, as cron
 * does: the earlier five-minute floor protected no hard line, since each fire
 * is a journaled turn the thread's level, spend ceiling and the person's Stop
 * still bound (maintainer decision, 2026-11-16).
 */
export function planCronWakeup(input: {
  readonly cron: string;
  readonly recurring: boolean;
  readonly now: Date;
}): PlannedWakeup | WakeupRefusal {
  const parsed = parseWakeupCron(input.cron);
  if (parsed.status === "refused") return parsed;
  // The first matching minute strictly after this is at least a minute away.
  const earliest = new Date(input.now.getTime() + MIN_WAKEUP_DELAY_SECONDS * 1_000 - 1);
  const first = nextWakeupCronFire(parsed.cron, earliest);
  if (first === undefined) {
    return {
      status: "refused",
      reason: `"${parsed.cron.expression}" matches no time in the next year.`,
    };
  }
  if (!input.recurring) return { status: "planned", fireAt: first };
  const expiresAt = new Date(input.now.getTime() + RECURRING_WAKEUP_LIFETIME_DAYS * DAY_MS);
  if (first.getTime() > expiresAt.getTime()) {
    return {
      status: "refused",
      reason: `"${parsed.cron.expression}" first matches after a recurring wake-up's ${RECURRING_WAKEUP_LIFETIME_DAYS} days.`,
    };
  }
  return { status: "planned", fireAt: first, expiresAt };
}

/**
 * Whether a thread may take one more wake-up, given how many it has waiting
 * (missed ones included) and the limit in Settings.
 */
export function admitThreadWakeup(input: {
  readonly waitingCount: number;
  readonly waitingLimit: number;
}): { readonly status: "admitted" } | WakeupRefusal {
  return input.waitingCount >= input.waitingLimit
    ? {
        status: "refused",
        reason: `This thread already has ${input.waitingLimit} wake-ups waiting, the limit set in Settings; cancel one first.`,
      }
    : { status: "admitted" };
}

/**
 * What to do with a pending wake-up at `now`. One that came due before this
 * host started, or longer ago than the grace window, is missed: the host was
 * down or asleep at its time, and firing it now would start a turn at a time
 * nobody chose.
 */
export function threadWakeupDue(input: {
  readonly nextFireAt: Date;
  readonly now: Date;
  readonly hostStartedAt: Date;
}): "wait" | "fire" | "missed" {
  const due = input.nextFireAt.getTime();
  if (due > input.now.getTime()) return "wait";
  if (due < input.hostStartedAt.getTime()) return "missed";
  return input.now.getTime() - due > WAKEUP_ON_TIME_GRACE_MS ? "missed" : "fire";
}

/**
 * When a recurring wake-up fires next after it fired (or was run) at `now`,
 * or undefined when it is done: not recurring, past its lifetime, or out of
 * matches.
 */
export function nextThreadWakeupFire(input: {
  readonly cron: string;
  readonly recurring: boolean;
  readonly expiresAt: Date | undefined;
  readonly now: Date;
}): Date | undefined {
  if (!input.recurring) return undefined;
  const parsed = parseWakeupCron(input.cron);
  if (parsed.status === "refused") return undefined;
  const next = nextWakeupCronFire(parsed.cron, input.now);
  if (next === undefined) return undefined;
  if (input.expiresAt !== undefined && next.getTime() > input.expiresAt.getTime()) return undefined;
  return next;
}

/** The schedule in words, for the person and for the agent's tool result. */
export function describeThreadWakeup(input: {
  readonly schedule:
    | { readonly kind: "delay" }
    | { readonly kind: "cron"; readonly cron: string; readonly recurring: boolean };
  readonly fireAt: Date;
}): string {
  if (input.schedule.kind === "cron" && input.schedule.recurring) {
    return `Every match of "${input.schedule.cron}" (local time), for ${RECURRING_WAKEUP_LIFETIME_DAYS} days`;
  }
  return `Once at ${input.fireAt.toISOString()}`;
}
