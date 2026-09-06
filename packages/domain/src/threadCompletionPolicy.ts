/**
 * Pure policy for a thread's two resting states.
 *
 * A **completed** thread is one the person put away: it leaves the active list
 * for the Completed shelf, stays readable, and is archived by the host only
 * after the window Settings names. A **snoozed** thread is hidden until a wake
 * time; it stays active in every other way, so a running turn keeps running.
 * Nothing here reads a clock or storage — every caller passes `now`.
 */

export interface ThreadSnoozeLike {
  readonly until: string;
  readonly at: string;
  /** A provider turn was running when the snooze was set. */
  readonly duringTurn?: boolean | undefined;
}

export interface ThreadRestLike {
  readonly completedAt?: string | undefined;
  readonly snooze?: ThreadSnoozeLike | undefined;
}

/** What the host currently knows about the thread's live work. */
export interface ThreadRestSignals {
  readonly executing: boolean;
  readonly awaitingInput: boolean;
}

export type ThreadShelf = "active" | "snoozed" | "completed";

/**
 * The lifecycle values the three modes use. Code keeps two legacy values
 * ("waiting", "interrupted") beside active; Chat and Work pass through
 * deletion. Only an active thread can rest, and only an archived or deleted
 * one is closed to the person.
 */
export type RestingThreadLifecycle =
  | "active"
  | "archived"
  | "waiting"
  | "interrupted"
  | "deleting"
  | "deleted";

