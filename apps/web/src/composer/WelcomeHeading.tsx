import { welcomeGreeting } from "@octant/domain";
import { Fragment, useEffect, useRef, useState } from "react";
import { scheduleVisibleInterval } from "../polling/documentVisibility";

export interface WelcomeHeadingProps {
  /** The person's name from their profile; without one the greeting stands alone. */
  readonly greetingName?: string | undefined;
  /** Threads executing now; zero, or absent where the screen has no count, is left out. */
  readonly runningCount?: number | undefined;
  /** Finished threads that wait for the person's review; zero or absent is left out. */
  readonly reviewCount?: number | undefined;
  /** The clock, replaceable so a test can pick the hour. */
  readonly now?: () => Date;
}

const MINUTE_MS = 60_000;

/**
 * The clock, refreshed each minute so a screen left open crosses noon, or
 * midnight, on its own. The state only changes when the hour or the day does,
 * so the heading does not re-render sixty times an hour for nothing.
 */
function useClock(now: () => Date): Date {
  const [clock, setClock] = useState(now);
  // An inline `now` prop is a new function each render; holding it in a ref
  // keeps that from restarting the minute interval.
  const nowRef = useRef(now);
  nowRef.current = now;
  useEffect(() => {
    const tick = () => {
      const next = nowRef.current();
      setClock((current) =>
        current.getHours() === next.getHours() && current.toDateString() === next.toDateString()
          ? current
          : next,
      );
    };
    tick();
    return scheduleVisibleInterval(tick, MINUTE_MS);
  }, []);
  return clock;
}

const systemClock = () => new Date();

/**
 * The line under the greeting: the date in the person's locale, then what is
 * running and what waits for review. A count of zero says nothing, so an idle
 * workspace reads as the date alone.
 */
function statusParts(
  clock: Date,
  runningCount: number | undefined,
  reviewCount: number | undefined,
): ReadonlyArray<string> {
  const parts = [
    new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(
      clock,
    ),
  ];
  if (runningCount !== undefined && runningCount > 0) parts.push(`${String(runningCount)} running`);
  if (reviewCount !== undefined && reviewCount > 0) {
    parts.push(`${String(reviewCount)} waiting for your review`);
  }
  return parts;
}

/**
 * The start screen's hero: only the greeting for the hour, led by the
 * person's name once the profile has one, and one quiet line under it. The
 * question the mode used to ask lives in the composer's placeholder, so the
 * welcome keeps its first-read hierarchy of one greeting and then the
 * composer. Renders into the caller's heading grid.
 */
export function WelcomeHeading(props: WelcomeHeadingProps) {
  const clock = useClock(props.now ?? systemClock);
  const greeting = welcomeGreeting({ hour: clock.getHours(), name: props.greetingName });
  return (
    <Fragment>
      <h1 className="oct-title oct-title--hero">{greeting}</h1>
      <p className="oct-row-detail welcome__status">
        {statusParts(clock, props.runningCount, props.reviewCount).join(" · ")}
      </p>
    </Fragment>
  );
}
