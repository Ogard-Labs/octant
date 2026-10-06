/**
 * "just now", "4m ago", "3h ago", "2d ago": the compact age a board card or
 * an issue row shows beside an item, with the absolute time left to a title.
 */
export function relativeTimeLabel(at: string, now: number = Date.now()): string {
  const elapsedMs = Math.max(0, now - Date.parse(at));
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * How long something has been running: "<1m", "4m", "1h 5m", "2d". The same
 * minute resolution as {@link relativeTimeLabel}, since the screens that show
 * it re-render once a minute.
 */
export function elapsedLabel(since: string, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(since)) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

export const absoluteTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const resetDayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * When a limit frees up, in the terms a person plans around: a countdown
 * inside the day, a weekday and time beyond it. A bare clock time ("resets
 * 20:59") left the reader to work out whether that was today or next week.
 */
export function resetCountdownLabel(resetsAt: string, now: number): string {
  const at = new Date(resetsAt).getTime();
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes <= 0) return "Resets now";
  if (minutes < 60) return `Resets in ${String(minutes)} min`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0
      ? `Resets in ${String(hours)} hr`
      : `Resets in ${String(hours)} hr ${String(rest)} min`;
  }
  return `Resets ${resetDayFormat.format(new Date(at))}`;
}
