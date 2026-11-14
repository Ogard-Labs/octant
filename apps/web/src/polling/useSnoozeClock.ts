import { useEffect, useMemo, useState } from "react";
import { documentIsVisible } from "./documentVisibility";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/**
 * A timer is never trusted past this: a laptop that slept through a wake time
 * resumes with the timeout still pending, so the clock looks again at least
 * this often while the document is visible.
 */
const LONGEST_WAIT_MS = HOUR_MS;

/**
 * Milliseconds until the sidebar would draw something different for these
 * snoozes: a thread waking, its "wakes in" label changing unit or value, or
 * local midnight resetting "done today".
 */
export function msUntilSnoozeClockChanges(wakeTimes: ReadonlyArray<number>, now: Date): number {
  const nowMs = now.getTime();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  let wait = Math.min(nextMidnight - nowMs, LONGEST_WAIT_MS);
  for (const wakeAt of wakeTimes) {
    const remaining = wakeAt - nowMs;
    if (!(remaining > 0)) continue;
    // The label is minutes under an hour, rounded hours under a day, and
    // rounded days beyond; each candidate is the next instant one of those
    // readings changes, and the wake itself.
    const candidates = [remaining];
    if (remaining <= HOUR_MS) candidates.push(remaining % MINUTE_MS);
    else {
      candidates.push(remaining - HOUR_MS);
      if (remaining < DAY_MS) candidates.push((remaining - HOUR_MS / 2) % HOUR_MS);
      else candidates.push(remaining - 23.5 * HOUR_MS, (remaining - DAY_MS / 2) % DAY_MS);
    }
    for (const candidate of candidates) {
      if (candidate > 0 && candidate < wait) wait = candidate;
    }
  }
  return wait;
}

/**
 * The current time, refreshed only when a snoozed thread wakes, its wake label
 * would read differently, or the day turns over. A snooze passing raises no
 * journal event, so the shell must look at the clock itself; looking at it on
 * those instants, rather than every minute, keeps the whole shell from
 * re-rendering on a timer when nothing it draws has changed.
 */
export function useSnoozeClock(snoozeUntil: ReadonlyArray<string>): Date {
  const [now, setNow] = useState(() => new Date());
  const key = snoozeUntil.join("|");
  // A snooze added, changed or already past when navigation delivers it is
  // read against the clock now, not against the last scheduled tick, which can
  // be up to an hour old.
  const [readFor, setReadFor] = useState(key);
  if (readFor !== key) {
    setReadFor(key);
    setNow(new Date());
  }
  const wakeTimes = useMemo(
    () => (key === "" ? [] : key.split("|").map((until) => Date.parse(until))),
    [key],
  );
  useEffect(() => {
    if (!documentIsVisible()) return;
    const timer = setTimeout(
      () => setNow(new Date()),
      msUntilSnoozeClockChanges(wakeTimes, new Date()) + 5,
    );
    return () => clearTimeout(timer);
  }, [now, wakeTimes]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    // Hidden documents hold no timer; coming back catches up at once.
    const visible = () => {
      if (documentIsVisible()) setNow(new Date());
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);
  return now;
}
