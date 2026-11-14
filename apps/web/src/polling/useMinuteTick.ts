import { useEffect, useState } from "react";
import { scheduleVisibleInterval } from "./documentVisibility";

const MINUTE_MS = 60_000;

/**
 * The current time, refreshed once a minute while the document is visible.
 *
 * A snoozed thread wakes when its time passes, with no journal event to say
 * so; the sidebar has to look at the clock itself. A minute is fine-grained
 * enough for a wake time chosen from "in 1 hour" and "tomorrow", and coarse
 * enough that the whole shell re-rendering on it costs nothing a person can
 * see. Hidden documents do not tick; they catch up when they return.
 */
export function useMinuteTick(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => scheduleVisibleInterval(() => setNow(new Date()), MINUTE_MS), []);
  return now;
}

/**
 * `seed` kept current while the component stays mounted: the shell hands down
 * a clock that moves only on snooze wakes, and a relative-time label below it
 * still has to move every minute without re-rendering the shell.
 */
export function useMinuteNow(seed: number): number {
  return Math.max(seed, useMinuteTick().getTime());
}
