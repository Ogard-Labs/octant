/**
 * When a usage limit resets, as the transcript and the strip both name it: a
 * clock time, with the weekday when the reset is a day or more away.
 */
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayClockFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

/** "3:40 PM", or "Tue 3:40 PM" when the reset is a day or more away. */
export function resetClock(resetsAt: string, now: number): string {
  const at = new Date(resetsAt).getTime();
  return (at - now >= 24 * 60 * 60_000 ? dayClockFormat : clockFormat).format(new Date(at));
}
