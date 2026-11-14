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
 * The snooze clock looks again at least this often, so a seed it supplies
 * never lags the real time by more than this (plus scheduling slack).
 */
const SHELL_CLOCK_MAX_LAG_MS = 61 * MINUTE_MS;

/**
 * `seed`, moved forward by the minutes elapsed since it last changed. The
 * shell hands down a clock that moves only on snooze wakes, so a seed can be
 * up to an hour behind when a card mounts; anchoring that reading to the
 * mount-time tick kept the whole offset, and a half-hour-old request read as
 * "just now". A seed that far behind at most is that stale shell reading and
 * is replaced by the real time; a seed outside that window (a pinned time) is
 * kept as given.
 */
export function useMinuteNow(seed: number): number {
  const tick = useMinuteTick().getTime();
  const [anchor, setAnchor] = useState(() => anchorFor(seed, tick));
  if (anchor.seed !== seed) {
    const next = anchorFor(seed, tick);
    setAnchor(next);
    return next.base;
  }
  return anchor.base + (tick - anchor.at);
}

/** Decided once per seed, so the reading never jumps back as time passes. */
function anchorFor(
  seed: number,
  tick: number,
): { readonly seed: number; readonly base: number; readonly at: number } {
  const lag = tick - seed;
  return { seed, base: lag > 0 && lag <= SHELL_CLOCK_MAX_LAG_MS ? tick : seed, at: tick };
}