function lifecycleIsClosed(lifecycle: RestingThreadLifecycle): boolean {
  return lifecycle === "archived" || lifecycle === "deleting" || lifecycle === "deleted";
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function parseInstant(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The wake time has passed. A wake time that cannot be parsed never hides a thread. */
export function snoozeElapsed(snooze: ThreadSnoozeLike, now: string): boolean {
  const until = parseInstant(snooze.until);
  const nowMs = parseInstant(now);
  if (until === undefined || nowMs === undefined) return true;
  return until <= nowMs;
}

/**
 * Something happened that outranks the snooze: the agent is blocked on the
 * person, or the turn that was running when the thread was snoozed has ended.
 * A thread snoozed while idle stays asleep until its wake time.
 */
export function snoozeRaisedHand(snooze: ThreadSnoozeLike, signals: ThreadRestSignals): boolean {
  if (signals.awaitingInput) return true;
  return snooze.duringTurn === true && !signals.executing;
}

/**
 * Where the sidebar files the thread right now. A snooze that is still holding
 * outranks completion; once it ends, the thread is what it was underneath.
 */
export function threadShelf(
  thread: ThreadRestLike,
  input: ThreadRestSignals & { readonly now: string },
): ThreadShelf {
  if (
    thread.snooze !== undefined &&
    !snoozeElapsed(thread.snooze, input.now) &&
    !snoozeRaisedHand(thread.snooze, input)
  ) {
    return "snoozed";
  }
  return thread.completedAt === undefined ? "active" : "completed";
}

/**
 * The snooze ended — by its timer or by a raised hand — but the record still
 * carries it. The row reappears where it was, so this is what lets it say so
 * until the person opens the thread.
 */
export function threadWoke(
  thread: ThreadRestLike,
  input: ThreadRestSignals & { readonly now: string },
): boolean {
  if (thread.snooze === undefined) return false;
  return snoozeElapsed(thread.snooze, input.now) || snoozeRaisedHand(thread.snooze, input);
}

export type CompleteThreadDecision =
  | { readonly status: "ok" }
  | { readonly status: "refused"; readonly reason: "archived" | "executing" | "awaiting-input" };

/**
 * Completing hides the thread, so it is refused while work is in flight: a
 * running turn would finish out of sight, and a pending approval or question
 * would never be answered.
 */
export function decideCompleteThread(
  input: ThreadRestSignals & { readonly lifecycle: RestingThreadLifecycle },
): CompleteThreadDecision {
  if (lifecycleIsClosed(input.lifecycle)) return { status: "refused", reason: "archived" };
  if (input.executing) return { status: "refused", reason: "executing" };
  if (input.awaitingInput) return { status: "refused", reason: "awaiting-input" };
  return { status: "ok" };
}

export type SnoozeThreadDecision =
  | { readonly status: "ok" }
  | {
      readonly status: "refused";
      readonly reason: "archived" | "awaiting-input" | "wake-time-not-in-future";
    };

/**
 * A running thread may be snoozed — the snooze only affects visibility — but
 * one waiting on the person may not, because hiding the request defeats it.
 * A wake time that is not in the future would create a thread that is asleep
 * and awake at once.
 */
export function decideSnoozeThread(input: {
  readonly lifecycle: RestingThreadLifecycle;
  readonly awaitingInput: boolean;
  readonly until: string;
  readonly now: string;
}): SnoozeThreadDecision {
  if (lifecycleIsClosed(input.lifecycle)) return { status: "refused", reason: "archived" };
  if (input.awaitingInput) return { status: "refused", reason: "awaiting-input" };
  const until = parseInstant(input.until);
  const now = parseInstant(input.now);
  if (until === undefined || now === undefined || until <= now) {
    return { status: "refused", reason: "wake-time-not-in-future" };
  }
  return { status: "ok" };
}

/**
 * Whether the host should archive a completed thread now. `afterDays` of
 * `null` means the person turned the timer off. Only an active, completed
 * thread whose completion is at least that old is due; an unparseable
 * completion time is never due, so bad data cannot archive anything.
 */
export function completedThreadArchiveDue(input: {
  readonly lifecycle: RestingThreadLifecycle;
  readonly completedAt: string | undefined;
  readonly afterDays: number | null;
  readonly now: string;
}): boolean {
  if (input.afterDays === null || input.lifecycle !== "active") return false;
  if (input.completedAt === undefined) return false;
  const completedAt = parseInstant(input.completedAt);
  const now = parseInstant(input.now);
  if (completedAt === undefined || now === undefined) return false;
  return completedAt + input.afterDays * MS_PER_DAY <= now;
}

export type SnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /** The time column beside the label: "Tomorrow" pairs with "9:00 AM". */
  readonly whenLabel: string;
  /** ISO wake time. */
  readonly until: string;
}

const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

function timeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function atHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar days rather than 24-hour spans: a fixed millisecond offset lands on
// the wrong local day across a daylight-saving change.
function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * The wake times a snooze menu offers, in the person's local calendar.
 * "This evening" appears only while it is more than an hour away; "Next week"
 * is dropped when it would be the same morning as "Tomorrow".
 */
export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = new Date(now.getTime() + MS_PER_HOUR);
  const inThreeHours = new Date(now.getTime() + 3 * MS_PER_HOUR);
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: timeOfDayLabel(inAnHour),
      until: inAnHour.toISOString(),
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      whenLabel: timeOfDayLabel(inThreeHours),
      until: inThreeHours.toISOString(),
    },
  ];
  const evening = atHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > MS_PER_HOUR) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: timeOfDayLabel(evening),
      until: evening.toISOString(),
    });
  }
  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: timeOfDayLabel(tomorrow),
    until: tomorrow.toISOString(),
  });
  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addDays(now, daysUntilMonday), MORNING_HOUR);
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    presets.push({
      id: "next-week",
      label: "Next week",
      whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${timeOfDayLabel(nextWeek)}`,
      until: nextWeek.toISOString(),
    });
  }
  return presets;
}

/**
 * How long until the thread wakes, in the coarsest unit that still reads as
 * true: "45m", "3h", "2d". Minutes round up so a hidden thread never reads
 * "0m"; hours and days round to the nearest, so a snooze set for an hour
 * reads "1h" rather than "2h" a minute later. A wake time that already
 * passed reads "now".
 */
export function snoozeWakeLabel(until: string, now: string): string {
  const untilMs = parseInstant(until);
  const nowMs = parseInstant(now);
  if (untilMs === undefined || nowMs === undefined) return "now";
  const remaining = untilMs - nowMs;
  if (remaining <= 0) return "now";
  if (remaining < MS_PER_HOUR) return `${Math.max(1, Math.ceil(remaining / MS_PER_MINUTE))}m`;
  if (remaining < MS_PER_DAY) return `${Math.max(1, Math.round(remaining / MS_PER_HOUR))}h`;
  return `${Math.max(1, Math.round(remaining / MS_PER_DAY))}d`;
}
