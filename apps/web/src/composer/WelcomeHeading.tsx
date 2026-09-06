import { welcomeGreeting } from "@octant/domain";
import { useEffect, useState } from "react";

export interface WelcomeHeadingProps {
  /** The mode's question: the one title the start screen has. */
  readonly question: string;
  /** The person's name from their profile; without one the question stands alone. */
  readonly greetingName?: string | undefined;
  /** The clock, replaceable so a test can pick the hour. */
  readonly now?: () => Date;
}

const MINUTE_MS = 60_000;

/** The hour of the day, refreshed each minute so a screen left open crosses noon on its own. */
function useHour(now: () => Date): number {
  const [hour, setHour] = useState(() => now().getHours());
  useEffect(() => {
    const tick = () => setHour(now().getHours());
    tick();
    const timer = setInterval(tick, MINUTE_MS);
    return () => clearInterval(timer);
  }, [now]);
  return hour;
}

const systemClock = () => new Date();

/**
 * The start screen's hero: the mode's question, led by a greeting for the
 * hour and the person's name once the profile has one. It stays one title,
 * so the welcome keeps its first-read hierarchy of one question and then
 * the composer.
 */
export function WelcomeHeading(props: WelcomeHeadingProps) {
  const hour = useHour(props.now ?? systemClock);
  const name = props.greetingName?.trim();
  const text =
    name === undefined || name.length === 0
      ? props.question
      : `${welcomeGreeting({ hour, name })}. ${props.question}`;
  return <h1 className="oct-title oct-title--hero">{text}</h1>;
}
